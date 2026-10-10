import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User, Save, KeyRound, Bell, CheckCircle2, AlertTriangle, QrCode, Mail, ArrowLeftRight, Palette, LogOut, ExternalLink } from 'lucide-react';
import { profileApi, type ProfileUpdate } from '@/api/profile.api';
import { ThemePicker } from '@/components/ThemePicker';
import { applyTheme, loadSavedTheme, type AppTheme } from '@/utils/theme';
import { appConfigApi } from '@/api/appConfig.api';
import { twoFactorApi, type TwoFactorStatus, type FactorProof } from '@/api/twoFactor.api';
import { useAuthStore } from '@/store/authStore';
import { useLiveAlertsStore } from '@/store/liveAlertsStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { PageContainer } from '@/components/common/PageContainer';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { SUPPORTED_LANGUAGES, setLanguage } from '@/i18n';
import { apiErrorBody, apiErrorMessage as serverMessage, isHandled } from '@/utils/apiError';
import { openExternal } from '@/utils/openExternal';
import toast from 'react-hot-toast';

// Minimum length of the server-side password policy (server/src/validators/password.ts).
const PASSWORD_MIN_LENGTH = 10;

/** The server's message for a failed request (first validation issue, else `error`), or the fallback. */
function apiErrorMessage(err: unknown, fallback: string): string {
  return serverMessage(err, fallback);
}

/** toast.error with the server's message, unless the API client already reported the error. */
function toastError(err: unknown, fallback: string): void {
  if (isHandled(err)) return;
  toast.error(apiErrorMessage(err, fallback));
}

function apiErrorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

/**
 * Inline prompt for the proof a sensitive change needs: a current code of the
 * authenticator app, or the current password.
 */
function ProofPrompt({
  kind, hint, value, loading, confirmLabel, onChange, onConfirm, onCancel,
}: {
  kind: 'code' | 'password';
  hint: string;
  value: string;
  loading: boolean;
  confirmLabel: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">{hint}</p>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          {kind === 'code' ? (
            <Input
              label={t('profile.security.currentCodeLabel', 'Current authenticator code')}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={value}
              onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              autoFocus
            />
          ) : (
            <Input
              label={t('profile.password.current')}
              type="password"
              autoComplete="current-password"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              autoFocus
            />
          )}
        </div>
        <Button
          disabled={loading || (kind === 'code' ? value.length !== 6 : value.length === 0)}
          loading={loading}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}

export function ProfilePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user: sessionUser, requires2faSetup, checkSession } = useAuthStore();
  const [obligateUrl, setObligateUrl] = useState<string | null>(null);
  // SSO (Obligate) account: its password, username, e-mail address and 2FA
  // are Obligate's. The app-local sections (sessions, appearance, alerts) stay.
  const isSso = sessionUser?.foreignSource === 'obligate';

  // Forced password change (bootstrapped admin, reset by an administrator).
  const mustChangePassword = searchParams.get('mustChange') === '1' || sessionUser?.mustChangePassword === true;

  useEffect(() => {
    if (!isSso) return;
    appConfigApi.getConfig().then(cfg => {
      const raw = cfg as unknown as { obligate_url?: unknown; obligateUrl?: unknown };
      const url = raw.obligate_url ?? raw.obligateUrl;
      setObligateUrl(typeof url === 'string' && url ? url.replace(/\/$/, '') : null);
    }).catch(() => {});
  }, [isSso]);
  const { localEnabled: alertEnabled, position: alertPosition, setEnabled, setPosition } = useLiveAlertsStore();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [originalEmail, setOriginalEmail] = useState('');
  const [hasPassword, setHasPassword] = useState(true);
  const [emailProof, setEmailProof] = useState('');
  const [preferredLanguage, setPreferredLanguage] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [revokingSessions, setRevokingSessions] = useState(false);

  const [savingPrefs, setSavingPrefs] = useState(false);

  // Theme state — initialise from localStorage so the picker shows the active theme immediately
  const [preferredTheme, setPreferredTheme] = useState<AppTheme>(loadSavedTheme);
  const [savingTheme, setSavingTheme] = useState(false);

  // 2FA state
  const [allow2fa, setAllow2fa] = useState(false);
  const [tfaStatus, setTfaStatus] = useState<TwoFactorStatus | null>(null);

  // TOTP setup flow (first setup, or replacement after the current code)
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpSaving, setTotpSaving] = useState(false);
  // First setup: asks the current password first. Replace / disable a live
  // TOTP: asks a current code first.
  const [totpAction, setTotpAction] = useState<null | 'setup' | 'replace' | 'disable'>(null);
  const [totpProof, setTotpProof] = useState('');

  // Email OTP flow: 'proof' = confirm with code / password, 'sent' = enter the mailed code
  const [emailSetupStep, setEmailSetupStep] = useState<'idle' | 'proof' | 'sent'>('idle');
  const [emailOtpProof, setEmailOtpProof] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailDisableOpen, setEmailDisableOpen] = useState(false);

  // Proof for e-mail codes: the authenticator code when one is set up, else the password.
  const factorProofKind: 'code' | 'password' = tfaStatus?.totpEnabled ? 'code' : 'password';
  const factorProof = (v: string): FactorProof => (factorProofKind === 'code' ? { currentCode: v } : { currentPassword: v });

  const normalizedEmail = (v: string) => v.trim().toLowerCase();
  const emailChanged = normalizedEmail(email) !== normalizedEmail(originalEmail);

  useEffect(() => {
    profileApi.get().then((profile) => {
      setDisplayName(profile.displayName || '');
      setEmail(profile.email || '');
      setOriginalEmail(profile.email || '');
      setHasPassword(profile.hasPassword !== false);
      setPreferredLanguage(profile.preferredLanguage || '');
      if (profile.preferences?.preferredTheme) {
        setPreferredTheme(profile.preferences.preferredTheme);
      }
    });
    appConfigApi.getConfig().then((cfg) => {
      setAllow2fa(cfg.allow_2fa ?? false);
    }).catch(() => {});
    twoFactorApi.getStatus().then(setTfaStatus).catch(() => {});
  }, []);

  const factorErrorMessage = (err: unknown, fallback: string) => {
    if (apiErrorBody(err)?.error === 'factor_required') {
      return t('profile.security.factorRequired', 'Two-factor authentication is required: enable another method before removing this one.');
    }
    return apiErrorMessage(err, fallback);
  };
  const toastFactorError = (err: unknown, fallback: string) => {
    if (isHandled(err)) return;
    toast.error(factorErrorMessage(err, fallback));
  };

  const handleProfileSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (emailChanged && !emailProof) {
      toast.error(hasPassword
        ? t('profile.emailChangeNeedsPassword', 'Enter your current password to change your e-mail address.')
        : t('profile.emailChangeNeedsCode', 'Enter a current authenticator code to change your e-mail address.'));
      return;
    }
    setSavingProfile(true);
    try {
      const payload: ProfileUpdate = { displayName: displayName || null, preferredLanguage: preferredLanguage || undefined };
      if (emailChanged) {
        payload.email = email.trim() || null;
        if (hasPassword) payload.currentPassword = emailProof;
        else payload.currentCode = emailProof;
      }
      const updated = await profileApi.update(payload);
      setEmail(updated.email || '');
      setOriginalEmail(updated.email || '');
      setEmailProof('');
      if (emailChanged) {
        // E-mail codes are turned off when the address changes.
        twoFactorApi.getStatus().then(setTfaStatus).catch(() => {});
        setEmailSetupStep('idle');
      }
      toast.success(t('profile.profileUpdated'));
    } catch (err) {
      if (apiErrorStatus(err) === 409) {
        toast.error(t('profile.emailUnavailable', 'This e-mail address is unavailable.'));
      } else {
        toastError(err, t('profile.failedProfile'));
      }
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error(t('profile.password.mismatch'));
      return;
    }

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      toast.error(t('profile.password.tooShortMin', { defaultValue: 'Password must be at least {{count}} characters.', count: PASSWORD_MIN_LENGTH }));
      return;
    }

    setSavingPassword(true);
    try {
      await profileApi.changePassword(currentPassword, newPassword);
      toast.success(t('profile.password.changed'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      if (mustChangePassword) {
        // Refresh the session user (mustChangePassword is now false) and continue.
        await checkSession();
        navigate('/', { replace: true });
      }
    } catch (err: unknown) {
      toastError(err, t('profile.password.failed'));
    } finally {
      setSavingPassword(false);
    }
  };

  const handleRevokeOtherSessions = async () => {
    setRevokingSessions(true);
    try {
      const count = await profileApi.revokeOtherSessions();
      toast.success(t('profile.sessions.revoked', { defaultValue: 'Other sessions signed out: {{count}}', count }));
    } catch (err) {
      toastError(err, t('profile.sessions.failed', 'Could not sign out the other sessions.'));
    } finally {
      setRevokingSessions(false);
    }
  };

  const handleSavePreferences = async () => {
    setSavingPrefs(true);
    try {
      await profileApi.update({
        preferences: {
          toastEnabled: alertEnabled,
          toastPosition: alertPosition,
        },
      });
      toast.success(t('profile.alerts.preferencesSaved'));
    } catch (err) {
      toastError(err, t('profile.alerts.failedPreferences'));
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleThemeChange = async (theme: AppTheme) => {
    setPreferredTheme(theme);
    applyTheme(theme); // apply immediately for live preview
    setSavingTheme(true);
    try {
      await profileApi.update({
        preferences: {
          toastEnabled: alertEnabled,
          toastPosition: alertPosition,
          preferredTheme: theme,
        },
      });
      toast.success(t('profile.appearance.saved'));
    } catch (err) {
      toastError(err, t('profile.appearance.failed'));
    } finally {
      setSavingTheme(false);
    }
  };

  const handleLanguageChange = async (code: string) => {
    setPreferredLanguage(code);
    setLanguage(code);
    try {
      await profileApi.update({ preferredLanguage: code });
    } catch {
      // non-critical, ignore
    }
  };

  const handleTotpProofConfirm = async () => {
    setTotpSaving(true);
    try {
      if (totpAction === 'disable') {
        await twoFactorApi.totpDisable(totpProof);
        setTfaStatus((s) => s ? { ...s, totpEnabled: false } : s);
        toast.success(t('profile.security.totpDisabled'));
      } else if (totpAction === 'replace' || totpAction === 'setup') {
        const data = await twoFactorApi.totpSetup(totpAction === 'replace'
          ? { currentCode: totpProof }
          : { currentPassword: totpProof });
        setTotpSetupData(data);
        setTotpCode('');
      }
      setTotpAction(null);
      setTotpProof('');
    } catch (err) {
      toastFactorError(err, totpAction === 'disable' ? t('profile.security.failedDisableTotp') : t('profile.security.failedStartTotp'));
    } finally {
      setTotpSaving(false);
    }
  };

  const closeEmailSetup = () => {
    setEmailSetupStep('idle');
    setEmailOtpProof('');
    setEmailCode('');
  };

  const obligateAccountUrl = obligateUrl ? `${obligateUrl}/account` : null;

  return (
    <PageContainer title={t('profile.title')}>
      {/* SSO account: identity, password, e-mail and 2FA are managed by Obligate */}
      {isSso && (
        <div className="mb-8 rounded-xl bg-bg-secondary p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 min-w-0">
              <ArrowLeftRight size={18} className="text-accent mt-0.5 shrink-0" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('profile.sso.title', 'Profile managed by Obligate')}
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {t('profile.sso.description', 'Your username, password, e-mail address and two-factor authentication are managed centrally through Obligate SSO. The sessions and preferences below belong to this application.')}
                </p>
              </div>
            </div>
            {obligateAccountUrl && (
              <a
                href={obligateAccountUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { e.preventDefault(); void openExternal(obligateAccountUrl); }}
                className="inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2 coarse:py-3 bg-accent hover:bg-accent-hover text-white rounded-md font-medium text-sm transition-colors"
              >
                <ExternalLink size={14} />
                {t('profile.sso.openLink', 'Open Obligate profile')}
              </a>
            )}
          </div>
        </div>
      )}

      {mustChangePassword && (
        <div className="mb-6 flex items-start gap-3 rounded-xl bg-amber-500/10 p-4">
          <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-300">
            {t('profile.password.mustChangeBanner', 'You must change your password before you can continue using the application.')}
          </p>
        </div>
      )}

      {/* Profile section */}
      <form onSubmit={handleProfileSubmit} className="mb-8">
        <div className="rounded-xl bg-bg-secondary p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <User size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.sectionProfile')}
            </h2>
          </div>

          {!isSso && (
            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">{t('profile.usernameLabel')}</label>
              <div className="flex items-center gap-2">
                <p className="text-sm text-text-primary font-mono bg-bg-tertiary rounded-md px-3 py-2 flex-1">
                  {sessionUser?.username}
                </p>
                {sessionUser?.foreignSource && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#1e1b4b]/60 px-2 py-1 text-[10px] font-medium text-[#a5b4fc] shrink-0">
                    <ArrowLeftRight size={9} />
                    {t('profile.ssoBadge', 'SSO · {{source}}', { source: sessionUser.foreignSource })}
                  </span>
                )}
              </div>
            </div>
          )}

          <Input
            label={t('profile.displayNameLabel')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('profile.displayNamePlaceholder')}
          />

          {!isSso && (
            <div>
              <Input
                label={t('profile.emailLabel')}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('profile.emailPlaceholder')}
              />
              <p className="mt-1 text-xs text-text-muted">{t('profile.emailHint')}</p>
            </div>
          )}

          {!isSso && emailChanged && (
            // The e-mail address is the password-reset channel: changing it needs a proof.
            <div className="space-y-1">
              {hasPassword ? (
                <Input
                  label={t('profile.emailChangePasswordLabel', 'Current password (required to change your e-mail address)')}
                  type="password"
                  autoComplete="current-password"
                  value={emailProof}
                  onChange={(e) => setEmailProof(e.target.value)}
                />
              ) : (
                <Input
                  label={t('profile.emailChangeCodeLabel', 'Current authenticator code (required to change your e-mail address)')}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={emailProof}
                  onChange={(e) => setEmailProof(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                />
              )}
              <p className="text-xs text-text-muted">
                {t('profile.emailChangeHint', 'Sign-in codes by e-mail are turned off when the address changes; a notice is sent to the previous address.')}
              </p>
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">{t('profile.preferredLanguage')}</label>
            <select
              value={preferredLanguage}
              onChange={(e) => handleLanguageChange(e.target.value)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeName} ({lang.name})
                </option>
              ))}
            </select>
          </div>

          <Button type="submit" loading={savingProfile}>
            <Save size={16} className="mr-1.5" />
            {t('profile.saveProfile')}
          </Button>
        </div>
      </form>

      {/* Password section */}
      {!isSso && (
        <form onSubmit={handlePasswordSubmit} className="mb-8">
          <div className={`rounded-xl bg-bg-secondary p-5 space-y-4 ${mustChangePassword ? 'ring-1 ring-amber-500/50' : ''}`}>
            <div className="flex items-center gap-2 mb-2">
              <KeyRound size={18} className="text-accent" />
              <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                {t('profile.password.title')}
              </h2>
            </div>

            <Input
              label={t('profile.password.current')}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder={t('profile.password.currentPlaceholder')}
              required
            />

            <div>
              <Input
                label={t('profile.password.new')}
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t('profile.password.newPlaceholder')}
                required
              />
              <p className="mt-1 text-xs text-text-muted">
                {t('profile.password.policyHint', { defaultValue: 'At least {{count}} characters; avoid common passwords and your username.', count: PASSWORD_MIN_LENGTH })}
              </p>
            </div>

            <Input
              label={t('profile.password.confirm')}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t('profile.password.confirmPlaceholder')}
              required
            />

            <p className="text-xs text-text-muted">
              {t('profile.password.othersSignedOut', 'Your other sessions are signed out when the password changes.')}
            </p>

            <Button type="submit" loading={savingPassword}>
              <KeyRound size={16} className="mr-1.5" />
              {t('profile.password.change')}
            </Button>
          </div>
        </form>
      )}

      {/* Sessions section */}
      <div className="mb-8">
        <div className="rounded-xl bg-bg-secondary p-5 space-y-3">
          <div className="flex items-center gap-2 mb-2">
            <LogOut size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.sessions.title', 'Sessions')}
            </h2>
          </div>
          <p className="text-xs text-text-muted">
            {t('profile.sessions.desc', 'Sign out every other browser or device signed in to your account. This session stays open.')}
          </p>
          <Button type="button" variant="secondary" onClick={handleRevokeOtherSessions} loading={revokingSessions}>
            <LogOut size={16} className="mr-1.5" />
            {t('profile.sessions.revokeOthers', 'Sign out other sessions')}
          </Button>
        </div>
      </div>

      {/* Appearance section */}
      <div className="mb-8">
        <div className="rounded-xl bg-bg-secondary p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Palette size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.appearance.title')}
            </h2>
            {savingTheme && (
              <span className="ml-auto text-xs text-text-muted">{t('common.saving')}</span>
            )}
          </div>
          <p className="text-xs text-text-muted -mt-2">{t('profile.appearance.subtitle')}</p>
          <ThemePicker value={preferredTheme} onChange={handleThemeChange} />
        </div>
      </div>

      {/* Live Alert Notifications section */}
      <div className="mb-8">
        <div className="rounded-xl bg-bg-secondary p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Bell size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.alerts.title')}
            </h2>
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">{t('profile.alerts.enableLabel')}</p>
              <p className="text-xs text-text-muted mt-0.5">
                {t('profile.alerts.enableDesc')}
              </p>
            </div>
            <ToggleSwitch
              checked={alertEnabled}
              onChange={(v) => setEnabled(v)}
              ariaLabel={t('profile.alerts.enableLabel')}
            />
          </div>

          {/* Position selector */}
          <div>
            <p className="text-sm font-medium text-text-primary mb-2">{t('profile.alerts.positionLabel')}</p>
            <div className="flex flex-col gap-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="alertPosition"
                  value="bottom-right"
                  checked={alertPosition === 'bottom-right'}
                  onChange={() => setPosition('bottom-right')}
                  className="accent-accent mt-0.5"
                />
                <div>
                  <span className="text-sm text-text-primary">{t('profile.alerts.bottomRight')}</span>
                  <p className="text-xs text-text-muted">
                    {t('profile.alerts.bottomRightDesc')}
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="alertPosition"
                  value="top-center"
                  checked={alertPosition === 'top-center'}
                  onChange={() => setPosition('top-center')}
                  className="accent-accent mt-0.5"
                />
                <div>
                  <span className="text-sm text-text-primary">{t('profile.alerts.topCenter')}</span>
                  <p className="text-xs text-text-muted">
                    {t('profile.alerts.topCenterDesc')}
                  </p>
                </div>
              </label>
            </div>
          </div>

          <Button type="button" onClick={handleSavePreferences} loading={savingPrefs}>
            <Save size={16} className="mr-1.5" />
            {t('profile.alerts.savePreferences')}
          </Button>
        </div>
      </div>

      {/* Security / 2FA section */}
      {!isSso && (allow2fa || requires2faSetup) && (
        <div>
          <h2 className="text-lg font-semibold text-text-primary mb-4">{t('profile.security.title')}</h2>

          {requires2faSetup && (
            <div className="mb-4 flex items-start gap-3 rounded-xl bg-amber-500/10 p-4">
              <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-300">
                {t('profile.security.force2faWarning')}
              </p>
            </div>
          )}

          <div className="rounded-xl bg-bg-secondary divide-y divide-border">
            {/* TOTP */}
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <QrCode size={16} className="text-text-muted" />
                  <p className="text-sm font-medium text-text-primary">{t('profile.security.totp')}</p>
                  {tfaStatus?.totpEnabled && <CheckCircle2 size={14} className="text-green-400" />}
                </div>
                {tfaStatus?.totpEnabled ? (
                  !totpAction && !totpSetupData && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => { setTotpAction('replace'); setTotpProof(''); }}>
                        {t('profile.security.replace', 'Replace')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setTotpAction('disable'); setTotpProof(''); }}>
                        {t('common.disable')}
                      </Button>
                    </div>
                  )
                ) : !totpSetupData && !totpAction ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      // The first authenticator app needs the current password.
                      if (hasPassword) { setTotpAction('setup'); setTotpProof(''); return; }
                      // No local password: the server explains why it refuses.
                      try {
                        const data = await twoFactorApi.totpSetup({});
                        setTotpSetupData(data);
                        setTotpCode('');
                      } catch (err) { toastError(err, t('profile.security.failedStartTotp')); }
                    }}
                  >
                    {t('common.enable')}
                  </Button>
                ) : null}
              </div>

              {!tfaStatus?.totpEnabled && totpAction === 'setup' && (
                <ProofPrompt
                  kind="password"
                  hint={t('profile.security.totpSetupProof', 'Enter your current password to set up an authenticator app.')}
                  value={totpProof}
                  loading={totpSaving}
                  confirmLabel={t('common.confirm')}
                  onChange={setTotpProof}
                  onConfirm={handleTotpProofConfirm}
                  onCancel={() => { setTotpAction(null); setTotpProof(''); }}
                />
              )}

              {tfaStatus?.totpEnabled && totpAction && totpAction !== 'setup' && (
                <ProofPrompt
                  kind="code"
                  hint={totpAction === 'disable'
                    ? t('profile.security.totpDisableProof', 'Enter a current code from your authenticator app to disable it.')
                    : t('profile.security.totpReplaceProof', 'Enter a current code from your authenticator app to replace it.')}
                  value={totpProof}
                  loading={totpSaving}
                  confirmLabel={t('common.confirm')}
                  onChange={setTotpProof}
                  onConfirm={handleTotpProofConfirm}
                  onCancel={() => { setTotpAction(null); setTotpProof(''); }}
                />
              )}

              {totpSetupData && (
                <div className="space-y-3">
                  <p className="text-xs text-text-muted">{t('profile.security.totpScanDesc')}</p>
                  <img src={totpSetupData.qrDataUrl} alt={t('profile.security.totpQrAlt', 'Authenticator QR code')} className="w-40 h-40 rounded-lg" />
                  <p className="text-xs text-text-muted font-mono break-all">{t('profile.security.totpSecret', { secret: totpSetupData.secret })}</p>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Input
                        label={t('profile.security.verificationCode')}
                        type="text"
                        inputMode="numeric"
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="000000"
                      />
                    </div>
                    <Button
                      disabled={totpCode.length !== 6 || totpSaving}
                      loading={totpSaving}
                      onClick={async () => {
                        setTotpSaving(true);
                        try {
                          await twoFactorApi.totpEnable(totpCode);
                          setTfaStatus((s) => s ? { ...s, totpEnabled: true } : s);
                          setTotpSetupData(null);
                          setTotpCode('');
                          toast.success(t('profile.security.totpEnabled'));
                        } catch (err) { toastError(err, t('profile.security.invalidCode')); }
                        finally { setTotpSaving(false); }
                      }}
                    >
                      {t('common.confirm')}
                    </Button>
                    <Button variant="ghost" onClick={() => { setTotpSetupData(null); setTotpCode(''); }}>{t('common.cancel')}</Button>
                  </div>
                </div>
              )}
            </div>

            {/* Email OTP */}
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Mail size={16} className="text-text-muted" />
                  <p className="text-sm font-medium text-text-primary">{t('profile.security.emailOtp')}</p>
                  {tfaStatus?.emailOtpEnabled && (
                    <>
                      <CheckCircle2 size={14} className="text-green-400" />
                      <span className="text-xs text-text-muted">{tfaStatus.email}</span>
                    </>
                  )}
                </div>
                {tfaStatus?.emailOtpEnabled ? (
                  !emailDisableOpen && (
                    <Button size="sm" variant="ghost" onClick={() => { setEmailDisableOpen(true); setEmailOtpProof(''); }}>
                      {t('common.disable')}
                    </Button>
                  )
                ) : emailSetupStep === 'idle' ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      // Codes go to the profile address only: set it (and save) first.
                      if (!originalEmail) {
                        toast.error(t('profile.security.emailRequiredFirst', 'Set an e-mail address in your profile first.'));
                        return;
                      }
                      setEmailOtpProof('');
                      setEmailSetupStep('proof');
                    }}
                  >
                    {t('common.enable')}
                  </Button>
                ) : null}
              </div>

              {tfaStatus?.emailOtpEnabled && emailDisableOpen && (
                <ProofPrompt
                  kind={factorProofKind}
                  hint={factorProofKind === 'code'
                    ? t('profile.security.emailDisableProofCode', 'Enter a current code from your authenticator app to disable e-mail codes.')
                    : t('profile.security.emailDisableProofPassword', 'Enter your current password to disable e-mail codes.')}
                  value={emailOtpProof}
                  loading={emailSaving}
                  confirmLabel={t('common.confirm')}
                  onChange={setEmailOtpProof}
                  onConfirm={async () => {
                    setEmailSaving(true);
                    try {
                      await twoFactorApi.emailDisable(factorProof(emailOtpProof));
                      setTfaStatus((s) => s ? { ...s, emailOtpEnabled: false } : s);
                      setEmailDisableOpen(false);
                      setEmailOtpProof('');
                      toast.success(t('profile.security.emailOtpDisabled'));
                    } catch (err) { toastFactorError(err, t('profile.security.failedDisableEmailOtp')); }
                    finally { setEmailSaving(false); }
                  }}
                  onCancel={() => { setEmailDisableOpen(false); setEmailOtpProof(''); }}
                />
              )}

              {!tfaStatus?.emailOtpEnabled && emailSetupStep === 'proof' && (
                <ProofPrompt
                  kind={factorProofKind}
                  hint={factorProofKind === 'code'
                    ? t('profile.security.emailSetupProofCode', {
                        defaultValue: 'Codes will be sent to {{email}}. Enter a current code from your authenticator app to continue.',
                        email: originalEmail,
                      })
                    : t('profile.security.emailSetupProofPassword', {
                        defaultValue: 'Codes will be sent to {{email}}. Enter your current password to continue.',
                        email: originalEmail,
                      })}
                  value={emailOtpProof}
                  loading={emailSaving}
                  confirmLabel={t('profile.security.sendCode')}
                  onChange={setEmailOtpProof}
                  onConfirm={async () => {
                    setEmailSaving(true);
                    try {
                      await twoFactorApi.emailSetup(factorProof(emailOtpProof));
                      setEmailOtpProof('');
                      setEmailSetupStep('sent');
                      toast.success(t('profile.security.codeSent'));
                    } catch (err) { toastError(err, t('profile.security.failedSendCode')); }
                    finally { setEmailSaving(false); }
                  }}
                  onCancel={closeEmailSetup}
                />
              )}

              {!tfaStatus?.emailOtpEnabled && emailSetupStep === 'sent' && (
                <div className="space-y-3">
                  <p className="text-xs text-text-muted">{t('profile.security.enterCode', { email: originalEmail })}</p>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Input
                        label={t('profile.security.verificationCode')}
                        type="text"
                        inputMode="numeric"
                        value={emailCode}
                        onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="000000"
                        autoFocus
                      />
                    </div>
                    <Button
                      disabled={emailCode.length !== 6 || emailSaving}
                      loading={emailSaving}
                      onClick={async () => {
                        setEmailSaving(true);
                        try {
                          await twoFactorApi.emailEnable(emailCode);
                          const status = await twoFactorApi.getStatus();
                          setTfaStatus(status);
                          closeEmailSetup();
                          toast.success(t('profile.security.emailOtpEnabled'));
                        } catch (err) { toastError(err, t('profile.security.invalidCode')); }
                        finally { setEmailSaving(false); }
                      }}
                    >
                      {t('common.confirm')}
                    </Button>
                    <Button variant="ghost" onClick={closeEmailSetup}>{t('common.cancel')}</Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
