import { appConfigService } from './appConfig.service';
import {
  permissionSetService,
  LEGACY_MEMBER_ROLE,
  LEGACY_MEMBER_SET,
  PERMISSION_SET_SLUG_RE,
  TENANT_ADMIN_ROLE,
} from './permissionSet.service';
import { logger } from '../utils/logger';
import { safeEqualSecret } from '../utils/safeCompare';
import { sha256Hex } from '../utils/timingSafe';
import { db } from '../db';

/** Oblimap's brand accent (theme --c-accent 141 198 63), announced to Obligate. */
export const APP_ACCENT_COLOR = '#8DC63F';

/**
 * Public OAuth client id of this app for Obligate: lowercase hex SHA-256 of
 * the API key. Cross-repo contract with Obligate (publicClientId() in its
 * app.service.ts) — change it on both sides or not at all.
 */
export function obligatePublicClientId(apiKey: string): string {
  return sha256Hex(apiKey);
}

export interface ObligateUserAssertion {
  obligateUserId: number;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
  tenants: Array<{ slug: string; role: string; capabilities?: string[] }>;
  teams: string[];
  capabilities?: string[];
  authSource: 'local' | 'ldap';
  linkedLocalUserId: number | null;
  preferences?: {
    preferredTheme?: string;
    toastEnabled?: boolean;
    toastPosition?: string;
    profilePhotoUrl?: string | null;
    preferredLanguage?: string;
    anonymousMode?: boolean;
    appSpecific?: Record<string, string>;
  };
}

export const obligateService = {
  /**
   * Check if Obligate is configured and reachable.
   * "Enabled" is the SSO routes' own view (enabled + URL + API key, see
   * getObligateRawIfEnabled): the login page must not auto-redirect to
   * /auth/sso-redirect when that route would answer sso_disabled.
   */
  async getSsoConfig(): Promise<{ obligateUrl: string | null; obligateReachable: boolean; obligateEnabled: boolean }> {
    const cfg = await appConfigService.getObligateRawIfEnabled();
    if (!cfg) {
      return { obligateUrl: null, obligateReachable: false, obligateEnabled: false };
    }

    // Quick reachability check (2s timeout)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${cfg.url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return { obligateUrl: cfg.url, obligateReachable: res.ok, obligateEnabled: true };
    } catch {
      return { obligateUrl: cfg.url, obligateReachable: false, obligateEnabled: true };
    }
  },

  /**
   * Authenticate a server-to-server call made by Obligate to this app
   * (`Authorization: Bearer <secret>`): app-info, dashboard-stats,
   * sso-user-sync.
   *
   * The expected secret is the distinct inbound secret when one is set
   * (setting or OBLIGATE_INBOUND_SECRET), else the API key (today's wire
   * behaviour). Constant-time (SHA-256 digests + timingSafeEqual), and fails
   * closed when SSO is disabled or nothing is configured.
   *
   * The client_id is now always the public id sha256(API key), but earlier
   * versions sent the API key itself in the /auth/sso-redirect Location
   * header: until the key is rotated and while no inbound secret is set, it
   * must be treated as possibly public, so these routes never grant more than
   * a key holder may do — see /sso-user-sync.
   */
  async verifyInboundBearer(authHeader: string | undefined): Promise<boolean> {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
    const cfg = await appConfigService.getObligateRawIfEnabled();
    if (!cfg) return false;
    return safeEqualSecret(authHeader.slice(7), cfg.inboundSecret ?? cfg.apiKey);
  },

  /**
   * client_id for the browser-facing /authorize URL (it goes through the
   * browser: Location header, history, Referer, access logs — it is PUBLIC):
   * always obligatePublicClientId(apiKey), so the key never leaves the
   * server. Obligate refuses the raw API key as client_id.
   */
  authorizeClientId(cfg: { apiKey: string }): string {
    return obligatePublicClientId(cfg.apiKey);
  },

  /**
   * Resolve the local account linked to an Obligate identity, from OUR records
   * only: the sso_foreign_users row of that identity (pointing to an account
   * provisioned by the SSO callback), or — for an account whose link row is
   * missing — the account created for that identity (users.foreign_id).
   *
   * Obligate's `linkedLocalUserId` / `remoteUserId` must never be trusted on
   * their own: they are only Obligate's copy of what we reported through
   * report-provision, and can be stale or rewritten by any holder of the API key.
   * Returns null when no local account is linked.
   */
  async getLinkedLocalUserId(obligateUserId: number): Promise<number | null> {
    if (!Number.isInteger(obligateUserId) || obligateUserId <= 0) return null;

    const link = await db('sso_foreign_users as l')
      .join('users as u', 'u.id', 'l.local_user_id')
      .where({ 'l.foreign_source': 'obligate', 'l.foreign_user_id': obligateUserId, 'u.foreign_source': 'obligate' })
      .first('u.id') as { id: number } | undefined;
    if (link) return link.id;

    const provisioned = await db('users')
      .where({ foreign_source: 'obligate', foreign_id: obligateUserId })
      .orderBy('id', 'desc')
      .first('id') as { id: number } | undefined;
    return provisioned?.id ?? null;
  },

  /**
   * Exchange an authorization code with Obligate for user info.
   */
  async exchangeCode(code: string, redirectUri: string): Promise<ObligateUserAssertion | null> {
    // Refused while SSO is disabled, even for a code obtained before
    const raw = await appConfigService.getObligateRawIfEnabled();
    if (!raw) {
      logger.warn('Obligate exchange refused: SSO disabled or not configured');
      return null;
    }

    try {
      const res = await fetch(`${raw.url}/api/oauth/token/exchange`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${raw.apiKey}`,
        },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
      });

      if (!res.ok) {
        logger.warn(`Obligate exchange failed: HTTP ${res.status}`);
        return null;
      }

      const data = await res.json() as { success: boolean; data?: ObligateUserAssertion };
      if (!data.success || !data.data) return null;

      return data.data;
    } catch (err) {
      logger.error(err, 'Obligate exchange error');
      return null;
    }
  },

  /**
   * Report a provisioned user back to Obligate.
   */
  async reportProvision(obligateUserId: number, remoteUserId: number): Promise<void> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      await fetch(`${raw.url}/api/apps/report-provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${raw.apiKey}`,
        },
        body: JSON.stringify({ obligateUserId, remoteUserId }),
      });
    } catch (err) {
      logger.error(err, 'Failed to report provision to Obligate');
    }
  },

  /**
   * Tenant role of an Obligate assertion (`tenants[].role`) → the tenant role
   * stored here (user_tenants.role, a permission set slug).
   *
   * Obligate's vocabulary for a tenant role is the app's permission set slugs
   * (offered through app-info when it lists them), else its own fallback
   * 'admin' / 'user' / 'viewer' — the slugs of the sets seeded here. Mapping:
   *   'admin'                          → 'admin'  (tenant admin: every capability)
   *   slug of an existing set          → that slug ('user', 'viewer', 'operator', custom)
   *   'member' (legacy)                → 'viewer' (what it was read as)
   *   missing / malformed / unknown    → 'viewer' (least privilege)
   * The role says WHAT the user may do in the tenant; WHERE stays with the
   * team memberships Obligate grants (assertion.teams). The platform role
   * (users.role) never comes from here: only from the assertion's app-wide
   * `role` ('admin' = "All tenants" admin in Obligate).
   */
  async resolveTenantRole(role: unknown): Promise<string> {
    if (typeof role !== 'string') return LEGACY_MEMBER_SET;
    const slug = role.trim().toLowerCase();
    if (slug === TENANT_ADMIN_ROLE) return slug;
    if (slug === LEGACY_MEMBER_ROLE) return LEGACY_MEMBER_SET;
    if (!PERMISSION_SET_SLUG_RE.test(slug)) return LEGACY_MEMBER_SET;
    return (await permissionSetService.getBySlug(slug)) ? slug : LEGACY_MEMBER_SET;
  },

  /**
   * Register a device UUID + path with Obligate for cross-app linking.
   * Throttled: only calls Obligate once every 10 minutes per UUID.
   * Failed attempts don't update the throttle so the next push retries.
   */
  _linkThrottle: new Map<string, number>(),
  async registerDeviceLink(uuid: string, appPath: string): Promise<void> {
    const now = Date.now();
    if (now - (this._linkThrottle.get(uuid) ?? 0) < 10 * 60 * 1000) return;

    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      const res = await fetch(`${raw.url}/api/devices/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${raw.apiKey}`,
        },
        body: JSON.stringify({ uuid, path: appPath }),
      });
      if (res.ok) this._linkThrottle.set(uuid, now);
    } catch { /* non-critical — will retry on next push */ }
  },

  /**
   * Get cross-app links for a device UUID from Obligate.
   */
  async getDeviceLinks(uuid: string): Promise<Array<{ appType: string; name: string; url: string; icon: string | null; color: string | null }>> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return [];

    try {
      const res = await fetch(`${raw.url}/api/devices/links?uuid=${encodeURIComponent(uuid)}`, {
        headers: { 'Authorization': `Bearer ${raw.apiKey}` },
      });
      if (!res.ok) return [];
      const data = await res.json() as { success: boolean; data?: Array<{ appType: string; name: string; url: string; icon: string | null; color: string | null }> };
      return data.data ?? [];
    } catch {
      return [];
    }
  },

  /**
   * Fetch latest preferences from Obligate and sync to local DB.
   * Throttled: once per 60s per user. Runs in background, never throws.
   */
  _prefThrottle: new Map<number, number>(),
  async syncUserPreferences(localUserId: number, obligateUserId: number): Promise<void> {
    const now = Date.now();
    if (now - (this._prefThrottle.get(localUserId) ?? 0) < 60 * 1000) return;

    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      const res = await fetch(`${raw.url}/api/apps/user-preferences/${obligateUserId}`, {
        headers: { 'Authorization': `Bearer ${raw.apiKey}` },
      });
      if (!res.ok) return;
      this._prefThrottle.set(localUserId, now);

      const { success, data } = await res.json() as { success: boolean; data?: {
        preferredTheme?: string; toastEnabled?: boolean; toastPosition?: string;
        preferredLanguage?: string; anonymousMode?: boolean; profilePhotoUrl?: string | null;
      } };
      if (!success || !data) return;

      // Sync language + avatar columns
      const colUpdate: Record<string, unknown> = {};
      if (data.preferredLanguage) colUpdate.preferred_language = data.preferredLanguage;
      if (data.profilePhotoUrl !== undefined) colUpdate.avatar = data.profilePhotoUrl;
      if (Object.keys(colUpdate).length > 0) {
        await db('users').where({ id: localUserId }).update(colUpdate);
      }

      // Sync UI prefs into preferences JSON
      const uiPrefs: Record<string, unknown> = {};
      if (data.preferredTheme) uiPrefs.preferredTheme = data.preferredTheme;
      if (data.toastEnabled !== undefined) uiPrefs.toastEnabled = data.toastEnabled;
      if (data.toastPosition) uiPrefs.toastPosition = data.toastPosition;
      if (data.anonymousMode !== undefined) uiPrefs.anonymousMode = data.anonymousMode;
      if (Object.keys(uiPrefs).length > 0) {
        const row = await db('users').where({ id: localUserId }).select('preferences').first() as { preferences: unknown } | undefined;
        const existing = (typeof row?.preferences === 'string' ? JSON.parse(row.preferences) : row?.preferences) ?? {};
        await db('users').where({ id: localUserId }).update({
          preferences: JSON.stringify({ ...existing, ...uiPrefs }),
        });
      }
    } catch { /* non-critical */ }
  },

  /**
   * Get the list of connected apps from Obligate (for cross-app nav buttons).
   */
  async getConnectedApps(
    obligateUserId?: number | null,
  ): Promise<Array<{ appType: string; name: string; baseUrl: string; icon: string; color: string | null; self?: true; thirdParty?: boolean }>> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return [];

    // Scope to the user's Obligate entitlements when we know who they are.
    // Without the userId, Obligate returns EVERY connected app, so the
    // header app switcher would show apps the user has no access to.
    const url = obligateUserId
      ? `${raw.url}/api/apps/connected?userId=${encodeURIComponent(obligateUserId)}`
      : `${raw.url}/api/apps/connected`;
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${raw.apiKey}` },
      });
      if (!res.ok) return [];
      // Already sorted by Obligate (its own display order); `self: true` marks
      // this Oblimap instance's own entry (resolved from the Bearer key), so
      // the header doesn't need to guess which registered app is "us".
      const data = await res.json() as { success: boolean; data?: Array<{ appType: string; name: string; baseUrl: string; icon: string; color: string | null; self?: true; thirdParty?: boolean }> };
      return data.data ?? [];
    } catch {
      return [];
    }
  },

  /**
   * Announce Oblimap's own branding to Obligate (POST /api/apps/self-info):
   * Obligate stores it as this app's accent color and every switcher of the
   * suite shows it — nothing to set by hand when the app is registered.
   * Best-effort: no Obligate configured → nothing; failure → warn only.
   */
  async announceSelfInfo(): Promise<void> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;
    try {
      const res = await fetch(`${raw.url}/api/apps/self-info`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${raw.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: APP_ACCENT_COLOR }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) logger.warn(`Obligate self-info announce failed: HTTP ${res.status}`);
    } catch (err) {
      logger.warn({ err }, 'Obligate self-info announce failed');
    }
  },
};
