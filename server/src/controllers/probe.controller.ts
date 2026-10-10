import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { probeService } from '../services/probe.service';
import { probeIdentityService, IDENTITY_HEADER_ACK } from '../services/probeIdentity.service';
import { auditService } from '../services/audit.service';
import { ingest as ingestCheckResults } from '../services/deviceChecks/ingest.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { clientIp } from '../utils/clientIp';
import { requireDbId } from '../utils/dbId';
import type {
  ApproveProbeInput,
  CreateProbeApiKeyInput,
  ProbeBulkInput,
  ProbeCommand,
  ProbeCreateSitesInput,
  UpdateProbeApiKeyInput,
  UpdateProbeInput,
} from '../validators/probe.schema';
import { emitSiteUpdated, emitTreeChanged } from '../services/realtime.service';

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

// ── Public: version + download + installer + notifying-update ────────────────

export function probeVersion(_req: Request, res: Response): void {
  try {
    const info = probeService.getProbeVersion();
    res.json(info);
  } catch {
    res.status(503).json({ error: 'Probe version info unavailable' });
  }
}

const ALLOWED_PROBE_BINARIES: Record<string, string> = {
  'oblimap-probe.msi':          'oblimap-probe.msi',
  'oblimap-probe.exe':          'oblimap-probe.exe',
  'oblimap-probe-linux-amd64':  'oblimap-probe-linux-amd64',
  'oblimap-probe-linux-arm64':  'oblimap-probe-linux-arm64',
  'oblimap-probe-linux-arm':    'oblimap-probe-linux-arm',
  // MikroTik RouterOS container images (docker-archive, probe/build-container.sh)
  'oblimap-probe-container-amd64.tar': 'oblimap-probe-container-amd64.tar',
  'oblimap-probe-container-arm64.tar': 'oblimap-probe-container-arm64.tar',
  'oblimap-probe-container-arm.tar':   'oblimap-probe-container-arm.tar',
  'oblimap-probe-darwin-amd64': 'oblimap-probe-darwin-amd64',
  'oblimap-probe-darwin-arm64': 'oblimap-probe-darwin-arm64',
  'oblimap-probe-freebsd-amd64': 'oblimap-probe-freebsd-amd64',
};

// SHA-256 of the served probe binaries / MSI, sent as X-Content-SHA256 so the
// probe verifies an update before running it (probe/download.go). Cached per
// file and invalidated when its size or mtime changes (a release replaces
// the files in probe/dist while the server runs).
const sha256Cache = new Map<string, { size: number; mtimeMs: number; hash: Promise<string> }>();

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => h.update(chunk))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Stats a probe artifact and returns its SHA-256 (hex), or null when the file is missing. */
async function artifactSha256(filePath: string): Promise<string | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const cached = sha256Cache.get(filePath);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.hash;
  const hash = hashFile(filePath);
  sha256Cache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, hash });
  hash.catch(() => {
    if (sha256Cache.get(filePath)?.hash === hash) sha256Cache.delete(filePath);
  });
  return hash;
}

/** Sends a probe artifact with its X-Content-SHA256 header. */
async function sendProbeArtifact(res: Response, filePath: string, filename: string, contentType: string, missing: string): Promise<void> {
  const sha256 = await artifactSha256(filePath);
  if (!sha256) {
    res.status(404).json({ error: missing });
    return;
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-SHA256', sha256);
  res.sendFile(filePath);
}

export async function probeDownload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { filename } = req.params;
    const binaryName = Object.prototype.hasOwnProperty.call(ALLOWED_PROBE_BINARIES, filename)
      ? ALLOWED_PROBE_BINARIES[filename]
      : undefined;
    if (!binaryName) { res.status(404).json({ error: 'Not found' }); return; }
    const filePath = path.resolve(__dirname, '../../../../probe/dist', binaryName);
    await sendProbeArtifact(res, filePath, binaryName, 'application/octet-stream', 'Probe binary not available');
  } catch (err) {
    next(err);
  }
}

// ── Installer scripts ────────────────────────────────────────────────────────
// The scripts are piped to `sudo bash`: every substituted value is checked
// here and lands in a single-quoted shell literal (probe/installer/*.sh).

const API_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same character allow-list as the installers' own check of SERVER_URL
// (no quote, backslash, `$`, backtick, space or control character).
const SERVER_URL_RE = /^https?:\/\/[A-Za-z0-9._~:/?#@%+=,;&[\]-]+$/;

let hostFallbackWarned = false;

/** localhost, *.localhost, 127.0.0.0/8, ::1 (URL.hostname form: IPv6 in brackets). */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // ::1, and IPv4-mapped 127.x as URL normalises it (::ffff:7f00:1).
  return h === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h);
}

function configuredOrigin(): string | null {
  if (!config.publicUrlConfigured) return null;
  try {
    const url = new URL(config.appUrl.trim());
    // A loopback public URL (e.g. http://localhost:3002) would point every remote
    // probe at itself: ignored, the request Host is used instead.
    if (isLoopbackHostname(url.hostname)) return null;
    return SERVER_URL_RE.test(url.origin) ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Base URL written into installer scripts: the origin of the public URL
 * (APP_URL, else CLIENT_ORIGIN — config.appUrl). Without a usable one (existing deployments that never set it, or a loopback one)
 * the request's protocol + Host is used as before — a link cannot choose the
 * Host header (the client sets it from the URL), the answer is never cached,
 * and the value is allow-listed. Returns null when no usable URL exists.
 */
function installerServerUrl(req: Request): string | null {
  const configured = configuredOrigin();
  if (configured) return configured;
  if (!hostFallbackWarned) {
    hostFallbackWarned = true;
    logger.warn('No public URL (APP_URL / CLIENT_ORIGIN) set, not a valid http(s) URL, or a loopback address (localhost): probe installers use the request Host header as server URL. Set CLIENT_ORIGIN to the public URL of Oblimap.');
  }
  const url = `${req.protocol}://${req.get('host') ?? ''}`;
  return SERVER_URL_RE.test(url) ? url : null;
}

/**
 * ?key= → the canonical key when it is a UUID that exists in probe_api_keys;
 * null when absent (the script then requires --key); false when invalid or
 * unknown (404, nothing served).
 */
async function installerApiKey(req: Request): Promise<string | null | false> {
  const raw = req.query.key;
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !API_KEY_RE.test(raw)) return false;
  const key = raw.toLowerCase();
  const row = await db('probe_api_keys').where({ key }).first('id');
  return row ? key : false;
}

async function serveInstaller(req: Request, res: Response, script: string, filename: string, unavailable: string): Promise<void> {
  const apiKey = await installerApiKey(req);
  if (apiKey === false) { res.status(404).json({ error: 'Not found' }); return; }

  const scriptPath = path.resolve(__dirname, '../../../../probe/installer', script);
  let content: string;
  try {
    content = (await fs.promises.readFile(scriptPath, 'utf-8')).replace(/\r\n/g, '\n');
  } catch {
    res.status(404).json({ error: unavailable });
    return;
  }

  const serverUrl = installerServerUrl(req);
  if (!serverUrl) {
    logger.warn({ script }, 'Probe installer refused: no server URL that can be written into the script (set CLIENT_ORIGIN)');
    res.status(503).json({ error: 'Installer unavailable: invalid server URL (check CLIENT_ORIGIN / APP_URL)' });
    return;
  }

  // Replacer functions: a string replacement would interpret `$&`-style patterns.
  content = content.replace('__SERVER_URL__', () => serverUrl);
  if (apiKey) content = content.replace('__API_KEY__', () => apiKey);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Carries an API key: never stored by a shared cache.
  res.setHeader('Cache-Control', 'no-store');
  res.send(content);
}

export async function probeInstallerLinux(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await serveInstaller(req, res, 'install.sh', 'install.sh', 'Installer not available');
  } catch (err) {
    next(err);
  }
}

export async function probeInstallerMacos(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await serveInstaller(req, res, 'install-macos.sh', 'install-macos.sh', 'macOS installer not available');
  } catch (err) {
    next(err);
  }
}

export async function probeInstallerFreebsd(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await serveInstaller(req, res, 'install-freebsd.sh', 'install-freebsd.sh', 'FreeBSD installer not available');
  } catch (err) {
    next(err);
  }
}

export async function probeInstallerWindowsMsi(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const msiPath = path.resolve(__dirname, '../../../../probe/dist/oblimap-probe.msi');
    await sendProbeArtifact(res, msiPath, 'oblimap-probe.msi', 'application/x-msi', 'MSI installer not available (not yet built)');
  } catch (err) {
    next(err);
  }
}

/** POST /notifying-update — behind requireProbeAuth: req.probe is the authenticated probe. */
export async function probeNotifyingUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const probe = req.probe;
    if (!probe) { res.status(404).json({ error: 'probe_not_registered' }); return; }
    await probeService.setProbeUpdating(probe.tenant_id, probe.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export const probeController = {
  // ── Probe Push (API-key auth, no session required) ────────────────────────

  async push(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const apiKey = header(req, 'x-api-key');
      const probeUuid = header(req, 'x-probe-uuid');

      if (!apiKey || !probeUuid) {
        // `config: false`: see ProbePushFailure in probe.service.ts.
        res
          .status(400)
          .json({ status: 'invalid', error: 'Missing X-API-Key or X-Probe-UUID header', config: false });
        return;
      }

      const result = await probeService.handlePush(apiKey, probeUuid, req.body, undefined, {
        probeToken: header(req, 'x-probe-token'),
        features: header(req, 'x-probe-features'),
        ip: clientIp(req) || null,
        // Identity v2: X-Obli-Device-Id / X-Obli-Previous-Ids (null for a v1 probe).
        identity: probeIdentityService.parseHeaders(req.headers),
      });
      const { httpStatus, ...rest } = result;
      let body: Record<string, unknown> = rest;
      if ('identityAck' in rest && rest.identityAck) {
        // The probe switches to the shared device ID on this header only.
        res.setHeader(IDENTITY_HEADER_ACK, rest.identityAck);
        const { identityAck: _ack, ...withoutAck } = rest;
        body = withoutAck;
      }
      res.status(httpStatus).json(body);
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /check-results — Device Checks results of a probe in HTTP mode
   * (ProbeCheckResultsBatch). Behind requireProbeAuth (approved, on a site):
   * the identity is the authenticated probe's, never the payload's. A
   * malformed batch is a 400 (AppError from ingest).
   */
  async checkResults(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const probe = req.probe;
      if (!probe) { res.status(404).json({ error: 'probe_not_registered' }); return; }
      const result = await ingestCheckResults({ probeId: probe.id, tenantId: probe.tenant_id }, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /install-info — the server URL the installers write into their
   * scripts (installerServerUrl: APP_URL when set and not loopback, else the
   * request's protocol + Host), so the Add-probe modal shows the same URL.
   * No secret is returned; null when no usable URL exists.
   */
  installInfo(req: Request, res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ serverUrl: installerServerUrl(req) });
  },

  // ── API Keys ──────────────────────────────────────────────────────────────

  async listKeys(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const keys = await probeService.getApiKeys(req.tenantId);
      res.json({ keys });
    } catch (err) {
      next(err);
    }
  },

  async createKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, defaultSiteId } = req.body as CreateProbeApiKeyInput;
      const key = await probeService.createApiKey(
        req.tenantId,
        name,
        req.session.userId!,
        defaultSiteId ?? null,
      );
      void auditService.logReq(req, {
        action: 'probe.api_key_created',
        resourceType: 'probe_api_key',
        resourceId: key.id,
        details: { name: key.name, keyId: key.id, defaultSiteId: key.defaultSiteId ?? null },
      });
      res.status(201).json({ key });
    } catch (err) {
      next(err);
    }
  },

  /** PATCH /keys/:id — rename and / or set the default site (a site of the tenant). */
  async updateKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const keyId = requireDbId(req.params.id, 'key id');
      const body = req.body as UpdateProbeApiKeyInput;
      const result = await probeService.updateApiKey(req.tenantId, keyId, body);
      if (!result) throw new AppError(404, 'API key not found');
      void auditService.logReq(req, {
        action: 'probe.key_updated',
        resourceType: 'probe_api_key',
        resourceId: keyId,
        details: {
          keyId,
          fields: Object.keys(body),
          ...(body.name !== undefined ? { name: result.key.name, previousName: result.previous.name } : {}),
          ...(body.defaultSiteId !== undefined
            ? { defaultSiteId: result.key.defaultSiteId ?? null, previousDefaultSiteId: result.previous.defaultSiteId }
            : {}),
        },
      });
      res.json({ key: result.key });
    } catch (err) {
      next(err);
    }
  },

  async deleteKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const keyId = requireDbId(req.params.id, 'key id');
      const deleted = await probeService.deleteApiKey(req.tenantId, keyId);
      if (!deleted) throw new AppError(404, 'API key not found');
      void auditService.logReq(req, {
        action: 'probe.api_key_deleted',
        resourceType: 'probe_api_key',
        resourceId: keyId,
        details: { name: deleted.name, keyId, disconnectedProbes: deleted.disconnected },
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },

  // ── Probe CRUD ────────────────────────────────────────────────────────────

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const probes = await probeService.getProbes(req.tenantId);
      res.json({ probes });
    } catch (err) {
      next(err);
    }
  },

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const probe = await probeService.getProbe(req.tenantId, requireDbId(req.params.id, 'probe id'));
      if (!probe) throw new AppError(404, 'Probe not found');
      res.json({ probe });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'probe id');
      const body = req.body as UpdateProbeInput;
      const probe = await probeService.updateProbe(req.tenantId, id, body);
      if (!probe) throw new AppError(404, 'Probe not found');
      void auditService.logReq(req, {
        probeId: id,
        action: 'probe.updated',
        resourceType: 'probe',
        resourceId: id,
        details: {
          fields: Object.keys(body),
          ...(body.siteId !== undefined ? { siteId: body.siteId } : {}),
          ...(body.isPrimary !== undefined ? { isPrimary: body.isPrimary } : {}),
          ...(body.scanConfigOverride !== undefined ? { scanConfigOverride: body.scanConfigOverride } : {}),
        },
      });
      res.json({ probe });
    } catch (err) {
      next(err);
    }
  },

  async approve(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'probe id');
      const { siteId } = (req.body ?? {}) as ApproveProbeInput;
      const probe = await probeService.approveProbe(req.tenantId, id, req.session.userId!, siteId);
      if (!probe) throw new AppError(404, 'Probe not found');
      void auditService.logReq(req, {
        probeId: id,
        action: 'probe.approved',
        resourceType: 'probe',
        resourceId: id,
        details: {
          uuid: probe.uuid,
          hostname: probe.hostname,
          siteId: probe.siteId,
          ...(siteId !== undefined ? { requestedSiteId: siteId } : {}),
        },
      });
      res.json({ probe });
    } catch (err) {
      next(err);
    }
  },

  async refuse(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'probe id');
      const refused = await probeService.refuseProbe(req.tenantId, id);
      if (!refused) throw new AppError(404, 'Probe not found');
      void auditService.logReq(req, {
        probeId: id,
        action: 'probe.refused',
        resourceType: 'probe',
        resourceId: id,
        details: { uuid: refused.uuid, hostname: refused.hostname },
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },

  async sendCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'probe id');
      const { command } = req.body as { command: ProbeCommand };
      const result = await probeService.sendCommand(req.tenantId, id, command);
      if (!result) throw new AppError(404, 'Probe not found');
      if (result === 'not_approved') {
        // Refused / suspended probes are refused at every contact: the command could never reach them.
        res.status(409).json({ error: 'probe_not_approved' });
        return;
      }
      void auditService.logReq(req, {
        probeId: id,
        action: 'probe.command',
        resourceType: 'probe',
        resourceId: id,
        details: { command, delivered: result.delivered },
      });
      // delivered: sent over the WebSocket now; false: queued until the probe's next push (HTTP mode).
      res.json({ delivered: result.delivered });
    } catch (err) {
      next(err);
    }
  },

  /** DELETE /devices/:id/command — cancels a queued command (and a pending uninstall). */
  async cancelCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'probe id');
      const result = await probeService.cancelCommand(req.tenantId, id);
      if (!result) throw new AppError(404, 'Probe not found');
      if (result.cancelled !== null || result.uninstallCleared) {
        void auditService.logReq(req, {
          probeId: id,
          action: 'probe.command_cancelled',
          resourceType: 'probe',
          resourceId: id,
          details: { command: result.cancelled, uninstallCleared: result.uninstallCleared },
        });
      }
      res.json({ cancelled: result.cancelled, uninstallCleared: result.uninstallCleared });
    } catch (err) {
      next(err);
    }
  },

  /** POST /devices/:id/suspend — an approved probe is refused at its next contact; site and config kept. */
  async suspend(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'probe id');
      const result = await probeService.suspendProbe(req.tenantId, id);
      if (!result) throw new AppError(404, 'Probe not found');
      if (result === 'not_approved') {
        res.status(409).json({ error: 'probe_not_approved' });
        return;
      }
      void auditService.logReq(req, {
        probeId: id,
        action: 'probe.suspended',
        resourceType: 'probe',
        resourceId: id,
        details: { uuid: result.uuid, hostname: result.hostname },
      });
      const probe = await probeService.getProbe(req.tenantId, id);
      res.json({ probe });
    } catch (err) {
      next(err);
    }
  },

  /** POST /devices/:id/unsuspend — a suspended probe is approved again. */
  async unsuspend(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'probe id');
      const result = await probeService.unsuspendProbe(req.tenantId, id);
      if (!result) throw new AppError(404, 'Probe not found');
      if (result === 'not_suspended') {
        res.status(409).json({ error: 'probe_not_suspended' });
        return;
      }
      void auditService.logReq(req, {
        probeId: id,
        action: 'probe.unsuspended',
        resourceType: 'probe',
        resourceId: id,
        details: { uuid: result.uuid, hostname: result.hostname },
      });
      const probe = await probeService.getProbe(req.tenantId, id);
      res.json({ probe });
    } catch (err) {
      next(err);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'probe id');
      const deleted = await probeService.deleteProbe(req.tenantId, id);
      if (!deleted) throw new AppError(404, 'Probe not found');
      void auditService.logReq(req, {
        // probe_id stays null: the row is gone (FK).
        action: 'probe.deleted',
        resourceType: 'probe',
        resourceId: id,
        details: { uuid: deleted.uuid, hostname: deleted.hostname },
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },

  /** POST /devices/:id/reset-token — the probe gets a new identity token on its next contact. */
  async resetToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'probe id');
      const reset = await probeService.resetIdentityToken(req.tenantId, id);
      if (!reset) throw new AppError(404, 'Probe not found');
      void auditService.logReq(req, {
        probeId: id,
        action: 'probe.token_reset',
        resourceType: 'probe',
        resourceId: id,
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },

  // ── Effective Config ─────────────────────────────────────────────────────

  /**
   * data: the settings chain resolved for the probe (probe-level settings
   * panel; unchanged shape). effective: the scan config exactly as the probe
   * receives it, the source of each value ('probe' while the probe overrides
   * the settings chain), and a Device Checks summary.
   */
  async getEffectiveConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const described = await probeService.describeEffectiveConfig(req.tenantId, requireDbId(req.params.id, 'probe id'));
      if (!described) throw new AppError(404, 'Probe not found');
      const { resolved, ...effective } = described;
      res.json({ success: true, data: resolved, effective });
    } catch (err) {
      next(err);
    }
  },

  // ── Bulk ──────────────────────────────────────────────────────────────────

  /** POST /devices/create-sites — one site per name, probes attached (primary + secondaries). */
  async createSites(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const input = req.body as ProbeCreateSitesInput;
      const result = await probeService.createSitesFromProbes(req.tenantId, req.session.userId!, input);
      for (const s of result.sites) {
        if (s.created) {
          void auditService.logReq(req, {
            action: 'site.created',
            resourceType: 'site',
            resourceId: s.siteId,
            details: { name: s.name, groupId: input.groupId, fromProbes: s.probeIds },
          });
        }
        emitSiteUpdated(req.tenantId, s.siteId);
      }
      void auditService.logReq(req, {
        action: 'probe.sites_created',
        resourceType: 'probe',
        details: {
          sites: result.sites.map((s) => ({ siteId: s.siteId, name: s.name, created: s.created, probeIds: s.probeIds })),
        },
      });
      emitTreeChanged(req.tenantId);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },

  async bulk(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { action, ids } = req.body as ProbeBulkInput;
      let affected: number[];
      switch (action) {
        case 'approve':
          affected = await probeService.bulkApprove(req.tenantId, ids, req.session.userId!);
          break;
        case 'delete':
          affected = await probeService.bulkDelete(req.tenantId, ids);
          break;
        case 'uninstall':
          affected = await probeService.bulkCommand(req.tenantId, ids, 'uninstall');
          break;
        case 'suspend':
          affected = await probeService.bulkSuspend(req.tenantId, ids);
          break;
        case 'unsuspend':
          affected = await probeService.bulkUnsuspend(req.tenantId, ids);
          break;
        default:
          throw new AppError(400, 'Unknown bulk action');
      }
      // Ids not acted on: not in the tenant, or in a state the action skips
      // (approve: already approved / suspended; uninstall: refused / suspended…).
      const skipped = new Set(ids).size - affected.length;
      void auditService.logReq(req, {
        action: 'probe.bulk',
        resourceType: 'probe',
        details: { action, count: affected.length, ids: affected, skipped },
      });
      res.json({
        action,
        affectedIds: affected,
        skipped,
        ...(action === 'approve' ? { approvedIds: affected } : {}),
      });
    } catch (err) {
      next(err);
    }
  },
};
