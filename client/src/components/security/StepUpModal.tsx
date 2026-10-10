import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import i18n from 'i18next';
import toast from 'react-hot-toast';
import { KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { cn } from '@/utils/cn';
import { apiErrorBody } from '@/utils/apiError';
import { stepUpApi, STEP_UP_PROMPT_EVENT, type StepUpMethod, type StepUpPromptDetail } from '@/api/restrictions.api';

// ── 2FA step-up dialog ─────────────────────────────────────
//
// The API client (api/client.ts) calls requestStepUp() when the server answers
// 403 step_up_required: this dialog asks for a TOTP / e-mail code, proves it
// through POST /api/auth/step-up and resolves true, and the client replays the
// refused request once. Nothing navigates (no redirect), so the flow works
// inside the ObliTools iframe (X-Auth-Token) as in a normal tab.
//
// The dialog mounts itself in its own React root on first use (no provider to
// add to App.tsx). Requests arriving while it is open share it: one proof
// settles them all.

/** English labels of the restrictable actions (server restriction.service ACTION_KEYS). */
const ACTION_LABELS: Record<string, string> = {
  'tunnel.open': 'Open a tunnel to a device',
  'device_check.credentials_set': 'Set device check credentials',
  'device_check.rule_enable': 'Enable a device check rule',
  'probe.command.uninstall': 'Uninstall a probe',
  'probe.delete': 'Delete a probe',
  'probe.key_create': 'Create a probe API key',
  'probe.key_delete': 'Delete a probe API key',
  'site.delete': 'Delete a site',
  'site.subnet_delete': 'Delete the devices of a subnet',
  'group.delete': 'Delete a group',
  'team.permissions_set': 'Change team permissions',
  // Not a restrictable action: relaxing the restrictions themselves.
  'tenant.restrictions_loosen': 'Relax the action restrictions',
};

/** Translated label of an action key (dots → underscores in the i18n key). */
export function stepUpActionLabel(t: TFunction, key: string): string {
  return t(`restrictions.actions.${key.replace(/\./g, '_')}`, ACTION_LABELS[key] ?? key);
}

export interface StepUpRequest {
  action: string;
  methods: StepUpMethod[];
}

interface PendingStepUp extends StepUpRequest {
  resolvers: Array<(ok: boolean) => void>;
}

/** Tells listeners (see STEP_UP_PROMPT_EVENT) that a step-up prompt or refusal is shown. */
function announce(detail: StepUpPromptDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<StepUpPromptDetail>(STEP_UP_PROMPT_EVENT, { detail }));
  } catch { /* no listener needed */ }
}

let pending: PendingStepUp | null = null;
let notifyHost: ((p: PendingStepUp | null) => void) | null = null;
let root: Root | null = null;

function ensureHost(): void {
  if (root) return;
  const el = document.createElement('div');
  el.setAttribute('data-step-up-host', '');
  document.body.appendChild(el);
  root = createRoot(el);
  root.render(<StepUpHost />);
}

/**
 * Opens the step-up dialog (or joins the open one). Resolves true once a
 * factor was proven, false when the user cancelled.
 */
export function requestStepUp(request: StepUpRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (pending) {
      pending.resolvers.push(resolve);
      return;
    }
    const methods = request.methods.filter((m): m is StepUpMethod => m === 'totp' || m === 'email');
    pending = { action: request.action, methods: methods.length > 0 ? methods : ['totp'], resolvers: [resolve] };
    try {
      ensureHost();
    } catch {
      const p = pending;
      pending = null;
      p.resolvers.forEach((r) => r(false));
      return;
    }
    announce({ code: 'step_up_required', action: request.action });
    notifyHost?.(pending);
  });
}

function settle(ok: boolean): void {
  const p = pending;
  pending = null;
  notifyHost?.(null);
  p?.resolvers.forEach((r) => r(ok));
}

/** Goes to the profile page through the router (no reload: works inside ObliTools). */
function openProfile(): void {
  if (window.location.pathname !== '/profile') {
    window.history.pushState({}, '', '/profile');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
}

/**
 * Toast for a step-up the user cannot complete: an SSO account without a
 * local factor, or a local account without any second factor (with a link
 * to the profile page to set one up).
 */
export function showStepUpRefusal(
  code: 'step_up_unavailable_sso' | 'step_up_setup_required',
  action: string,
  opts: { twoFactorAllowed?: boolean } = {},
): void {
  announce({ code, action });
  const t = i18n.t.bind(i18n) as TFunction;
  const label = stepUpActionLabel(t, action);
  if (code === 'step_up_unavailable_sso') {
    toast.error(t('stepUp.unavailableSso',
      '"{{action}}" requires a two-factor confirmation, which single sign-on accounts cannot give yet. Ask a workspace administrator.',
      { action: label }), { id: `step-up:${code}:${action}`, duration: 8000 });
    return;
  }
  if (opts.twoFactorAllowed === false) {
    // The platform policy forbids enrolling a factor: the profile cannot help.
    toast.error(t('stepUp.setupUnavailable',
      '"{{action}}" requires a two-factor confirmation, but two-factor authentication is disabled on this platform. Ask an administrator.',
      { action: label }), { id: `step-up:${code}:${action}`, duration: 10000 });
    return;
  }
  toast.error((tt) => (
    <span className="text-sm">
      {t('stepUp.setupRequired',
        '"{{action}}" requires a two-factor confirmation. Set up an authenticator app or e-mail codes in your profile first.',
        { action: label })}
      {' '}
      <button
        type="button"
        className="font-medium text-accent underline"
        onClick={() => { toast.dismiss(tt.id); openProfile(); }}
      >
        {t('stepUp.openProfile', 'Open my profile')}
      </button>
    </span>
  ), { id: `step-up:${code}:${action}`, duration: 10000 });
}

function StepUpHost() {
  const [request, setRequest] = useState<PendingStepUp | null>(pending);
  useEffect(() => {
    notifyHost = setRequest;
    setRequest(pending);
    return () => { if (notifyHost === setRequest) notifyHost = null; };
  }, []);
  if (!request) return null;
  // Keyed: a new request starts with a fresh form.
  return <StepUpDialog key={`${request.action}:${request.methods.join(',')}`} request={request} />;
}

const ERROR_FALLBACKS: Record<string, string> = {
  invalid_code: 'Invalid code',
  code_replayed: 'This code was already used. Wait for the next code.',
  code_expired: 'This code expired. Request a new code.',
  no_code_pending: 'Request a code first',
  method_unavailable: 'This verification method is not available for your account',
  resend_cooldown: 'Please wait a minute before requesting a new code',
  send_failed: 'The code could not be sent. Try again later.',
};

function errorText(t: TFunction, err: unknown): string {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  const code = apiErrorBody(err)?.error;
  if (typeof code === 'string' && ERROR_FALLBACKS[code]) return t(`stepUp.errors.${code}`, ERROR_FALLBACKS[code]);
  if (status === 429) return t('stepUp.errors.tooMany', 'Too many attempts. Try again later.');
  return t('stepUp.errors.generic', 'The verification failed. Try again.');
}

function StepUpDialog({ request }: { request: PendingStepUp }) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<StepUpMethod>(request.methods[0]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, [method]);

  const valid = /^\d{6}$/.test(code);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await stepUpApi.verify(method, code);
      settle(true);
    } catch (err) {
      setError(errorText(t, err));
      setCode('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function sendEmail() {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const { sentTo: to } = await stepUpApi.sendEmail();
      setSentTo(to);
      inputRef.current?.focus();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setSending(false);
    }
  }

  const methodTabs: Array<{ id: StepUpMethod; label: string; icon: JSX.Element }> = [
    { id: 'totp', label: t('stepUp.methodTotp', 'Authenticator app'), icon: <KeyRound size={14} /> },
    { id: 'email', label: t('stepUp.methodEmail', 'E-mail code'), icon: <Mail size={14} /> },
  ];
  const offered = methodTabs.filter((m) => request.methods.includes(m.id));

  return (
    <Modal
      open
      onClose={() => { if (!busy) settle(false); }}
      title={t('stepUp.title', 'Confirm it is you')}
      icon={<ShieldCheck className="h-4 w-4 text-accent" />}
      size="sm"
      phoneLayout="center"
      closeOnBackdrop={false}
      footer={(
        <>
          <Button variant="secondary" onClick={() => settle(false)} disabled={busy}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => { void submit(); }} disabled={!valid} loading={busy}>
            {t('stepUp.confirm', 'Confirm')}
          </Button>
        </>
      )}
    >
      <form onSubmit={(e) => { void submit(e); }} className="space-y-4">
        <p className="text-sm text-text-secondary">
          {t('stepUp.message',
            '"{{action}}" is a protected action in this workspace. Enter a two-factor code to continue.',
            { action: stepUpActionLabel(t, request.action) })}
        </p>

        {offered.length > 1 && (
          <div role="radiogroup" aria-label={t('stepUp.method', 'Verification method')} className="flex gap-1 rounded-lg bg-bg-tertiary p-1">
            {offered.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={method === m.id}
                onClick={() => { setMethod(m.id); setCode(''); setError(null); }}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  method === m.id ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary',
                )}
              >
                {m.icon}
                {m.label}
              </button>
            ))}
          </div>
        )}

        {method === 'email' && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => { void sendEmail(); }} loading={sending}>
              {sentTo ? t('stepUp.resendCode', 'Send a new code') : t('stepUp.sendCode', 'Send me a code')}
            </Button>
            {sentTo && (
              <span className="text-xs text-text-muted">
                {t('stepUp.codeSent', 'Code sent to {{email}}', { email: sentTo })}
              </span>
            )}
          </div>
        )}

        <div className="space-y-1">
          <label htmlFor="step-up-code" className="block text-sm font-medium text-text-secondary">
            {method === 'totp'
              ? t('stepUp.totpLabel', 'Code from your authenticator app')
              : t('stepUp.emailLabel', 'Code received by e-mail')}
          </label>
          <input
            ref={inputRef}
            id="step-up-code"
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            aria-invalid={error !== null}
            className={cn(
              'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-center font-mono text-lg tracking-[0.4em] text-text-primary',
              'placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent',
              error && 'border-status-down focus:ring-status-down',
            )}
          />
          {error && <p role="alert" className="text-xs text-status-down">{error}</p>}
        </div>

        <p className="text-xs text-text-muted">
          {t('stepUp.validity', 'Once confirmed, protected actions need no new code for 5 minutes.')}
        </p>
        {/* Enter submits */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
