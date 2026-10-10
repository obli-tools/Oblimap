import axios, { type AxiosError } from 'axios';
import toast from 'react-hot-toast';
import i18n from 'i18next';
import { markHandled } from '../utils/apiError';

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * A 401 on this request is an expected answer (e.g. the login page asking
     * whether a session exists): never redirect to /login for it.
     */
    skipAuthRedirect?: boolean;
    /** Internal: this request is the replay after a 2FA step-up (never prompted twice). */
    stepUpReplayed?: boolean;
  }
}

// Detect ObliTools iframe/native-app context.
// True when running inside the ObliTools desktop shell (cross-site iframe).
// The browser blocks every cookie in that context, so the session id returned
// by the login (sessionToken) is sent back as the X-Auth-Token header instead
// — ONLY there: a normal browser tab relies on the httpOnly session cookie
// alone and never stores or sends the token.
export const isInObliTools = (() => {
  try { return window !== window.top; } catch { return true; }
})() || !!(window as { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

export const OBLITOOLS_TOKEN_KEY = 'oblitools_auth_token';

/** The ObliTools session token (null outside ObliTools, or when there is none). */
export function getObliToolsToken(): string | null {
  if (!isInObliTools) return null;
  try { return sessionStorage.getItem(OBLITOOLS_TOKEN_KEY); } catch { return null; }
}

/** Stores (or, with null, forgets) the ObliTools session token. No-op outside ObliTools. */
export function setObliToolsToken(token: string | null | undefined): void {
  try {
    if (isInObliTools && token) sessionStorage.setItem(OBLITOOLS_TOKEN_KEY, token);
    else sessionStorage.removeItem(OBLITOOLS_TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

/** Absolute URLs (another origin) never receive the token. */
function isAbsoluteUrl(url: string | undefined): boolean {
  return !!url && /^([a-z][a-z0-9+.-]*:)?\/\//i.test(url);
}

const apiClient = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: inject X-Auth-Token when running in ObliTools.
apiClient.interceptors.request.use((config) => {
  const token = getObliToolsToken();
  if (token && !isAbsoluteUrl(config.url) && !isAbsoluteUrl(config.baseURL)) {
    config.headers['X-Auth-Token'] = token;
  }
  return config;
});

// Server-side account policy (password to change, 2FA to set up): every API
// call outside the profile answers 403 with one of these codes until the user
// complies — send them to the page where they can.
const POLICY_REDIRECTS: Record<string, string> = {
  password_change_required: '/profile?mustChange=1',
  '2fa_setup_required': '/profile?setup2fa=1',
};
// Pages where the user complies: never redirected away from. The enrollment
// page changes the password and sets up 2FA too, and ProtectedRoute sends an
// unenrolled user back to it from /profile — redirecting from there would loop.
const POLICY_PAGES = new Set(['/profile', '/enroll']);
let policyRedirecting = false;

// A refused mutation for lack of a tenant capability (403 {error:'forbidden',
// capability}) means the client's view of the permissions is stale: refetch
// them, at most once per 10 s.
const PERMISSIONS_REFRESH_INTERVAL_MS = 10_000;
let lastPermissionsRefresh = 0;

function refreshPermissionsSoon(): void {
  const now = Date.now();
  if (now - lastPermissionsRefresh < PERMISSIONS_REFRESH_INTERVAL_MS) return;
  lastPermissionsRefresh = now;
  // Lazy imports: the stores import this module. The tenant list carries
  // the tenant role (tenant-admin status), the permissions the capabilities.
  import('../store/tenantStore')
    .then(({ useTenantStore }) => useTenantStore.getState().fetchTenants())
    .catch(() => { /* the next refresh catches up */ });
  import('../store/authStore')
    .then(({ useAuthStore }) => useAuthStore.getState().refreshPermissions())
    .catch(() => { /* the next refresh catches up */ });
}

// 2FA step-up (server middleware/stepUp.ts): an action the tenant
// marks sensitive answers 403 with one of these codes when the session has
// not proven a second factor in the last 5 minutes.
const STEP_UP_CODES = new Set(['step_up_required', 'step_up_unavailable_sso', 'step_up_setup_required']);

/**
 * step_up_required: the step-up dialog asks for a code (in-page, no
 * redirect: works inside the ObliTools iframe), then the refused request is
 * replayed once. Cancelled → the original error, marked handled (call sites
 * skip their toast). The two other codes: a translated toast, error handled.
 */
async function handleStepUp(
  error: AxiosError,
  code: string,
  data: { action?: unknown; methods?: unknown; twoFactorAllowed?: unknown },
): Promise<unknown> {
  const action = typeof data.action === 'string' ? data.action : '';
  let modal: typeof import('../components/security/StepUpModal');
  try {
    // Lazy import: the dialog imports the API modules, which import this one.
    modal = await import('../components/security/StepUpModal');
  } catch {
    throw error;
  }
  if (code === 'step_up_required') {
    const config = error.config;
    if (!config || config.stepUpReplayed) throw error;
    const methods = (Array.isArray(data.methods) ? data.methods : [])
      .filter((m): m is 'totp' | 'email' => m === 'totp' || m === 'email');
    const proven = await modal.requestStepUp({ action, methods });
    if (!proven) {
      markHandled(error);
      throw error;
    }
    return apiClient.request({ ...config, stepUpReplayed: true });
  }
  modal.showStepUpRefusal(code as 'step_up_unavailable_sso' | 'step_up_setup_required', action, {
    twoFactorAllowed: data.twoFactorAllowed === false ? false : undefined,
  });
  markHandled(error);
  throw error;
}

// Response interceptor: on 401, clear stale token (ObliTools) or redirect to login (normal).
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    if (status === 403) {
      const data = error.response?.data as { error?: unknown; action?: unknown; methods?: unknown; twoFactorAllowed?: unknown } | undefined;
      if (typeof data?.error === 'string' && STEP_UP_CODES.has(data.error)) {
        return handleStepUp(error as AxiosError, data.error, data);
      }
    }
    if (status === 401) {
      if (isInObliTools) {
        // Don't redirect — just clear the stale token so the next login stores a fresh one.
        setObliToolsToken(null);
      } else if (window.location.pathname !== '/login' && !error.config?.skipAuthRedirect) {
        window.location.href = '/login';
      }
    } else if (status === 403) {
      const data = error.response?.data as { error?: unknown; capability?: unknown } | undefined;
      const code = data?.error;
      const target = typeof code === 'string' ? POLICY_REDIRECTS[code] : undefined;
      const method = String(error.config?.method ?? 'get').toLowerCase();
      if (target) {
        // Already on the profile or enrollment page: stay (no redirect loop).
        if (!policyRedirecting && !POLICY_PAGES.has(window.location.pathname.replace(/(.)\/+$/, '$1'))) {
          policyRedirecting = true;
          window.location.assign(target);
        }
      } else if (code === 'forbidden' && method !== 'get') {
        // Missing tenant capability on a mutation: say which one (call sites
        // skip their own toast through isHandled) and refetch the
        // permissions so the UI hides what the user can no longer do. The
        // request is never retried. `capability` is a string, or a list for
        // the any-of gate.
        const raw = data?.capability;
        const caps = (Array.isArray(raw) ? raw : [raw])
          .filter((c): c is string => typeof c === 'string' && c.length > 0);
        if (caps.length > 0) {
          // Short capability names of the permission sets tab (dots → underscores in the key).
          const label = caps
            .map((cap) => i18n.t(`permissionSets.capName.${cap.replace(/\./g, '_')}`, cap))
            .join(' / ');
          toast.error(i18n.t('errors.missingCapability', 'This action needs the "{{capability}}" permission', {
            capability: label,
          }), { id: `missing-capability:${caps.join(',')}` });
          markHandled(error);
          refreshPermissionsSoon();
        }
      }
    }
    return Promise.reject(error);
  },
);

export default apiClient;
