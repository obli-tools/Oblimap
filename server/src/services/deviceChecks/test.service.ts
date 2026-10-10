import crypto from 'crypto';
import type { DeviceCheckSpec, DeviceCheckTestResponse, ProbeCheckTarget } from '@oblimap/shared';
import { PROBE_WS_MESSAGES } from '@oblimap/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';
import { appConfigService } from '../appConfig.service';
import {
  cancelProbeReply,
  isProbeConnected,
  ProbeReplyError,
  sendToProbe,
  waitForProbeReply,
} from '../probeHub.service';
import { probeCheckResultSchema, specUsesBasicAuth, type TestInput } from '../../validators/deviceCheck.schema';
import { normalizeMacAddress } from '../../validators/probe.schema';
import {
  buildWireRule,
  loadSiteProbes,
  resolveStoredCredentials,
  rowToRuleRecord,
  scopeSiteIds,
  secretsTransportAllowed,
} from './config.service';
import { isTargetableAddress, matchesItem, selectExecutorProbe, type ExecutorCandidate } from './match';
import { coerceValues, computeStatus, evaluateAssertions } from './eval';
import { permissionService } from '../permission.service';
import { assertAuthoringScope, specPolicyIssues, DeviceCheckValidationError, type DeviceCheckViewer } from './rule.service';

// "Test" and "Run now": both need a probe connected by
// WebSocket that advertises the Device Checks capability (409
// probe_not_connected / probe_unsupported otherwise — a probe in HTTP mode
// only learns about requests at its next push).
//
// A test runs a spec (possibly unsaved) once against one device, through the
// same probe-side binding and limits as scheduled runs, with the trace on and
// a redacted body snippet (never stored). The probe answers within 18 s; the
// server waits 20 s. Inline test credentials are sent for this run only and
// are never stored; a rule's stored credentials only reach a device the saved
// rule targets, with its scheme, port and TLS verification.

/** How long the server waits for check_test_result (the probe answers within 18 s). */
export const CHECK_TEST_TIMEOUT_MS = 20_000;

interface ItemRow {
  id: number;
  site_id: number;
  ip: string;
  mac: string | null;
  vendor: string | null;
  device_type: string | null;
  discovered_by_probe_id: number | null;
}

/** 404 (like a missing device) unless the viewer may read the device's site. */
async function assertItemReadable(tenantId: number, viewer: DeviceCheckViewer, item: ItemRow): Promise<void> {
  if (!(await permissionService.canReadSite(viewer.userId, Number(item.site_id), tenantId, viewer.isPlatformAdmin))) {
    throw new AppError(404, 'Device not found');
  }
}

async function loadItem(tenantId: number, itemId: number): Promise<ItemRow> {
  const item = await db('site_items')
    .where({ id: itemId, tenant_id: tenantId })
    .first('id', 'site_id', 'ip', 'mac', 'vendor', 'device_type', 'discovered_by_probe_id') as ItemRow | undefined;
  if (!item) throw new AppError(404, 'Device not found');
  return item;
}

/**
 * Stored credentials only go where the saved rule would send them (they are
 * write-only: a test must not become a way to hand them to another device or
 * over a weaker transport). The device must be inside the saved rule's scope
 * and matched by its saved match (MAC required, as for every Basic-auth
 * rule), and every Basic-auth variant of the tested spec must keep the
 * scheme, port and TLS verification of a Basic-auth variant of the saved
 * rule. 400 otherwise.
 */
async function assertStoredCredentialsUsable(
  tenantId: number,
  ruleRow: Record<string, unknown>,
  item: ItemRow,
  spec: DeviceCheckSpec,
): Promise<void> {
  const saved = rowToRuleRecord(ruleRow);
  if (!saved) throw new AppError(400, 'The saved rule spec is no longer valid: stored credentials cannot be used');
  const sites = await scopeSiteIds(tenantId, { groupId: saved.groupId, siteId: saved.siteId });
  const savedMatch = { ...saved.spec.match, requireMac: true };
  const inScope = sites === 'all' || sites.includes(Number(item.site_id));
  if (!inScope || !matchesItem(savedMatch, {
    id: Number(item.id),
    ip: item.ip,
    mac: item.mac,
    vendor: item.vendor,
    device_type: item.device_type ?? 'unknown',
  })) {
    throw new AppError(400, 'Stored credentials can only be tested on a device targeted by the saved rule');
  }
  const savedBasic = saved.spec.variants.filter((v) => v.request.auth === 'basic').map((v) => v.request);
  const covered = spec.variants
    .filter((v) => v.request.auth === 'basic')
    .every((v) => savedBasic.some((s) => s.scheme === v.request.scheme
      && s.port === v.request.port
      && (!v.request.tlsSkipVerify || s.tlsSkipVerify)));
  if (!covered) {
    throw new AppError(400, 'Stored credentials can only be tested with the scheme, port and TLS verification of the saved rule');
  }
}

/**
 * The probe that runs a check on `item` now: the executor (discoverer /
 * primary / any capable, see match.ts) among the capable probes of the site
 * that are connected by WebSocket.
 */
function pickConnectedExecutor(item: ItemRow, candidates: ExecutorCandidate[]): number {
  const capable = candidates.filter((p) => p.status === 'approved' && p.capable);
  if (capable.length === 0) throw new AppError(409, 'probe_unsupported');
  const probeId = selectExecutorProbe(item, capable.filter((p) => isProbeConnected(p.id)));
  if (probeId === null) throw new AppError(409, 'probe_not_connected');
  return probeId;
}

export const deviceCheckTestService = {
  /**
   * Runs `input.spec` once on device `input.siteItemId` and evaluates the
   * assertions like a scheduled result. The spec was validated by the route
   * (testSchema); the platform policy is checked here.
   */
  async test(tenantId: number, input: TestInput, viewer: DeviceCheckViewer): Promise<DeviceCheckTestResponse> {
    const spec: DeviceCheckSpec = input.spec;
    // Only a device of a site the author may read (as if it did not
    // exist otherwise). Checked before the spec policy, so a refusal never
    // depends on devices of sites the author cannot read.
    const item = await loadItem(tenantId, input.siteItemId);
    await assertItemReadable(tenantId, viewer, item);
    const issues = await specPolicyIssues(tenantId, spec, viewer);
    if (issues.length > 0) throw new DeviceCheckValidationError(issues);
    if (!isTargetableAddress(item.ip)) throw new AppError(400, 'target_not_allowed');
    const usesBasic = specUsesBasicAuth(spec);
    const mac = normalizeMacAddress(item.mac);
    if ((spec.match.requireMac || usesBasic) && !mac) {
      throw new AppError(400, 'This device has no known MAC address, which this check requires');
    }

    let ruleId = 0;
    let revision = 0;
    if (input.ruleId != null) {
      const rule = await db('device_check_rules').where({ id: input.ruleId, tenant_id: tenantId })
        .first('id', 'tenant_id', 'name', 'enabled', 'suspended_reason', 'group_id', 'site_id', 'spec', 'revision',
          'created_by', 'updated_by') as Record<string, unknown> | undefined;
      if (!rule) throw new AppError(404, 'Rule not found');
      ruleId = Number(rule.id);
      revision = Number(rule.revision) || 0;
      if (usesBasic && input.credentials === 'stored') {
        // Stored credentials belong to the writers of the rule's scope (a
        // tenant-wide rule: full access only), like every credential operation.
        await assertAuthoringScope(tenantId, viewer, {
          groupId: rule.group_id == null ? null : Number(rule.group_id),
          siteId: rule.site_id == null ? null : Number(rule.site_id),
        }, 'write');
        await assertStoredCredentialsUsable(tenantId, rule, item, spec);
      }
    }

    const candidates = await loadSiteProbes(tenantId, item.site_id);
    const probeId = pickConnectedExecutor(item, candidates);
    const probeRow = await db('probes').where({ id: probeId, tenant_id: tenantId }).first('id', 'server_scheme', 'capabilities') as
      { id: number; server_scheme: string | null; capabilities: unknown } | undefined;
    if (!probeRow) throw new AppError(409, 'probe_not_connected');

    const policy = await appConfigService.getDeviceChecksPolicy();
    const wire = buildWireRule(ruleId, revision, spec, policy);
    if (!wire) throw new AppError(400, 'No variant uses a port allowed by the platform policy');

    const target: ProbeCheckTarget = { ruleId, itemId: item.id, ip: item.ip, mac };
    if (usesBasic) {
      if (input.credentials === 'stored') {
        if (!ruleId) throw new AppError(400, 'Stored credentials need a saved rule (ruleId)');
        const c = await resolveStoredCredentials(tenantId, ruleId, item.site_id, probeRow);
        if (c.credentials) target.credentials = c.credentials;
        else target.authBlocked = c.authBlocked;
      } else if (input.credentials) {
        if (secretsTransportAllowed(probeRow)) {
          target.credentials = { username: input.credentials.username, password: input.credentials.password };
        } else {
          target.authBlocked = 'insecure_transport';
        }
      } else {
        target.authBlocked = 'missing';
      }
    }

    // Wait registered before the request is sent; the reply is matched by
    // testId (and must come from this probe's own connection).
    const testId = crypto.randomUUID();
    const reply = waitForProbeReply<unknown>('check_test', testId, probeId, CHECK_TEST_TIMEOUT_MS);
    const sent = sendToProbe(probeId, { type: PROBE_WS_MESSAGES.CHECK_TEST, testId, rule: wire, target });
    if (!sent) {
      cancelProbeReply('check_test', testId);
      await reply.catch(() => undefined);
      throw new AppError(409, 'probe_not_connected');
    }

    let raw: unknown;
    try {
      raw = await reply;
    } catch (err) {
      if (err instanceof ProbeReplyError) {
        if (err.code === 'timeout') throw new AppError(504, 'probe_timeout');
        if (err.code === 'overloaded') throw new AppError(503, 'Too many pending probe requests');
        throw new AppError(409, 'probe_not_connected');
      }
      throw err;
    }

    const parsed = probeCheckResultSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ probeId, issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')) }, 'Invalid check_test_result from probe');
      throw new AppError(502, 'Invalid answer from the probe');
    }
    const result = parsed.data;
    const now = new Date();
    const values = coerceValues(spec.fields, result.status === 'ok' ? result.values : {});
    // Every value is a first observation.
    const changedAt = Object.fromEntries(Object.keys(values).map((k) => [k, now.toISOString()]));
    const assertions = result.status === 'ok' ? evaluateAssertions(spec, values, result.regex, changedAt, now) : [];
    const status = computeStatus(result, assertions);

    return {
      probeId,
      status,
      result: {
        ...result,
        values,
        ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
      },
      assertions,
    };
  },

  /**
   * Asks the executor of a check to run it now. The rule must be enabled and
   * the device still targeted by this probe; the probe ignores a request for
   * a check it does not run.
   */
  async runNow(tenantId: number, stateId: number, viewer: DeviceCheckViewer): Promise<{ probeId: number; ruleId: number; itemId: number }> {
    const state = await db('device_check_state as s')
      .join('device_check_rules as r', function joinRule() {
        this.on('r.id', '=', 's.rule_id').andOn('r.tenant_id', '=', 's.tenant_id');
      })
      .where('s.id', stateId)
      .where('s.tenant_id', tenantId)
      .first('s.rule_id', 's.site_item_id', 's.site_id', 'r.id as r_id', 'r.tenant_id as r_tenant_id', 'r.name as r_name',
        'r.enabled as r_enabled', 'r.suspended_reason as r_suspended_reason', 'r.spec as r_spec', 'r.revision as r_revision') as
      Record<string, unknown> | undefined;
    if (!state) throw new AppError(404, 'Check not found');
    // A check of a site the caller cannot read does not exist for them.
    if (!(await permissionService.canReadSite(viewer.userId, Number(state.site_id), tenantId, viewer.isPlatformAdmin))) {
      throw new AppError(404, 'Check not found');
    }
    const rule = rowToRuleRecord({
      id: state.r_id, tenant_id: state.r_tenant_id, name: state.r_name, enabled: state.r_enabled,
      suspended_reason: state.r_suspended_reason, spec: state.r_spec, revision: state.r_revision,
    });
    if (!rule || !rule.enabled || rule.suspendedReason) throw new AppError(409, 'rule_disabled');

    const item = await loadItem(tenantId, Number(state.site_item_id));
    const candidates = await loadSiteProbes(tenantId, item.site_id);
    const capable = candidates.filter((p) => p.status === 'approved' && p.capable);
    if (capable.length === 0) throw new AppError(409, 'probe_unsupported');
    // Only the executor has a worker for this check.
    const probeId = selectExecutorProbe(item, capable);
    if (probeId === null || !isProbeConnected(probeId)) throw new AppError(409, 'probe_not_connected');
    const sent = sendToProbe(probeId, { type: PROBE_WS_MESSAGES.CHECK_RUN_NOW, ruleId: rule.id, itemId: item.id });
    if (!sent) throw new AppError(409, 'probe_not_connected');
    return { probeId, ruleId: rule.id, itemId: item.id };
  },
};
