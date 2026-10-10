import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { requireTenantCapability } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';
import { validate } from '../middleware/validate';
import { probeLimiter } from '../middleware/rateLimiter';
import { requireProbeAuth } from '../middleware/probeAuth';
import {
  approveProbeSchema,
  createProbeApiKeySchema,
  probeBulkSchema,
  type ProbeBulkInput,
  probeCreateSitesSchema,
  type ProbeCreateSitesInput,
  probeCommandSchema,
  updateProbeApiKeySchema,
  updateProbeSchema,
} from '../validators/probe.schema';
import {
  probeController,
  probeVersion,
  probeDownload,
  probeInstallerLinux,
  probeInstallerMacos,
  probeInstallerFreebsd,
  probeInstallerWindowsMsi,
  probeNotifyingUpdate,
} from '../controllers/probe.controller';
import { db } from '../db';
import { permissionService } from '../services/permission.service';
import { requireAction, requireActionFrom } from '../middleware/stepUp';
import { toDbId } from '../utils/dbId';

const router = Router();

// GET /version and /download: the probe sends no credentials there, so
// probeLimiter's identity buckets do not apply. A fleet behind one NAT (or an
// edge proxy missing from TRUSTED_PROXIES) fetches the same release within
// minutes: a generous per-address budget that only bounds abuse.
const probeUpdateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
  keyGenerator: (req: Request) => `probe-update:${(req.ip ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '') || 'unknown'}`,
});

// ── Public routes (no session auth required) ─────────────────────────────────
// apiLimiter skips push / check-results / version / download: probeLimiter bounds the POSTs
// per probe identity (and per address for rejected credentials),
// probeUpdateLimiter the update GETs per address.

// Probe push — API key + UUID (+ identity token), authenticated in the service
router.post('/push', probeLimiter, probeController.push);

// Device Checks results of a probe in HTTP mode — approved probes on a site only
router.post(
  '/check-results',
  probeLimiter,
  requireProbeAuth({ requireApproved: true, requireSite: true }),
  probeController.checkResults,
);

// Pre-update notification — probe calls this before self-updating
router.post('/notifying-update', probeLimiter, requireProbeAuth({ requireApproved: false }), probeNotifyingUpdate);

// Auto-update endpoints
router.get('/version', probeUpdateLimiter, probeVersion);
router.get('/download/:filename', probeUpdateLimiter, probeDownload);

// Installer scripts (with API key injected server-side)
router.get('/installer/linux', probeInstallerLinux);
router.get('/installer/macos', probeInstallerMacos);
router.get('/installer/freebsd', probeInstallerFreebsd);

// Pre-built Windows MSI (static, SERVERURL + APIKEY passed via msiexec properties)
router.get('/installer/windows.msi', probeInstallerWindowsMsi);

// ── Tenant-scoped admin endpoints — session + tenant + probe capability ─────
// Tenant capabilities, per route: reading the
// probes takes 'probes.read', approving them (approve / refuse / suspend /
// unsuspend, and those bulk actions) 'probes.approve', everything else (API
// keys, commands, settings, delete, identity token, install info)
// 'probes.manage'. probes.manage implies the two others and probes.approve
// implies probes.read (shared CAPABILITY_IMPLIES, resolved by
// permissionService), so sets saved before the split keep exactly their
// rights. Platform admins and tenant admins hold every capability. Probes and
// API keys are tenant-wide (every query is filtered on req.tenantId).
router.use(requireAuth);
router.use(requireTenant);

const canRead = requireTenantCapability('probes.read');
const canApprove = requireTenantCapability('probes.approve');
const canManage = requireTenantCapability('probes.manage');

/** Bulk actions approving / suspending need probes.approve; delete and uninstall probes.manage. */
const BULK_APPROVAL_ACTIONS: ReadonlySet<ProbeBulkInput['action']> = new Set(['approve', 'suspend', 'unsuspend']);
function bulkGate(req: Request, res: Response, next: NextFunction): void {
  const { action } = req.body as ProbeBulkInput;
  (BULK_APPROVAL_ACTIONS.has(action) ? canApprove : canManage)(req, res, next);
}

// 2FA step-up for the actions a tenant marks sensitive (middleware/stepUp.ts),
// after the capability gates and the body validation: uninstall commands
// (single and bulk), probe deletion (single and bulk), API key create / delete.
const stepUpBulk = requireActionFrom((req) => {
  const { action } = req.body as ProbeBulkInput;
  if (action === 'uninstall') return 'probe.command.uninstall';
  if (action === 'delete') return 'probe.delete';
  return null;
});
const stepUpCommand = requireActionFrom((req) =>
  (req.body as { command?: unknown }).command === 'uninstall' ? 'probe.command.uninstall' : null);

/**
 * Sites an approval attaches the probes to (probeService.approvalSite): the
 * requested site, else — for a probe without a site of the tenant — its API
 * key's default site. A probe that keeps its site attaches nothing new.
 */
async function approvalTargetSiteIds(tenantId: number, probeIds: number[], requested: number | undefined): Promise<number[]> {
  if (requested !== undefined) return [requested];
  const rows = await db('probes as p')
    .leftJoin('sites as s', function () {
      this.on('s.id', '=', 'p.site_id').andOn('s.tenant_id', '=', 'p.tenant_id');
    })
    .where('p.tenant_id', tenantId)
    .whereIn('p.id', probeIds)
    .select('p.api_key_id', 's.id as current_site_id') as Array<{ api_key_id: unknown; current_site_id: unknown }>;
  const keyIds = [...new Set(rows
    .filter((r) => toDbId(r.current_site_id) === null)
    .map((r) => toDbId(r.api_key_id))
    .filter((id): id is number => id !== null))];
  if (keyIds.length === 0 || !(await db.schema.hasColumn('probe_api_keys', 'default_site_id'))) return [];
  const keys = await db('probe_api_keys as k')
    .join('sites as s', function () {
      this.on('s.id', '=', 'k.default_site_id').andOn('s.tenant_id', '=', 'k.tenant_id');
    })
    .where('k.tenant_id', tenantId)
    .whereIn('k.id', keyIds)
    .select('s.id as site_id') as Array<{ site_id: unknown }>;
  return [...new Set(keys.map((k) => toDbId(k.site_id)).filter((id): id is number => id !== null))];
}

/**
 * Approving attaches a probe to a site: its devices feed that site and it may
 * run the site's device checks (with their credentials). probes.manage holders
 * stay tenant-wide, as before the split; a probes.approve-only holder also
 * needs team write on every site the approval attaches to (403
 * 'site_write_required').
 */
async function requireApprovalSiteWrite(req: Request, probeIds: number[], requested: number | undefined): Promise<void> {
  if (req.session.role === 'admin') return;
  const userId = toDbId(req.session.userId);
  const tenantId = toDbId(req.tenantId);
  if (userId === null || tenantId === null) throw new AppError(403, 'forbidden');
  if (await permissionService.userHasTenantCapability(userId, tenantId, 'probes.manage')) return;
  for (const siteId of await approvalTargetSiteIds(tenantId, probeIds, requested)) {
    if (!(await permissionService.canWriteSite(userId, siteId, tenantId, false))) {
      throw new AppError(403, 'site_write_required');
    }
  }
}

function approveSiteGate(req: Request, _res: Response, next: NextFunction): void {
  const id = toDbId(req.params.id);
  if (id === null) return next(); // the controller answers the invalid id
  const { siteId } = (req.body ?? {}) as { siteId?: number };
  requireApprovalSiteWrite(req, [id], siteId).then(() => next(), next);
}

function bulkApproveSiteGate(req: Request, _res: Response, next: NextFunction): void {
  const { action, ids } = req.body as ProbeBulkInput;
  if (action !== 'approve') return next();
  requireApprovalSiteWrite(req, ids, undefined).then(() => next(), next);
}

// Add-probe modal: server URL the installers use (no secret)
router.get('/install-info', canManage, probeController.installInfo);

// API Keys
router.get('/keys', canManage, probeController.listKeys);
router.post('/keys', canManage, validate(createProbeApiKeySchema), requireAction('probe.key_create'), probeController.createKey);
router.patch('/keys/:id', canManage, validate(updateProbeApiKeySchema), probeController.updateKey);
router.delete('/keys/:id', canManage, requireAction('probe.key_delete'), probeController.deleteKey);

// Probes list + bulk (the gate depends on the validated action)
router.get('/devices', canRead, probeController.list);
/**
 * Target group of "Create sites from probes": same rule as POST /sites —
 * without full access, a group the user can write to is required.
 */
async function createSitesGroupGate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.session.userId!;
    const isPlatformAdmin = req.session.role === 'admin';
    if (await permissionService.isFullAccess(userId, req.tenantId, isPlatformAdmin)) return next();
    const { groupId } = req.body as ProbeCreateSitesInput;
    if (groupId == null) return next(new AppError(403, 'Choose a group you can write to for the new sites'));
    if (!(await permissionService.findGroup(groupId, req.tenantId))) return next(new AppError(400, 'Group not found'));
    if (!(await permissionService.canWriteGroup(userId, groupId, req.tenantId, isPlatformAdmin))) {
      return next(new AppError(403, 'No write permission on the target group'));
    }
    next();
  } catch (err) {
    next(err);
  }
}
router.post('/devices/create-sites', canManage, requireTenantCapability('sites.manage'),
  validate(probeCreateSitesSchema), createSitesGroupGate, probeController.createSites);
router.post('/devices/bulk', canApprove, validate(probeBulkSchema), bulkGate, bulkApproveSiteGate, stepUpBulk, probeController.bulk);

// Single probe operations
router.get('/devices/:id', canRead, probeController.get);
router.get('/devices/:id/effective-config', canRead, probeController.getEffectiveConfig);
router.patch('/devices/:id', canManage, validate(updateProbeSchema), probeController.update);
router.delete('/devices/:id', canManage, requireAction('probe.delete'), probeController.remove);
router.post('/devices/:id/approve', canApprove, validate(approveProbeSchema), approveSiteGate, probeController.approve);
router.post('/devices/:id/refuse', canApprove, probeController.refuse);
router.post('/devices/:id/suspend', canApprove, probeController.suspend);
router.post('/devices/:id/unsuspend', canApprove, probeController.unsuspend);
router.post('/devices/:id/command', canManage, validate(probeCommandSchema), stepUpCommand, probeController.sendCommand);
router.delete('/devices/:id/command', canManage, probeController.cancelCommand);
router.post('/devices/:id/reset-token', canManage, probeController.resetToken);

export default router;
