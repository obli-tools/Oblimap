import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';
import type { Knex } from 'knex';
import { z } from 'zod';
import { db } from '../db';
import { obligateService, type ObligateUserAssertion } from '../services/obligate.service';
import { appConfigService, type ObligateActiveConfig } from '../services/appConfig.service';
import { auditService } from '../services/audit.service';
import { killSessionsForUser } from '../services/userSessions.service';
import { invalidateTenantCapabilityCache } from '../services/permission.service';
import { emitPermissionsChanged } from '../services/realtime.service';
import { permissionSetService, TENANT_ADMIN_ROLE, LEGACY_MEMBER_ROLE, LEGACY_MEMBER_SET } from '../services/permissionSet.service';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { bearerFailLimiter } from '../middleware/rateLimiter';
import { invalidateSessionUserCache } from '../middleware/sessionUserGuard';
import { invalidateAccountableCache } from '../services/deviceChecks/config.service';
import { regenerateSession } from '../utils/session';
import { pickInitialTenantId, invalidateTenantAccessCache } from '../utils/sessionTenant';
import { safeEqualSecret } from '../utils/safeCompare';
import { clientIp } from '../utils/clientIp';
import { logger } from '../utils/logger';

const router = Router();

// NOTE — the Obligate protocol identifies the app by `client_id` in the
// browser-facing /authorize redirect. It is always the public client id,
// sha256(API key) (obligatePublicClientId): the key never leaves the server,
// and Obligate refuses the raw API key there. Earlier versions sent the API
// key itself (visible in the Location header, browser history, proxy logs),
// so a key used with them may be public until it is rotated in Obligate.
// Obligate calls the Bearer routes below with the inbound secret when one is
// set (Settings or OBLIGATE_INBOUND_SECRET), else with that same API key. So,
// as long as the key may be public, every Bearer route grants a key holder as
// little as possible:
//   - app-info / dashboard-stats: tenant/team/permission set names and three
//     counters;
//   - sso-user-sync: acts only on the og_ account OUR records link to the
//     given Obligate identity, never on a local account, and never promotes
//     (the platform role comes from the verified assertion of the next SSO
//     sign-in).
// A key that was ever sent as client_id by an earlier version must be rotated
// in Obligate (it may have leaked through those redirects).

// ── Obligate enabled guard ─────────────────────────────────────────────────
// Every route that signs a user in through Obligate, calls it for a user or
// answers it requires SSO to be ENABLED and configured (URL + API key) —
// otherwise the route does not exist: browser routes send the user back to
// the login page, API routes answer 404. The settings are cached 10 s by
// appConfigService.getObligateRawIfEnabled (dropped at once on a change).

function requireObligateEnabled(kind: 'browser' | 'api'): RequestHandler {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    let cfg: ObligateActiveConfig | null;
    try {
      cfg = await appConfigService.getObligateRawIfEnabled();
    } catch (err) {
      logger.error(err, 'Obligate SSO: configuration unreadable');
      if (kind === 'browser') res.redirect('/login?error=sso_failed');
      else res.status(503).json({ success: false, error: 'Service unavailable' });
      return;
    }
    if (!cfg) {
      if (kind === 'browser') res.redirect('/login?error=sso_disabled');
      else res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.locals.obligate = cfg;
    next();
  };
}

const ssoBrowserRoute = requireObligateEnabled('browser');
const ssoApiRoute = requireObligateEnabled('api');

/** Settings resolved by requireObligateEnabled for this request. */
function activeObligate(res: Response): ObligateActiveConfig {
  return res.locals.obligate as ObligateActiveConfig;
}

// ── Reverse auth (Obligate → this app) ─────────────────────────────────────
// `Authorization: Bearer <inbound secret, else our Obligate API key>`,
// compared in constant time (obligateService.verifyInboundBearer). Failures
// are throttled per address by bearerFailLimiter (mounted before this check)
// and audited at most once per address per minute (sso.bearer_failed).

const AUDIT_THROTTLE_MS = 60_000;
const AUDIT_THROTTLE_MAX_KEYS = 1_000;

/**
 * True at most once per `key` per minute: throttles audit rows a caller can
 * trigger at will. Bounded: the map is reset when full.
 */
function firstInAuditWindow(seen: Map<string, number>, key: string): boolean {
  const now = Date.now();
  const last = seen.get(key);
  if (last !== undefined && now - last < AUDIT_THROTTLE_MS) return false;
  if (seen.size >= AUDIT_THROTTLE_MAX_KEYS) seen.clear();
  seen.set(key, now);
  return true;
}

const bearerFailureSeenAt = new Map<string, number>();

function noteBearerFailure(req: Request): void {
  const ip = clientIp(req) || 'unknown';
  if (!firstInAuditWindow(bearerFailureSeenAt, ip)) return;
  logger.warn({ ip, endpoint: req.path }, 'Obligate reverse auth: invalid or missing Bearer token');
  void auditService.log({
    action: 'sso.bearer_failed',
    resourceType: 'obligate',
    details: { endpoint: req.path },
    ipAddress: ip === 'unknown' ? null : ip,
  });
}

async function requireObligateBearer(req: Request, res: Response, next: NextFunction): Promise<void> {
  let ok: boolean;
  try {
    ok = await obligateService.verifyInboundBearer(req.headers.authorization);
  } catch (err) {
    logger.error(err, 'Obligate reverse auth: verification failed');
    res.status(503).json({ success: false, error: 'Service unavailable' });
    return;
  }
  if (!ok) {
    noteBearerFailure(req);
    res.status(401).json({ success: false, error: 'Invalid API key' });
    return;
  }
  next();
}

const obligateBearerRoute: RequestHandler[] = [ssoApiRoute, bearerFailLimiter, requireObligateBearer];

// ── SSO sign-in ────────────────────────────────────────────────────────────

/** A unique violation on an e-mail index (e.g. users_email_lower_uq). */
function isEmailUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return !!e && e.code === '23505' && typeof e.constraint === 'string' && /email/i.test(e.constraint);
}

/**
 * Updates a user from the assertion. An e-mail already used by another
 * account (unique index) is not synced rather than failing the sign-in.
 */
async function updateUserFromAssertion(userId: number, update: Record<string, unknown>): Promise<void> {
  try {
    await db('users').where({ id: userId }).update(update);
  } catch (err) {
    if (!isEmailUniqueViolation(err) || !('email' in update)) throw err;
    logger.warn({ userId }, 'Obligate SSO: e-mail already used by another account — not synced');
    const { email: _email, ...rest } = update;
    await db('users').where({ id: userId }).update(rest);
  }
}

/** Creates the og_ account of an Obligate identity (same e-mail fallback). */
async function insertSsoUser(row: Record<string, unknown>): Promise<number> {
  const insert = async (values: Record<string, unknown>): Promise<number> => {
    const [created] = await db('users').insert(values).returning('id') as Array<{ id: number } | number>;
    return typeof created === 'number' ? created : Number(created.id);
  };
  try {
    return await insert(row);
  } catch (err) {
    if (!isEmailUniqueViolation(err)) throw err;
    logger.warn({ username: row.username }, 'Obligate SSO: e-mail already used by another account — account created without it');
    return insert({ ...row, email: null });
  }
}

/**
 * Tenant + team memberships of an SSO account, as the verified assertion
 * grants them:
 *  - upserts the tenant rows the assertion grants, with the tenant role
 *    ssoTenantRole resolves (a role change is logged and audited);
 *  - with `prune` (og_ accounts of non platform admins: Obligate owns their
 *    access, it cannot be edited here) removes the tenant rows Obligate no
 *    longer grants, and the team memberships in those tenants;
 *  - an assertion that names NO tenant is an app-wide grant (Obligate's "All
 *    tenants" mapping — otherwise Obligate refuses the user outright): there
 *    is nothing to prune against, and a non platform admin without any
 *    membership gets the default (lowest id) tenant, the access such accounts
 *    have always had here (they used to fall back to tenant 1). An assertion
 *    naming only tenants unknown here grants nothing (no fallback);
 *  - reconciles the team memberships of each tenant the assertion EXPLICITLY
 *    grants (Obliance semantics): Obligate's mapping for that tenant decides
 *    its teams, an empty list included. Nowhere else: an app-wide grant
 *    carries no team decision, so the teams assigned here (Admin > Users)
 *    are kept; so are those of the tenants an explicit grant does not name,
 *    unless `prune` removes them with those tenants.
 * Returns true when a tenant row was removed.
 */
async function applySsoMemberships(
  localUserId: number,
  assertion: ObligateUserAssertion,
  opts: { prune: boolean; isPlatformAdmin: boolean },
): Promise<boolean> {
  const granted = (Array.isArray(assertion.tenants) ? assertion.tenants as Array<{ slug?: unknown; role?: unknown } | null> : [])
    .filter((t): t is { slug: string; role?: unknown } => !!t && typeof t.slug === 'string');
  const teams = Array.isArray(assertion.teams)
    ? (assertion.teams as unknown[]).filter((n): n is string => typeof n === 'string')
    : [];
  const appWideGrant = granted.length === 0;
  const keep = new Set<number>();
  let tenantRemoved = false;

  // Note: `capabilities` of the assertion are intentionally ignored. The
  // single source of truth for per-app rights is the team a user belongs to
  // inside this app plus the tenant role (a permission set, see ssoTenantRole)
  // — capability checkboxes are not exposed through /api/auth/app-info.
  let roleChanged = false;
  let teamsChanged = false;
  for (const t of granted) {
    const tenant = await db('tenants').where({ slug: t.slug }).first('id') as { id: number } | undefined;
    if (!tenant) continue;
    const tenantId = Number(tenant.id);
    keep.add(tenantId);
    const change = await db.transaction(async (trx) => {
      const current = await trx('user_tenants')
        .where({ user_id: localUserId, tenant_id: tenantId })
        .forUpdate()
        .first('role') as { role: string } | undefined;
      const role = await ssoTenantRole(trx, t.role, current?.role);
      await trx('user_tenants')
        .insert({ user_id: localUserId, tenant_id: tenantId, role })
        .onConflict(['user_id', 'tenant_id'])
        .merge({ role });
      return current && current.role !== role ? { from: current.role, to: role } : null;
    });
    if (change) {
      roleChanged = true;
      logger.info({ localUserId, tenantId, from: change.from, to: change.to }, 'Obligate SSO: tenant role updated');
      void auditService.log({
        tenantId,
        userId: localUserId,
        action: 'tenant.member_role_changed',
        resourceType: 'user',
        resourceId: localUserId,
        details: { from: change.from, to: change.to, source: 'obligate' },
      });
    }

    // Team memberships of THIS tenant against the granted teams:
    // assertion.teams is a flat list of team NAMES across the user's tenants,
    // matched by name within this tenant so the same name in another tenant
    // doesn't cross-contaminate.
    const wantedTeamIds = teams.length > 0
      ? (await db('user_teams').where({ tenant_id: tenantId }).whereIn('name', teams).pluck('id') as number[]).map(Number)
      : [];
    const currentTeamIds = (await db('team_memberships')
      .join('user_teams', 'user_teams.id', 'team_memberships.team_id')
      .where({ 'team_memberships.user_id': localUserId, 'user_teams.tenant_id': tenantId })
      .pluck('team_memberships.team_id') as number[]).map(Number);
    const toAdd = wantedTeamIds.filter((id) => !currentTeamIds.includes(id));
    const toRemove = currentTeamIds.filter((id) => !wantedTeamIds.includes(id));
    if (toAdd.length > 0 || toRemove.length > 0) teamsChanged = true;
    if (toAdd.length > 0) {
      await db('team_memberships')
        .insert(toAdd.map((team_id) => ({ team_id, user_id: localUserId })))
        .onConflict(['team_id', 'user_id'])
        .ignore();
    }
    if (toRemove.length > 0) {
      await db('team_memberships').where({ user_id: localUserId }).whereIn('team_id', toRemove).del();
    }
  }

  if (opts.prune && !appWideGrant) {
    const keepIds = [...keep];
    const staleTeamIds = (await db('team_memberships')
      .join('user_teams', 'user_teams.id', 'team_memberships.team_id')
      .where({ 'team_memberships.user_id': localUserId })
      .modify((q) => { if (keepIds.length > 0) q.whereNotIn('user_teams.tenant_id', keepIds); })
      .pluck('team_memberships.team_id') as number[]).map(Number);
    if (staleTeamIds.length > 0) {
      teamsChanged = true;
      await db('team_memberships').where({ user_id: localUserId }).whereIn('team_id', staleTeamIds).del();
    }
    const staleTenantIds = (await db('user_tenants')
      .where({ user_id: localUserId })
      .modify((q) => { if (keepIds.length > 0) q.whereNotIn('tenant_id', keepIds); })
      .pluck('tenant_id') as number[]).map(Number);
    if (staleTenantIds.length > 0) {
      await db('user_tenants').where({ user_id: localUserId }).whereIn('tenant_id', staleTenantIds).del();
      logger.info({ localUserId, tenantIds: staleTenantIds }, 'Obligate SSO: tenant access no longer granted by Obligate — removed');
      tenantRemoved = true;
    }
  }

  if (appWideGrant && !opts.isPlatformAdmin) {
    const member = await db('user_tenants').where({ user_id: localUserId }).first('tenant_id');
    const fallback = member ? undefined : await db('tenants').orderBy('id').first('id') as { id: number } | undefined;
    if (fallback) {
      await db('user_tenants')
        .insert({ user_id: localUserId, tenant_id: Number(fallback.id), role: LEGACY_MEMBER_SET })
        .onConflict(['user_id', 'tenant_id'])
        .ignore();
      logger.info({ localUserId, tenantId: Number(fallback.id) }, 'Obligate SSO: app-wide grant — default tenant membership added');
    }
  }

  if (roleChanged) {
    // Capabilities and device-check accountability (deviceChecks.manage) are
    // re-resolved on the next request / config build.
    invalidateTenantCapabilityCache(localUserId);
    invalidateAccountableCache(localUserId);
  }
  // An open client of the user re-reads its permissions and tree.
  if (roleChanged || teamsChanged || tenantRemoved) emitPermissionsChanged([localUserId]);
  return tenantRemoved;
}

/**
 * Tenant role stored for a tenant the assertion grants (user_tenants.role is
 * a permission set slug, WP23): 'admin', or the permission set slug Obligate
 * sends when it names one of ours (app-info lists them), as Obliance stores
 * Obligate's slug. Obligate's 'user' is such a slug: the seeded, undeletable
 * 'user' set ("Site manager": monitoring, groups.manage, sites.manage), stored
 * as that set. Only an unknown slug grants a non-admin role without naming a
 * set: an existing membership
 * keeps the set it has (assigned here), a tenant admin becomes a plain
 * member, a new membership is a plain member. 'Plain member' is the 'viewer'
 * set (the legacy 'member' is no longer written; an existing
 * 'member' row, or Obligate sending 'member', becomes 'viewer' — the same
 * capabilities). Runs in the transaction that writes the role
 * (lockAssignableTenantRole: the set cannot vanish between).
 */
async function ssoTenantRole(trx: Knex.Transaction, requested: unknown, current: string | undefined): Promise<string> {
  const asSet = (role: string) => (role === LEGACY_MEMBER_ROLE ? LEGACY_MEMBER_SET : role);
  if (typeof requested === 'string' && requested.length > 0 && requested.length <= 64
    && await permissionSetService.lockAssignableTenantRole(trx, asSet(requested))) {
    return asSet(requested);
  }
  if (current !== undefined && current !== TENANT_ADMIN_ROLE) return asSet(current);
  return LEGACY_MEMBER_SET;
}

/** Theme / language / toast / anonymous-mode preferences from the assertion. */
async function syncPreferences(localUserId: number, preferences: ObligateUserAssertion['preferences']): Promise<void> {
  if (!preferences) return;
  const prefUpdate: Record<string, unknown> = {};
  if (preferences.preferredLanguage) prefUpdate.preferred_language = preferences.preferredLanguage;
  if (preferences.profilePhotoUrl !== undefined) prefUpdate.avatar = preferences.profilePhotoUrl;
  if (Object.keys(prefUpdate).length > 0) {
    await db('users').where({ id: localUserId }).update(prefUpdate);
  }
  const uiPrefs: Record<string, unknown> = {};
  if (preferences.preferredTheme) uiPrefs.preferredTheme = preferences.preferredTheme;
  if (preferences.toastEnabled !== undefined) uiPrefs.toastEnabled = preferences.toastEnabled;
  if (preferences.toastPosition) uiPrefs.toastPosition = preferences.toastPosition;
  if (preferences.anonymousMode !== undefined) uiPrefs.anonymousMode = preferences.anonymousMode;
  if (Object.keys(uiPrefs).length > 0) {
    const existingRow = await db('users').where({ id: localUserId }).select('preferences').first() as { preferences: unknown } | undefined;
    const existing = (typeof existingRow?.preferences === 'string' ? JSON.parse(existingRow.preferences) : existingRow?.preferences) ?? {};
    await db('users').where({ id: localUserId }).update({
      preferences: JSON.stringify({ ...existing, ...uiPrefs }),
    });
  }
}

/** Sign-in refused: audited, the browser is sent to the login page with `code`. */
function refuseSignIn(req: Request, res: Response, code: 'account_disabled' | 'no_tenant_access', details: Record<string, unknown>): void {
  logger.warn({ ...details, reason: code }, 'Obligate SSO: sign-in refused');
  void auditService.log({
    action: 'sso.login_refused',
    resourceType: 'user',
    resourceId: typeof details.localUserId === 'number' ? details.localUserId : null,
    details: { ...details, reason: code },
    ipAddress: clientIp(req) || null,
  });
  res.redirect(`/login?error=${code}`);
}

/**
 * GET /auth/callback?code=xxx&state=xxx
 * Called by Obligate after successful authentication.
 * Exchanges the code for user info, auto-provisions, creates session, redirects.
 */
router.get('/callback', ssoBrowserRoute, async (req, res) => {
  try {
    const { code, state } = req.query;
    if (typeof code !== 'string' || !code) {
      res.status(400).json({ success: false, error: 'Missing code' });
      return;
    }

    // Validate OAuth state parameter to prevent login CSRF (RFC 6749 §10.12)
    const expectedState = req.session.oauthState;
    delete req.session.oauthState;
    if (typeof state !== 'string' || !state || !expectedState || !safeEqualSecret(state, expectedState)) {
      logger.warn({ receivedState: !!state, expectedState: !!expectedState }, 'Obligate callback: OAuth state mismatch — possible CSRF');
      res.redirect('/login?error=sso_failed');
      return;
    }
    // Cross-app tenant hint of /auth/sso-redirect: consumed by this sign-in only
    const requestedSlug = req.session.requestedTenantSlug ?? null;
    delete req.session.requestedTenantSlug;

    // Build the redirect_uri that was used in the authorize request
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/auth/callback`;

    // Exchange code with Obligate
    logger.info({ redirectUri }, 'Obligate callback: exchanging code');
    const assertion = await obligateService.exchangeCode(code, redirectUri);
    if (!assertion) {
      logger.warn('Obligate callback: exchange returned null — code invalid/expired or redirect_uri mismatch');
      res.redirect('/login?error=sso_failed');
      return;
    }
    logger.info({ obligateUserId: assertion.obligateUserId, username: assertion.username }, 'Obligate callback: exchange OK');
    if (!Number.isInteger(assertion.obligateUserId) || assertion.obligateUserId <= 0
      || typeof assertion.username !== 'string' || !assertion.username) {
      logger.warn({ obligateUserId: assertion.obligateUserId }, 'Obligate callback: malformed assertion (obligateUserId / username)');
      res.redirect('/login?error=sso_failed');
      return;
    }
    const obligateUserId = assertion.obligateUserId;
    // Obligate owns the platform role of its users (verified assertion)
    const platformRole: 'admin' | 'user' = assertion.role === 'admin' ? 'admin' : 'user';

    // Find or create local user.
    // The local account is resolved from OUR link records only. Obligate's
    // linkedLocalUserId is just its copy of the id we reported through
    // report-provision: it is cross-checked, never trusted on its own, so a
    // stale or rewritten value can't open a session on an unrelated local
    // account (e.g. a local admin).
    let localUserId = await obligateService.getLinkedLocalUserId(obligateUserId) ?? 0;

    if (assertion.linkedLocalUserId && assertion.linkedLocalUserId !== localUserId) {
      logger.warn(
        { obligateUserId, claimedLocalUserId: assertion.linkedLocalUserId, linkedLocalUserId: localUserId || null },
        'Obligate callback: linkedLocalUserId does not match the local SSO link — ignored',
      );
    }

    let ssoOwned = false;      // og_ account: Obligate owns its access
    let demoted = false;       // platform admin → user: other sessions end
    let reactivated = false;
    let provisioned = false;

    const existing = localUserId
      ? await db('users').where({ id: localUserId })
        .first('id', 'is_active', 'role', 'foreign_source') as { id: number; is_active: boolean; role: string; foreign_source: string | null } | undefined
      : undefined;

    if (existing) {
      ssoOwned = existing.foreign_source === 'obligate';
      // A disabled account never gets a session. For a LINKED local account
      // (not og_), that is a decision taken here: refused, nothing touched.
      if (existing.is_active === false && !ssoOwned) {
        refuseSignIn(req, res, 'account_disabled', { localUserId, obligateUserId });
        return;
      }
      // An og_ account's activity is Obligate's (it cannot be edited here):
      // Obligate only issues an assertion for an active user allowed on this
      // app, so a valid assertion re-enables an og_ account left disabled (a
      // lost 'reactivate' push, or a 'deactivate' pushed by a key holder).
      reactivated = ssoOwned && existing.is_active === false;
      demoted = existing.role === 'admin' && platformRole !== 'admin';

      const update: Record<string, unknown> = {
        role: platformRole,
        email: assertion.email,
        display_name: assertion.displayName,
        updated_at: new Date(),
      };
      if (reactivated) update.is_active = true;
      await updateUserFromAssertion(localUserId, update);
      // The session guard caches role / is_active for a few seconds
      invalidateSessionUserCache(localUserId);
      // Device-check rules saved by this user follow its admin status: re-check
      // it at the next config build.
      if (existing.role !== platformRole || reactivated) invalidateAccountableCache(localUserId);
      if (reactivated) {
        logger.info({ obligateUserId, localUserId }, 'Obligate SSO: og_ account re-enabled by a valid sign-in');
      }

      // Make sure the link row exists and points to this account (idempotent;
      // repairs accounts that were resolved through users.foreign_id)
      await db('sso_foreign_users')
        .insert({ foreign_source: 'obligate', foreign_user_id: obligateUserId, local_user_id: localUserId })
        .onConflict(['foreign_source', 'foreign_user_id'])
        .merge({ local_user_id: localUserId });
      // Repair Obligate's pointer when it drifted (missing, stale or tampered)
      if (assertion.linkedLocalUserId !== localUserId) {
        obligateService.reportProvision(obligateUserId, localUserId).catch(() => {});
      }
    } else {
      localUserId = await insertSsoUser({
        username: `og_${assertion.username}`,
        display_name: assertion.displayName || assertion.username,
        email: assertion.email,
        role: platformRole,
        is_active: true,
        foreign_source: 'obligate',
        foreign_id: obligateUserId,
      });
      ssoOwned = true;
      provisioned = true;

      await db('sso_foreign_users')
        .insert({ foreign_source: 'obligate', foreign_user_id: obligateUserId, local_user_id: localUserId })
        .onConflict(['foreign_source', 'foreign_user_id'])
        .merge({ local_user_id: localUserId });

      obligateService.reportProvision(obligateUserId, localUserId).catch(() => {});
      void auditService.log({
        userId: localUserId,
        action: 'sso.provision',
        resourceType: 'user',
        resourceId: localUserId,
        details: { obligateUserId, username: `og_${assertion.username}`, role: platformRole },
        ipAddress: clientIp(req) || null,
      });
    }

    // Tenant + team memberships from Obligate (every SSO login). For an og_
    // account, what Obligate no longer grants is removed too — never for a
    // platform admin (implicit access to every tenant).
    const isPlatformAdmin = platformRole === 'admin';
    const tenantRemoved = await applySsoMemberships(localUserId, assertion, {
      prune: ssoOwned && !isPlatformAdmin,
      isPlatformAdmin,
    });
    invalidateTenantAccessCache(localUserId);
    if (demoted || tenantRemoved) {
      // Open sessions keep their role and tenant: end them, as a local
      // demotion does. This sign-in gets a new session below.
      await killSessionsForUser(localUserId, demoted ? 'sso_role_demoted' : 'sso_tenant_access_removed');
    }

    await syncPreferences(localUserId, assertion.preferences);

    const user = await db('users').where({ id: localUserId })
      .first('username', 'is_active') as { username: string; is_active: boolean } | undefined;
    if (!user) {
      logger.warn({ localUserId, obligateUserId }, 'Obligate callback: local account vanished during sign-in');
      res.redirect('/login?error=sso_failed');
      return;
    }
    if (user.is_active === false) {
      refuseSignIn(req, res, 'account_disabled', { localUserId, obligateUserId });
      return;
    }

    // Tenant: the one requested by the source app (cross-app handoff) when
    // the user may use it, else the first membership (platform admins: the
    // first tenant). No fallback tenant: without access, no session.
    const tenantId = await pickInitialTenantId(localUserId, { isPlatformAdmin, preferredSlug: requestedSlug });
    if (tenantId === null) {
      refuseSignIn(req, res, 'no_tenant_access', { localUserId, obligateUserId });
      return;
    }
    if (requestedSlug) {
      logger.info({ userId: localUserId, slug: requestedSlug, tenantId, isPlatformAdmin }, 'Cross-app handoff: tenant resolved');
    }

    // Establish the session under a NEW id (session fixation): nothing of the
    // pre-login session is carried over (its tenant hint was consumed above).
    // regenerateSession also stamps loginAt / lastSeenAt (sessionUserGuard).
    await regenerateSession(req);
    req.session.userId = localUserId;
    req.session.username = user.username;
    // Platform role straight from the verified assertion (already written to
    // users.role above) — not re-read, so a concurrent sso-user-sync call
    // can't slip a different role into this new session.
    req.session.role = platformRole;
    req.session.currentTenantId = tenantId;

    logger.info(`Obligate SSO: user ${assertion.username} (obligate #${obligateUserId}) → local #${localUserId}`);
    void auditService.log({
      tenantId,
      userId: localUserId,
      action: 'sso.login',
      resourceType: 'user',
      resourceId: localUserId,
      details: { obligateUserId, role: platformRole, provisioned, reactivated, tenantAccessRemoved: tenantRemoved },
      ipAddress: clientIp(req) || null,
    });

    // Save session, then redirect via HTML meta refresh to ensure Set-Cookie header
    // is fully processed by the browser before navigation occurs.
    req.session.save((err) => {
      if (err) { logger.error(err, 'Session save failed'); res.redirect('/login?error=sso_failed'); return; }
      logger.info({ userId: localUserId }, 'Session saved, redirecting to /');
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#8b949e;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.s{text-align:center}.d{width:28px;height:28px;border:2.5px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:r .6s linear infinite;margin:0 auto 14px}@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class="s"><div class="d"></div><div>Signing in...</div></div></body></html>`);
    });
  } catch (err) {
    logger.error(err, 'Obligate callback error');
    res.redirect('/login?error=sso_failed');
  }
});

// The anonymous session created by /auth/sso-redirect only carries the OAuth
// state to /auth/callback (which replaces it): it expires quickly.
const PRE_AUTH_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * GET /auth/sso-redirect
 * Server-side redirect to Obligate authorize endpoint (browser redirect).
 *
 * WARNING — the client_id of this public route IS visible to anyone (it is in
 * the Location header, browser history, Referer, access logs). It is always
 * the public client id sha256(API key), never the key itself (Obligate
 * refuses the raw key as client_id). Earlier versions sent the key: a key used
 * with them must be rotated in Obligate, and until then every
 * Bearer-authenticated route of this file grants a key holder nothing beyond
 * what Obligate legitimately does (see /sso-user-sync).
 */
router.get('/sso-redirect', ssoBrowserRoute, async (req, res) => {
  try {
    const cfg = activeObligate(res);

    // Cross-app tenant handoff: the source Obli* app appends ?tenant=<slug>
    // when the user clicks the topbar switcher pill. Stashed in the session
    // (below, once every check passed) so /auth/callback can apply it once
    // the user comes back from Obligate. Validated against the same regex the
    // tenants table enforces — anything else is dropped silently
    // (defence-in-depth, untrusted query input).
    const requestedTenant = req.query.tenant;
    const tenantSlug = typeof requestedTenant === 'string' && /^[a-z0-9-]{1,64}$/.test(requestedTenant)
      ? requestedTenant
      : null;

    // Verify Obligate is reachable before redirecting (prevents redirect loop when Gate is down)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const healthRes = await fetch(`${cfg.url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!healthRes.ok) { res.redirect('/login?error=sso_failed'); return; }
    } catch {
      res.redirect('/login?error=sso_failed');
      return;
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const selfUrl = `${protocol}://${host}`;
    // Safety: never redirect to ourselves (misconfigured obligate_url pointing to this app)
    if (cfg.url.replace(/\/$/, '') === selfUrl.replace(/\/$/, '')) {
      logger.error({ obligateUrl: cfg.url, selfUrl }, 'sso-redirect: obligate_url points to this app — aborting to prevent loop');
      res.redirect('/login?error=sso_misconfigured');
      return;
    }
    const redirectUri = `${selfUrl}/auth/callback`;
    // Always the public client id sha256(API key) (it is in the Location
    // header): the API key itself never leaves the server.
    const clientId = obligateService.authorizeClientId(cfg);

    // Every check passed: only now is anything written to the session. An
    // anonymous session lives 10 minutes (the callback replaces it); a
    // signed-in one keeps its lifetime.
    if (!req.session.userId) req.session.cookie.maxAge = PRE_AUTH_SESSION_MAX_AGE_MS;
    if (tenantSlug) req.session.requestedTenantSlug = tenantSlug;
    else delete req.session.requestedTenantSlug;
    // Generate cryptographic state to prevent login CSRF (RFC 6749 §10.12)
    const oauthState = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = oauthState;

    const obligateUrl = `${cfg.url}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(oauthState)}`;
    logger.info({ obligateUrl: cfg.url, redirectUri }, 'sso-redirect: redirecting to Obligate');

    // Save session before redirecting so the state is persisted
    req.session.save((err) => {
      if (err) {
        logger.error(err, 'sso-redirect: session save failed');
        res.redirect('/login?error=sso_failed');
        return;
      }
      res.redirect(obligateUrl);
    });
  } catch {
    res.redirect('/login');
  }
});

/**
 * GET /api/auth/app-info
 * Called by Obligate (Bearer auth) to discover teams + tenants for mapping UI.
 */
router.get('/app-info', ...obligateBearerRoute, async (_req, res) => {
  try {
    // Fetch all teams across all tenants
    const teams = await db('user_teams')
      .join('tenants', 'user_teams.tenant_id', 'tenants.id')
      .select('user_teams.id', 'user_teams.name', 'tenants.slug as tenant_slug', 'tenants.name as tenant_name')
      .orderBy('tenants.name')
      .orderBy('user_teams.name') as Array<{ id: number; name: string; tenant_slug: string; tenant_name: string }>;

    // Fetch all tenants
    const tenants = await db('tenants')
      .select('id', 'name', 'slug')
      .orderBy('name') as Array<{ id: number; name: string; slug: string }>;

    // Capability checkboxes are intentionally NOT exposed here. Teams
    // already encode per-tenant rights inside this app, and having Obligate
    // display per-(app, tenant) capability checkboxes alongside the team
    // selector created two conflicting sources of truth — without a team the
    // checkboxes were meaningless (the user has no scoped access anyway), and
    // with a team they silently overwrote the team's own permissions.
    // Permission sets are listed (slug + label, like Obliance): Obligate
    // offers them as the tenant role choices, and a set it sends back is
    // stored as the user's tenant role (applySsoMemberships).
    const permissionSets = (await permissionSetService.getAll())
      .map((p) => ({ slug: p.slug, name: p.name, isDefault: p.isDefault }));
    res.json({
      success: true,
      data: {
        roles: ['admin', 'user'],
        teams: teams.map(t => ({ id: t.id, name: t.name, tenantSlug: t.tenant_slug, tenantName: t.tenant_name })),
        tenants: tenants.map(t => ({ slug: t.slug, name: t.name })),
        permissionSets,
      },
    });
  } catch (err) {
    logger.error(err, 'app-info error');
    res.status(500).json({ success: false, error: 'Failed to fetch app info' });
  }
});

/**
 * GET /api/auth/dashboard-stats
 * Called by Obligate (Bearer auth) to display stats on the Obligate dashboard.
 */
router.get('/dashboard-stats', ...obligateBearerRoute, async (_req, res) => {
  try {
    const [sites, probes, discoveredItems] = await Promise.all([
      db('sites').count('id as c').first(),
      db('probes').count('id as c').first(),
      db('site_items').count('id as c').first(),
    ]);
    res.json({ success: true, data: { stats: [
      { label: 'Sites', value: Number((sites as any)?.c ?? 0), color: '#58a6ff' },
      { label: 'Probes', value: Number((probes as any)?.c ?? 0), color: '#2ea043' },
      { label: 'Discovered Items', value: Number((discoveredItems as any)?.c ?? 0), color: '#d29922' },
    ] } });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/sso-config
 * Returns Obligate SSO config for the LoginPage (public, no auth required).
 */
router.get('/sso-config', async (_req, res) => {
  try {
    const config = await obligateService.getSsoConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false } });
  }
});

/**
 * GET /api/auth/sso-logout-url
 * Returns Obligate logout URL so the client can redirect after local logout.
 * None while SSO is disabled (a local sign-out stays local).
 */
router.get('/sso-logout-url', async (req, res) => {
  try {
    const cfg = await appConfigService.getObligateRawIfEnabled();
    if (!cfg) {
      res.json({ success: true, data: null });
      return;
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/login`;
    const logoutUrl = `${cfg.url}/logout?redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ success: true, data: logoutUrl });
  } catch {
    res.json({ success: true, data: null });
  }
});

/**
 * GET /api/auth/connected-apps
 * Returns list of connected apps from Obligate (for cross-app nav buttons).
 * Signed-in users only; authentication is checked before the SSO guard, so
 * an anonymous caller always gets 401.
 */
router.get('/connected-apps', requireAuth, ssoApiRoute, async (req, res) => {
  try {
    // Scope the app switcher to the caller's Obligate entitlements. Local
    // (non-SSO) users have no Obligate id → pass null (unfiltered fallback);
    // SSO-provisioned users get only the apps they can actually reach.
    const row = await db('users')
      .where({ id: req.session.userId })
      .select('foreign_source', 'foreign_id')
      .first() as { foreign_source: string | null; foreign_id: number | null } | undefined;
    const obligateUserId = row?.foreign_source === 'obligate' && row.foreign_id ? row.foreign_id : null;
    const apps = await obligateService.getConnectedApps(obligateUserId);
    res.json({ success: true, data: apps });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

/**
 * GET /api/auth/device-links?uuid=xxx
 * Returns cross-app links for a probe UUID via Obligate.
 * Platform admins only (the lookup is made with the app's own API key), and
 * only for a probe of this instance — never for an arbitrary UUID.
 * Authorization is checked before the SSO guard (anonymous: always 401).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get('/device-links', requireAuth, requireRole('admin'), ssoApiRoute, async (req, res) => {
  try {
    const uuid = req.query.uuid;
    if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) { res.json({ success: true, data: [] }); return; }
    const probe = await db('probes').where({ uuid }).first('id', 'uuid') as { id: number; uuid: string } | undefined;
    if (!probe) { res.json({ success: true, data: [] }); return; }
    // Identity v2: the other apps may still know this machine by one of its
    // previous UUIDs (they migrate on their own schedule) — ask for each.
    const { probeIdentityService } = await import('../services/probeIdentity.service');
    const uuids = (await probeIdentityService.allUuidsOf({ id: probe.id, uuid: String(probe.uuid) })).slice(0, 4);
    // One link per app (type + origin): the one of the CURRENT ID wins
    // (uuids[0], Promise.all keeps the order) — an app may still hold a link
    // registered under a previous ID, with an older path (Oblimap /probes/:id
    // then /manage/probes/:id).
    const seen = new Set<string>();
    const appKey = (l: { appType: string; url: string }) => {
      try { return `${l.appType}|${new URL(l.url).origin}`; } catch { return `${l.appType}|${l.url}`; }
    };
    const links = (await Promise.all(uuids.map((u) => obligateService.getDeviceLinks(u)))).flat()
      .filter((l) => { const k = appKey(l); return seen.has(k) ? false : (seen.add(k), true); });
    res.json({ success: true, data: links });
  } catch {
    res.json({ success: true, data: [] });
  }
});

// ── Obligate → app user sync ───────────────────────────────────────────────

const DB_INT_MAX = 2_147_483_647;

/** A positive integer id: a JSON number or a digit string. */
const positiveIdSchema = z.union([
  z.number().int().positive().max(DB_INT_MAX),
  z.string().regex(/^\d{1,10}$/).transform(Number).pipe(z.number().int().positive().max(DB_INT_MAX)),
]);

// Only the identities are required: an unknown action or role is answered
// 200 "ignored" — Obligate retries every other answer for 24 h.
const syncBodySchema = z.object({
  obligateUserId: positiveIdSchema,
  remoteUserId: positiveIdSchema,
});
const syncActionSchema = z.enum(['deactivate', 'reactivate', 'delete', 'update-role', 'credentials-changed']);
const syncRoleSchema = z.enum(['admin', 'user']);

type SyncUser = { id: number; username: string; role: string; is_active: boolean };

// Audit rows of calls that change nothing (ignored / unchanged / deferred
// promotion): at most one per address + outcome + reason per minute. While no
// inbound secret is set, the Bearer secret is the API key, which may be public
// (earlier versions sent it as client_id) until it is rotated, so a caller
// could otherwise grow audit_logs at will. Every state change is always
// audited.
const syncNoopAuditSeenAt = new Map<string, number>();

/**
 * The og_ account (users.foreign_source = 'obligate') that OUR link records
 * tie to this Obligate identity — its sso_foreign_users row, written by
 * /auth/callback only (or, when that row is missing, the account provisioned
 * for that identity, users.foreign_id): see getLinkedLocalUserId — provided
 * it is `localId`. Null for anything else: a local account, another SSO
 * user's account, a stale id.
 */
async function linkedSsoAccount(obligateId: number, localId: number): Promise<{ user: SyncUser | null; linkedId: number | null }> {
  const linkedId = await obligateService.getLinkedLocalUserId(obligateId);
  if (linkedId !== localId) return { user: null, linkedId };
  const user = await db('users')
    .where({ id: localId, foreign_source: 'obligate' })
    .first('id', 'username', 'role', 'is_active') as SyncUser | undefined;
  return { user: user ?? null, linkedId };
}

/**
 * POST /api/auth/sso-user-sync
 * Called by Obligate (Bearer auth) when an SSO user is deactivated,
 * reactivated, deleted, role-changed, or changed their credentials (password /
 * MFA: `credentials-changed`, with mfaEpoch).
 * Body: { obligateUserId, obligateUsername?, remoteUserId, action, role?, mfaEpoch? }
 *
 * Only ever acts on the og_ account linked to that Obligate user — never on a
 * local account. Anything else (not linked, unknown action or role) is left
 * untouched, logged, audited (throttled) and answered 200 {success:true}, so
 * Obligate's sync queue does not retry it; 400 only for missing / invalid ids.
 * There is deliberately no last-admin guard: Obligate is authoritative for
 * the accounts it provisions, and local accounts are out of reach.
 * A promotion is never applied from this call (the Bearer secret may be the
 * API key, possibly public if earlier versions sent it as client_id and it was
 * not rotated): the platform role comes from the verified assertion of the
 * next sign-in.
 */
router.post('/sso-user-sync', ...obligateBearerRoute, async (req, res) => {
  try {
    const ids = syncBodySchema.safeParse(req.body ?? {});
    if (!ids.success) {
      res.status(400).json({ success: false, error: 'Missing fields' });
      return;
    }
    const { obligateUserId: obligateId, remoteUserId: localId } = ids.data;
    const body = req.body as Record<string, unknown>;
    const requestedAction = typeof body.action === 'string' ? body.action.slice(0, 64) : null;
    const ip = clientIp(req) || null;

    const audit = (outcome: string, extra: Record<string, unknown> = {}): Promise<void> => auditService.log({
      action: 'sso.user_sync',
      resourceType: 'user',
      resourceId: localId,
      ipAddress: ip,
      details: { action: requestedAction, remoteUserId: localId, obligateUserId: obligateId, outcome, ...extra },
    });
    const auditNoop = async (outcome: string, extra: Record<string, unknown> = {}): Promise<void> => {
      const reason = typeof extra.reason === 'string' ? extra.reason : '';
      if (!firstInAuditWindow(syncNoopAuditSeenAt, `${ip ?? 'unknown'}|${outcome}|${reason}`)) return;
      await audit(outcome, extra);
    };

    const action = syncActionSchema.safeParse(body.action);
    if (!action.success) {
      logger.warn({ obligateUserId: obligateId, remoteUserId: localId, action: requestedAction },
        'SSO sync: unknown action — ignored');
      await auditNoop('ignored', { reason: 'unknown_action' });
      res.json({ success: true });
      return;
    }

    // remoteUserId is Obligate's copy of our id: act only when OUR link records
    // tie that og_ account to this Obligate user. Anything else (local-only
    // account, account of another SSO user, stale id) is left untouched and
    // answered like "done" so Obligate doesn't keep retrying.
    const { user, linkedId } = await linkedSsoAccount(obligateId, localId);
    if (!user) {
      logger.warn({ obligateUserId: obligateId, remoteUserId: localId, linkedLocalUserId: linkedId, action: action.data },
        'SSO sync: target is not the og_ account linked to this Obligate user — ignored');
      await auditNoop('ignored', { reason: 'not_linked', linkedLocalUserId: linkedId });
      res.json({ success: true });
      return;
    }

    switch (action.data) {
      case 'deactivate': {
        if (user.is_active !== false) {
          await db('users').where({ id: localId }).update({ is_active: false, updated_at: new Date() });
        }
        invalidateSessionUserCache(localId);
        invalidateAccountableCache(localId);
        await killSessionsForUser(localId, 'sso_user_deactivated');
        logger.info(`SSO sync: deactivated user #${localId}`);
        await audit('deactivated', { username: user.username });
        break;
      }
      case 'reactivate': {
        if (user.is_active === false) {
          await db('users').where({ id: localId }).update({ is_active: true, updated_at: new Date() });
          invalidateSessionUserCache(localId);
          invalidateAccountableCache(localId);
          logger.info(`SSO sync: reactivated user #${localId}`);
          await audit('reactivated', { username: user.username });
        } else {
          await auditNoop('unchanged', { username: user.username });
        }
        break;
      }
      case 'delete': {
        await db('sso_foreign_users').where({ local_user_id: localId }).del();
        await db('users').where({ id: localId }).del();
        invalidateSessionUserCache(localId);
        invalidateTenantAccessCache(localId);
        invalidateAccountableCache(localId);
        await killSessionsForUser(localId, 'sso_user_deleted');
        logger.info(`SSO sync: deleted user #${localId}`);
        await audit('deleted', { username: user.username });
        break;
      }
      case 'update-role': {
        const role = syncRoleSchema.safeParse(body.role);
        if (!role.success) {
          logger.warn({ obligateUserId: obligateId, remoteUserId: localId }, 'SSO sync: update-role without a valid role — ignored');
          await auditNoop('ignored', { reason: 'invalid_role', username: user.username });
          break;
        }
        if (role.data === 'user') {
          if (user.role === 'admin') {
            await db('users').where({ id: localId }).update({ role: 'user', updated_at: new Date() });
            invalidateSessionUserCache(localId);
            invalidateAccountableCache(localId);
            // Sessions cache the platform role and may sit on any tenant
            await killSessionsForUser(localId, 'sso_role_demoted');
            logger.info(`SSO sync: demoted user #${localId} to user`);
            await audit('demoted', { username: user.username, before: 'admin', after: 'user' });
          } else {
            await auditNoop('unchanged', { username: user.username, role: 'user' });
          }
        } else if (user.role !== 'admin') {
          logger.warn({ obligateUserId: obligateId, remoteUserId: localId },
            'SSO sync: promotion not applied — the platform role comes from the next SSO sign-in');
          await auditNoop('promotion_deferred', { username: user.username, currentRole: user.role });
        } else {
          await auditNoop('unchanged', { username: user.username, role: 'admin' });
        }
        break;
      }
      case 'credentials-changed': {
        // Password / MFA changed in Obligate: every session opened with the
        // old credentials ends (the next sign-in goes through Obligate again).
        const mfaEpoch = typeof body.mfaEpoch === 'number' && Number.isFinite(body.mfaEpoch) ? body.mfaEpoch : null;
        const count = await killSessionsForUser(localId, 'sso_credentials_changed');
        logger.info({ localUserId: localId, count }, 'SSO sync: credentials changed in Obligate — sessions ended');
        await audit('sessions_killed', { username: user.username, count, mfaEpoch });
        break;
      }
    }

    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'sso-user-sync error');
    res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

export default router;
