import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { twoFactorApi } from '@/api/twoFactor.api';
import apiClient from '@/api/client';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Logo } from '@/components/Logo';

type Step = 'credentials' | '2fa';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login, isLoading, checkSession } = useAuthStore();
  const [searchParams] = useSearchParams();

  // ?error=… set by the server (SSO callback, account / tenant checks).
  const errorParam = searchParams.get('error');

  /** Human message for a machine-readable error code (query string or API), null when unknown. */
  const describeError = (code: string | null | undefined): string | null => {
    switch (code) {
      case 'sso_failed': return t('login.errors.ssoFailed', 'SSO authentication failed. Please try local login.');
      case 'sso_disabled': return t('login.errors.ssoDisabled', 'Single sign-on (Obligate) is disabled. Sign in with your local account.');
      case 'sso_misconfigured': return t('login.errors.ssoMisconfigured', 'Single sign-on (Obligate) is not configured correctly. Sign in with your local account.');
      case 'account_disabled': return t('login.errors.accountDisabled', 'Your account is disabled. Contact an administrator.');
      case 'no_tenant_access': return t('login.errors.noTenantAccess', 'Your account has no workspace assigned. Contact an administrator.');
      case 'use_sso': return t('login.errors.useSso', 'This account signs in through Obligate (SSO). Use the single sign-on.');
      case 'restart_login': return t('login.errors.restartLogin', 'Too many wrong codes, or the sign-in expired. Please sign in again.');
      default: return null;
    }
  };

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(describeError(errorParam) ?? '');
  const [showSsoLink, setShowSsoLink] = useState(false);
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  // Any ?error=… comes back from a failed sign-in: never auto-redirect to
  // Obligate again (loop). Only sso_failed keeps polling for Obligate.
  const ssoFailed = errorParam === 'sso_failed' || errorParam === 'sso_misconfigured';

  const [step, setStep] = useState<Step>('credentials');
  const [mfaMethods, setMfaMethods] = useState<{ totp: boolean; email: boolean }>({ totp: false, email: false });
  const [mfaTab, setMfaTab] = useState<'totp' | 'email'>('totp');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaNotice, setMfaNotice] = useState('');

  // SSO state: 'checking' = initial check, 'redirecting' = going to Obligate,
  // 'unavailable' = Obligate down (show local login + warning), 'local' = no Obligate configured
  const [ssoState, setSsoState] = useState<'checking' | 'redirecting' | 'unavailable' | 'local'>(
    ssoFailed ? 'unavailable' : errorParam ? 'local' : 'checking',
  );

  const checkSso = () => {
    return fetch('/api/auth/sso-config')
      .then(r => r.json())
      .then((data: { success: boolean; data?: { obligateUrl: string | null; obligateReachable: boolean; obligateEnabled: boolean } }) => {
        if (data.success && data.data?.obligateEnabled && data.data.obligateUrl) {
          if (data.data.obligateReachable) {
            // Anti-loop: if we redirected to SSO less than 15s ago and ended up back here, Gate is broken
            const lastRedirect = sessionStorage.getItem('_sso_redirect_ts');
            if (lastRedirect && Date.now() - parseInt(lastRedirect) < 15000) {
              setSsoState('unavailable');
              return 'unavailable';
            }
            sessionStorage.setItem('_sso_redirect_ts', String(Date.now()));
            setSsoState('redirecting');
            window.location.href = '/auth/sso-redirect';
            return 'redirected';
          }
          setSsoState('unavailable');
          return 'unavailable';
        }
        setSsoState('local');
        return 'local';
      })
      .catch(() => { setSsoState('unavailable'); return 'unavailable'; });
  };

  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then((data: { version?: string }) => setServerVersion(data.version ?? null))
      .catch(() => {});

    // Check existing session first — through apiClient so that inside
    // ObliTools the X-Auth-Token header is sent (cookies are blocked there);
    // the expected 401 never redirects.
    const noSession = () => {
      // No session — check Obligate unless we come back from a failed sign-in
      if (!errorParam) checkSso();
      else setSsoState(ssoFailed ? 'unavailable' : 'local');
    };
    apiClient.get<{ success?: boolean }>('/auth/me', { skipAuthRedirect: true })
      .then(({ data: d }) => {
        if (d?.success) { navigate('/', { replace: true }); return; }
        noSession();
      })
      .catch((err: unknown) => {
        // An HTTP answer (401…) is the plain "no session"; a network failure
        // keeps the previous behaviour (check Obligate unless coming back from an error).
        if ((err as { response?: unknown })?.response) noSession();
        else if (!errorParam) checkSso();
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll Obligate every 60s when unavailable — redirect as soon as it comes back
  useEffect(() => {
    if (ssoState !== 'unavailable') return;
    const interval = setInterval(() => {
      checkSso();
    }, 60_000);
    return () => clearInterval(interval);
  }, [ssoState]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Axios error → { status, code } (code = the server's `error` field). */
  const readApiError = (err: unknown): { status?: number; code: string } => {
    const axiosErr = err as { response?: { status?: number; data?: { error?: string } } };
    return { status: axiosErr?.response?.status, code: axiosErr?.response?.data?.error ?? '' };
  };

  const backToCredentials = (message: string) => {
    setError(message);
    setMfaCode('');
    setMfaNotice('');
    setStep('credentials');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setShowSsoLink(false);
    try {
      const result = await login(username, password);
      if (result.requires2fa) {
        setMfaMethods(result.methods);
        setMfaTab(result.methods.totp ? 'totp' : 'email');
        setMfaCode('');
        setMfaNotice('');
        setStep('2fa');
      } else {
        navigate('/', { replace: true });
      }
    } catch (err) {
      // The auth store rethrows the server's `error` field as the message.
      const message = err instanceof Error ? err.message : '';
      setShowSsoLink(message === 'use_sso' && ssoState !== 'local');
      setError(describeError(message) ?? (message || t('login.loginFailed')));
    }
  };

  const handleMfaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setMfaNotice('');
    setMfaLoading(true);
    try {
      await twoFactorApi.verify(mfaCode, mfaTab);
      await checkSession();
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const { status, code } = readApiError(err);
      if (code === 'restart_login' || code === 'no_tenant_access') {
        backToCredentials(describeError(code) ?? '');
      } else if (status === 400 && code.toLowerCase().includes('pending')) {
        // Session was lost between login and 2FA verify (e.g. server restart)
        backToCredentials(t('login.twoFactor.sessionExpired'));
      } else if (status === 429) {
        setError(t('login.twoFactor.tooManyAttempts', 'Too many attempts. Please wait a few minutes and try again.'));
      } else {
        setError(t('login.twoFactor.invalidCode'));
      }
    } finally {
      setMfaLoading(false);
    }
  };

  const handleResendEmail = async () => {
    setError('');
    setMfaNotice('');
    try {
      await twoFactorApi.resendEmail();
      setMfaNotice(t('login.twoFactor.resent', 'A new code was sent.'));
    } catch (err: unknown) {
      const { status, code } = readApiError(err);
      if (code === 'restart_login') {
        backToCredentials(describeError(code) ?? '');
      } else if (status === 429) {
        setError(t('login.twoFactor.resendWait', 'Please wait before requesting a new code.'));
      } else {
        setError(t('login.twoFactor.resendFailed'));
      }
    }
  };

  // While checking or redirecting, show a minimal loading screen — never flash the local login form
  if (ssoState === 'checking' || ssoState === 'redirecting') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <div className="text-center">
          <Logo className="mx-auto h-24 w-24 mb-3 animate-pulse" />
          <p className="text-sm text-text-secondary">
            {ssoState === 'redirecting' ? t('login.ssoRedirecting', 'Redirecting to login...') : t('login.ssoChecking', 'Checking authentication...')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm space-y-8 relative">
        <div className="text-center">
          <Logo className="mx-auto h-24 w-24 mb-3" />
          <p className="mt-2 text-sm text-text-secondary">{t('login.title')}</p>
        </div>

        {ssoState === 'unavailable' && (
          <div className="bg-status-pending-bg border border-status-pending/30 rounded-lg p-3 text-sm text-status-pending">
            {t('login.ssoUnavailable', 'Centralized login (Obligate) is unavailable. Using local authentication.')}
          </div>
        )}

        {step === 'credentials' ? (
          <form onSubmit={handleSubmit} className="space-y-6 rounded-xl bg-bg-secondary p-6 shadow-[var(--shadow-card)]">
            <Input
              label={t('login.username')}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('login.usernamePlaceholder')}
              autoComplete="username"
              autoFocus
              required
            />
            <Input
              label={t('login.password')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.passwordPlaceholder')}
              autoComplete="current-password"
              required
            />
            {error && (
              <div className="rounded-md bg-status-down-bg border border-status-down/30 p-3">
                <p className="text-sm text-status-down">{error}</p>
                {showSsoLink && (
                  <a href="/auth/sso-redirect" className="mt-2 inline-block text-sm font-medium text-accent hover:underline">
                    {t('login.signInWithSso', 'Sign in with SSO')}
                  </a>
                )}
              </div>
            )}
            <Button type="submit" className="w-full" loading={isLoading}>
              {t('login.signIn')}
            </Button>
            <div className="text-center">
              <Link to="/forgot-password" className="text-xs text-text-muted hover:text-text-primary transition-colors">
                {t('login.forgotPassword')}
              </Link>
            </div>
          </form>
        ) : (
          <form onSubmit={handleMfaSubmit} className="space-y-5 rounded-xl bg-bg-secondary p-6 shadow-[var(--shadow-card)]">
            <div>
              <p className="text-sm font-medium text-text-primary mb-1">{t('login.twoFactor.title')}</p>
              <p className="text-xs text-text-muted">{t('login.twoFactor.description')}</p>
            </div>

            {mfaMethods.totp && mfaMethods.email && (
              <div className="flex rounded-md bg-bg-tertiary overflow-hidden text-sm">
                <button
                  type="button"
                  onClick={() => setMfaTab('totp')}
                  className={`flex-1 py-1.5 transition-colors ${mfaTab === 'totp' ? 'bg-primary text-white' : 'text-text-secondary hover:bg-bg-hover'}`}
                >
                  {t('login.twoFactor.tabTotp')}
                </button>
                <button
                  type="button"
                  onClick={() => setMfaTab('email')}
                  className={`flex-1 py-1.5 transition-colors ${mfaTab === 'email' ? 'bg-primary text-white' : 'text-text-secondary hover:bg-bg-hover'}`}
                >
                  {t('login.twoFactor.tabEmail')}
                </button>
              </div>
            )}

            {mfaTab === 'email' && (
              <p className="text-xs text-text-muted">{t('login.twoFactor.emailSent')}</p>
            )}

            <Input
              label={mfaTab === 'totp' ? t('login.twoFactor.totpLabel') : t('login.twoFactor.emailLabel')}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={t('login.twoFactor.codePlaceholder')}
              autoFocus
              required
            />

            {error && (
              <div className="rounded-md bg-status-down-bg border border-status-down/30 p-3">
                <p className="text-sm text-status-down">{error}</p>
              </div>
            )}
            {mfaNotice && !error && (
              <p className="text-xs text-status-up">{mfaNotice}</p>
            )}

            <div className="flex flex-col gap-2">
              <Button type="submit" className="w-full" loading={mfaLoading}>{t('login.twoFactor.verify')}</Button>
              {mfaTab === 'email' && (
                <button type="button" onClick={handleResendEmail} className="text-xs text-text-muted hover:text-text-primary text-center">
                  {t('login.twoFactor.resend')}
                </button>
              )}
              <button type="button" onClick={() => { setStep('credentials'); setError(''); setMfaNotice(''); }} className="text-xs text-text-muted hover:text-text-primary text-center">
                {t('login.twoFactor.backToLogin')}
              </button>
            </div>
          </form>
        )}
      </div>

      <p className="fixed bottom-3 left-0 right-0 text-center text-xs text-text-secondary/50 select-none">
        {t('login.clientVersion', { version: __APP_VERSION__ })}
        {serverVersion && ` · ${t('login.serverVersion', { version: serverVersion })}`}
      </p>
    </div>
  );
}
