import type { Request, Response, NextFunction } from 'express';
import { DEVICE_CHECK_PRESETS } from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';
import { appConfigService } from '../services/appConfig.service';
import { requireDbId, toDbId } from '../utils/dbId';
import { logger } from '../utils/logger';
import {
  deviceCheckSpecSchema,
  validateSpecSchema,
  type CreateRuleInput,
  type CredentialsInput,
  type DeviceChecksPolicyInput,
  type PreviewInput,
  type TestInput,
  type UpdateRuleInput,
} from '../validators/deviceCheck.schema';
import {
  deviceCheckRuleService,
  DeviceCheckValidationError,
  specPolicyIssues,
  type DeviceCheckViewer,
} from '../services/deviceChecks/rule.service';
import { deviceCheckTestService } from '../services/deviceChecks/test.service';
import { pushConfigToAllTenants, specHash } from '../services/deviceChecks/config.service';

// Device Checks API, mounted at /api/device-checks on the
// tenant router (requireAuth + requireTenant). Authoring, test, run-now and
// credentials need deviceChecks.manage (routes/deviceChecks.routes.ts) and,
// without full access, stay inside the author's readable / writable team
// scope (rule.service assertAuthoringScope); reads of states,
// events and summaries are open to the tenant's members, limited to the sites
// they may read (team permissions, like the rest of the IPAM). Every mutation is
// audited (auditService.logReq) and never with a secret value. Bodies are
// validated by the routes (validators/deviceCheck.schema.ts); ids go through
// toDbId.

function sessionUserId(req: Request): number {
  const id = toDbId(req.session?.userId);
  if (id === null) throw new AppError(401, 'Authentication required');
  return id;
}

/** The reader / author (team-scoped site and group permissions). */
function viewerOf(req: Request): DeviceCheckViewer {
  return { userId: sessionUserId(req), isPlatformAdmin: req.session.role === 'admin' };
}

/** DeviceCheckValidationError → 400 with issues (same shape as middleware/validate.ts). */
function fail(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof DeviceCheckValidationError) {
    res.status(400).json({ success: false, error: err.message, issues: err.issues });
    return;
  }
  next(err);
}

/** Cursor on device_check_events.id (bigint): digits only, safe integer. */
function optionalCursor(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) throw new AppError(400, 'Invalid before');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new AppError(400, 'Invalid before');
  return n;
}

function optionalLimit(value: unknown, max: number): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = toDbId(value);
  if (n === null) throw new AppError(400, 'Invalid limit');
  return Math.min(max, n);
}

export const deviceChecksController = {
  // ── Presets ──────────────────────────────────────────────────────────────

  /** GET /device-checks/presets — preset metadata (the specs ship in @oblimap/shared). */
  async presets(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const presets = DEVICE_CHECK_PRESETS.map(({ spec: _spec, ...meta }) => meta);
      res.json({ presets });
    } catch (err) { next(err); }
  },

  // ── Rules (admin) ────────────────────────────────────────────────────────

  async listRules(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rules = await deviceCheckRuleService.list(req.tenantId);
      res.json({ rules });
    } catch (err) { next(err); }
  },

  async getRule(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rule = await deviceCheckRuleService.get(req.tenantId, requireDbId(req.params.id, 'rule id'));
      if (!rule) throw new AppError(404, 'Rule not found');
      res.json({ rule });
    } catch (err) { next(err); }
  },

  /** POST /device-checks/validate {spec} → {ok, issues[]} (live form validation, always 200). */
  async validateSpec(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = validateSpecSchema.safeParse(req.body);
      if (!body.success) throw new AppError(400, 'Expected {spec}');
      const parsed = deviceCheckSpecSchema.safeParse(body.data.spec);
      if (!parsed.success) {
        res.json({
          ok: false,
          issues: parsed.error.issues.slice(0, 100).map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
      const issues = await specPolicyIssues(req.tenantId, parsed.data, viewerOf(req));
      res.json({ ok: issues.length === 0, issues });
    } catch (err) { next(err); }
  },

  async createRule(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const input = req.body as CreateRuleInput;
      const rule = await deviceCheckRuleService.create(req.tenantId, viewerOf(req), input);
      await auditService.logReq(req, {
        action: 'device_check.rule_created',
        resourceType: 'device_check_rule',
        resourceId: rule.id,
        details: {
          name: rule.name,
          groupId: rule.groupId,
          siteId: rule.siteId,
          // not "presetKey": the audit log redacts keys ending in "key"
          preset: rule.presetKey,
          presetVersion: rule.presetVersion,
          specHash: specHash(rule.spec),
        },
      });
      res.status(201).json({ rule });
    } catch (err) { fail(err, res, next); }
  },

  async updateRule(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'rule id');
      const change = await deviceCheckRuleService.update(req.tenantId, viewerOf(req), id, req.body as UpdateRuleInput);
      if (!change) throw new AppError(404, 'Rule not found');
      await auditService.logReq(req, {
        action: 'device_check.rule_updated',
        resourceType: 'device_check_rule',
        resourceId: id,
        details: {
          name: change.rule.name,
          changedKeys: change.changedKeys,
          oldSpecHash: change.oldSpecHash,
          newSpecHash: change.newSpecHash,
          revision: change.rule.revision,
        },
      });
      res.json({ rule: change.rule });
    } catch (err) { fail(err, res, next); }
  },

  async enableRule(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'rule id');
      const rule = await deviceCheckRuleService.setEnabled(req.tenantId, viewerOf(req), id, true);
      if (!rule) throw new AppError(404, 'Rule not found');
      await auditService.logReq(req, {
        action: 'device_check.rule_enabled',
        resourceType: 'device_check_rule',
        resourceId: id,
        details: { name: rule.name, revision: rule.revision, specHash: specHash(rule.spec) },
      });
      res.json({ rule });
    } catch (err) { fail(err, res, next); }
  },

  async disableRule(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'rule id');
      const rule = await deviceCheckRuleService.setEnabled(req.tenantId, viewerOf(req), id, false);
      if (!rule) throw new AppError(404, 'Rule not found');
      await auditService.logReq(req, {
        action: 'device_check.rule_disabled',
        resourceType: 'device_check_rule',
        resourceId: id,
        details: { name: rule.name, revision: rule.revision },
      });
      res.json({ rule });
    } catch (err) { fail(err, res, next); }
  },

  async deleteRule(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'rule id');
      const deleted = await deviceCheckRuleService.remove(req.tenantId, viewerOf(req), id);
      if (!deleted) throw new AppError(404, 'Rule not found');
      await auditService.logReq(req, {
        action: 'device_check.rule_deleted',
        resourceType: 'device_check_rule',
        resourceId: id,
        details: { name: deleted.name, wasEnabled: deleted.enabled },
      });
      res.status(204).send();
    } catch (err) { fail(err, res, next); }
  },

  // ── Credentials (admin, write-only) ───────────────────────────────────────

  /** PUT /device-checks/rules/:id/credentials {siteId, username, password} → {credentials} (metadata only). */
  async setCredentials(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'rule id');
      const input = req.body as CredentialsInput;
      const credentials = await deviceCheckRuleService.setCredentials(req.tenantId, viewerOf(req), id, input);
      if (!credentials) throw new AppError(404, 'Rule not found');
      await auditService.logReq(req, {
        action: 'device_check.credentials_set',
        resourceType: 'device_check_credential',
        resourceId: id,
        details: { ruleId: id, siteId: input.siteId ?? null },
      });
      res.json({ credentials });
    } catch (err) { fail(err, res, next); }
  },

  /** DELETE /device-checks/rules/:id/credentials?siteId= (absent: the rule default) → {credentials}. */
  async clearCredentials(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = requireDbId(req.params.id, 'rule id');
      const raw = req.query.siteId;
      const siteId = raw === undefined || raw === '' || raw === 'null' ? null : requireDbId(raw, 'siteId');
      const credentials = await deviceCheckRuleService.clearCredentials(req.tenantId, viewerOf(req), id, siteId);
      if (credentials === null) throw new AppError(404, 'Rule not found');
      if (credentials === false) throw new AppError(404, 'No credentials stored');
      await auditService.logReq(req, {
        action: 'device_check.credentials_cleared',
        resourceType: 'device_check_credential',
        resourceId: id,
        details: { ruleId: id, siteId },
      });
      res.json({ credentials });
    } catch (err) { fail(err, res, next); }
  },

  // ── Preview / test / run now (admin) ──────────────────────────────────────

  /** POST /device-checks/preview-matches {match, groupId?, siteId?} → {total, bySite, sitesWithoutCapableProbe, sample}. */
  async previewMatches(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await deviceCheckRuleService.previewMatches(req.tenantId, req.body as PreviewInput, viewerOf(req));
      res.json(result);
    } catch (err) { fail(err, res, next); }
  },

  /** POST /device-checks/test → DeviceCheckTestResponse. */
  async test(req: Request, res: Response, next: NextFunction): Promise<void> {
    const input = req.body as TestInput;
    const credentialMode = input.credentials === 'stored' ? 'stored' : input.credentials ? 'inline' : 'none';
    try {
      const result = await deviceCheckTestService.test(req.tenantId, input, viewerOf(req));
      await auditService.logReq(req, {
        action: 'device_check.tested',
        resourceType: 'device_check_rule',
        resourceId: input.ruleId ?? null,
        probeId: result.probeId,
        details: { siteItemId: input.siteItemId, ruleId: input.ruleId ?? null, bodySnippet: true, credentialMode, status: result.status },
      });
      res.json(result);
    } catch (err) {
      if (err instanceof AppError && !(err instanceof DeviceCheckValidationError) && err.statusCode >= 409) {
        // The request may have reached a probe: audited as well.
        void auditService.logReq(req, {
          action: 'device_check.tested',
          resourceType: 'device_check_rule',
          resourceId: input.ruleId ?? null,
          details: { siteItemId: input.siteItemId, ruleId: input.ruleId ?? null, bodySnippet: true, credentialMode, outcome: err.message },
        });
      }
      fail(err, res, next);
    }
  },

  /** POST /device-checks/states/:stateId/run-now → {probeId, ruleId, itemId}. */
  async runNow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stateId = requireDbId(req.params.stateId, 'state id');
      const result = await deviceCheckTestService.runNow(req.tenantId, stateId, viewerOf(req));
      await auditService.logReq(req, {
        action: 'device_check.run_now',
        resourceType: 'device_check_rule',
        resourceId: result.ruleId,
        probeId: result.probeId,
        details: { stateId, ruleId: result.ruleId, siteItemId: result.itemId },
      });
      res.json(result);
    } catch (err) { fail(err, res, next); }
  },

  // ── Reads (tenant members, site read permission) ──────────────────────────

  /** GET /device-checks/sites/:siteId/states → {states: DeviceCheckStateDetail[]} (route: requireSiteRead). */
  async siteStates(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const states = await deviceCheckRuleService.siteStates(req.tenantId, requireDbId(req.params.siteId, 'site id'));
      res.json({ states });
    } catch (err) { next(err); }
  },

  /** GET /device-checks/states/:stateId/events?before=&limit= → {events, nextCursor} (404 without read access to the site). */
  async stateEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stateId = requireDbId(req.params.stateId, 'state id');
      const result = await deviceCheckRuleService.stateEvents(req.tenantId, viewerOf(req), stateId, {
        before: optionalCursor(req.query.before),
        limit: optionalLimit(req.query.limit, 100),
      });
      res.json(result);
    } catch (err) { next(err); }
  },

  /** GET /device-checks/summary → {sites: DeviceCheckSiteSummary[]} (the sites the user may read). */
  async summary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const sites = await deviceCheckRuleService.summary(req.tenantId, viewerOf(req));
      res.json({ sites });
    } catch (err) { next(err); }
  },

  // ── Platform policy (/api/admin/config/device-checks-policy) ──────────────

  async getPolicy(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const policy = await appConfigService.getDeviceChecksPolicy();
      res.json({ policy });
    } catch (err) { next(err); }
  },

  async setPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const before = await appConfigService.getDeviceChecksPolicy();
      const policy = await appConfigService.setDeviceChecksPolicy(req.body as DeviceChecksPolicyInput);
      await auditService.logReq(req, {
        tenantId: null, // platform-wide setting
        action: 'device_check.policy_updated',
        resourceType: 'device_checks_policy',
        details: { before, after: policy },
      });
      // Ports / caps / intervals of every probe assignment may change.
      void pushConfigToAllTenants().catch((err: unknown) =>
        logger.warn({ err: (err as Error)?.message }, 'Device checks config push after a policy change failed'));
      res.json({ policy });
    } catch (err) { next(err); }
  },
};
