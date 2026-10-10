import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { LoadError } from '@/components/common/LoadError';
import { cn } from '@/utils/cn';
import { toastApiError, apiErrorMessage } from '@/utils/apiError';
import {
  restrictionsApi,
  RESTRICTION_ACTION_KEYS,
  type RestrictionLevel,
} from '@/api/restrictions.api';
import { appConfigApi } from '@/api/appConfig.api';
import { stepUpActionLabel } from './StepUpModal';

// ── Restrictions matrix (ported from Obliance RestrictionsTab) ──
//
// One row per restrictable action with a none / sensitive switch. 'Sensitive'
// asks the acting user for a fresh two-factor code (valid 5 minutes) before
// the action runs. Obliance's 'restricted' level (second-admin approval) and
// per-device scopes are not available yet. Tenant admins and platform admins
// only (server GET / PUT /api/tenant/restrictions).

const LEVELS: readonly RestrictionLevel[] = ['none', 'sensitive'];

/** Display groups of the actions (keys of RESTRICTION_ACTION_KEYS). */
const CATEGORIES: Array<{ id: string; fallback: string; keys: readonly string[] }> = [
  { id: 'tunnels', fallback: 'Tunnels', keys: ['tunnel.open'] },
  { id: 'probes', fallback: 'Probes', keys: ['probe.command.uninstall', 'probe.delete', 'probe.key_create', 'probe.key_delete'] },
  { id: 'sites', fallback: 'Sites and groups', keys: ['site.delete', 'site.subnet_delete', 'group.delete'] },
  { id: 'deviceChecks', fallback: 'Device checks', keys: ['device_check.credentials_set', 'device_check.rule_enable'] },
  { id: 'teams', fallback: 'Teams', keys: ['team.permissions_set'] },
];

type LevelMap = Record<string, RestrictionLevel>;

function toMap(entries: Array<{ key: string; level: RestrictionLevel }>): LevelMap {
  const map: LevelMap = {};
  for (const key of RESTRICTION_ACTION_KEYS) map[key] = 'none';
  for (const e of entries) map[e.key] = e.level === 'sensitive' ? 'sensitive' : 'none';
  return map;
}

export function RestrictionsPanel() {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<LevelMap | null>(null);
  const [draft, setDraft] = useState<LevelMap>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Keys the server listed in its last answer: only those are sent back (an
  // older server does not know every key of this client).
  const [serverKeys, setServerKeys] = useState<string[]>([]);
  // Platform 2FA policy: false when users without a factor cannot enrol one.
  const [twoFactorAllowed, setTwoFactorAllowed] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const entries = await restrictionsApi.get();
      const map = toMap(entries);
      setServerKeys(entries.map((e) => e.key));
      setSaved(map);
      setDraft(map);
    } catch (err) {
      setLoadError(apiErrorMessage(err, t('restrictions.loadFailed', 'Failed to load the restrictions')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let alive = true;
    appConfigApi.getConfig()
      .then((cfg) => { if (alive) setTwoFactorAllowed(!!(cfg.allow_2fa || cfg.force_2fa)); })
      .catch(() => { /* the warning stays hidden */ });
    return () => { alive = false; };
  }, []);

  // Keys the server returned that this client does not know (newer server): listed under "Other".
  const extraKeys = useMemo(
    () => Object.keys(draft).filter((k) => !(RESTRICTION_ACTION_KEYS as readonly string[]).includes(k)),
    [draft],
  );
  const categories = useMemo(
    () => extraKeys.length > 0
      ? [...CATEGORIES, { id: 'other', fallback: 'Other', keys: extraKeys }]
      : CATEGORIES,
    [extraKeys],
  );

  const dirty = saved !== null && Object.keys(draft).some((k) => draft[k] !== saved[k]);
  const sensitiveCount = Object.values(draft).filter((l) => l === 'sensitive').length;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const payload: LevelMap = {};
      for (const key of serverKeys) payload[key] = draft[key] ?? 'none';
      const entries = await restrictionsApi.save(payload);
      const map = toMap(entries);
      setServerKeys(entries.map((e) => e.key));
      setSaved(map);
      setDraft(map);
      toast.success(t('restrictions.saved', 'Restrictions saved'));
    } catch (err) {
      toastApiError(err, t('restrictions.saveFailed', 'Failed to save the restrictions'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-12"><LoadingSpinner /></div>;
  }
  if (loadError || !saved) {
    return <LoadError message={loadError ?? undefined} onRetry={() => { void load(); }} />;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1 rounded-lg bg-bg-secondary p-3 text-xs text-text-muted">
        <p>
          <strong className="text-text-primary">{t('restrictions.level.none', 'None')}</strong>
          {' = '}
          {t('restrictions.noneHint', 'no extra check (default).')}
          {' '}
          <strong className="text-orange-400">{t('restrictions.level.sensitive', 'Sensitive')}</strong>
          {' = '}
          {t('restrictions.sensitiveHint',
            'the acting user must enter a two-factor code (authenticator app or e-mail code) before the action runs. A confirmed code covers the protected actions for 5 minutes. Users without a second factor are asked to set one up in their profile.')}
        </p>
        <p>
          {t('restrictions.everyoneHint', 'Applies to every member of this workspace, administrators included.')}
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-orange-400/10 p-3 text-xs text-orange-400">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          {t('restrictions.ssoWarning',
            'Single sign-on (Obligate) accounts cannot confirm with their identity provider yet: unless they set up a local authenticator app, they will be refused every action marked sensitive.')}
        </p>
      </div>

      {twoFactorAllowed === false && (
        <div className="flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-xs text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {t('restrictions.twoFactorDisabledWarning',
              'Two-factor authentication is disabled on this platform: users who do not already have a second factor cannot set one up, so they will be refused every action marked sensitive. Ask a platform administrator to allow two-factor authentication first.')}
          </p>
        </div>
      )}

      {categories.map((cat) => (
        <div key={cat.id} className="overflow-hidden rounded-lg bg-bg-secondary">
          <div className="bg-bg-tertiary/50 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              {t(`restrictions.category.${cat.id}`, cat.fallback)}
            </span>
          </div>
          <div className="divide-y divide-border/40">
            {cat.keys.map((key) => {
              const level = draft[key] ?? 'none';
              const label = stepUpActionLabel(t, key);
              return (
                <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 md:flex-nowrap">
                  <div className="min-w-0 flex-1 max-md:basis-full">
                    <p className="text-sm text-text-primary md:truncate">{label}</p>
                    <p className="font-mono text-[10px] text-text-muted">{key}</p>
                  </div>
                  <div role="radiogroup" aria-label={label} className="flex shrink-0 items-center gap-1">
                    {LEVELS.map((lv) => {
                      const active = level === lv;
                      return (
                        <button
                          key={lv}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setDraft((cur) => ({ ...cur, [key]: lv }))}
                          className={cn(
                            'rounded border px-2.5 py-1 text-[11px] font-medium transition-colors coarse:py-2',
                            active
                              ? lv === 'sensitive'
                                ? 'border-orange-400 bg-orange-400/10 text-orange-400'
                                : 'border-transparent bg-bg-tertiary text-text-primary'
                              : lv === 'sensitive'
                                ? 'border-orange-400/40 text-orange-400 hover:border-accent/50'
                                : 'border-transparent text-text-muted hover:border-accent/50',
                          )}
                        >
                          {t(`restrictions.level.${lv}`, lv === 'none' ? 'None' : 'Sensitive')}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-text-muted">
          {t('restrictions.sensitiveCount', {
            count: sensitiveCount,
            defaultValue_one: '{{count}} sensitive action',
            defaultValue_other: '{{count}} sensitive actions',
          })}
        </span>
        {dirty && <span className="text-xs text-orange-400">{t('restrictions.unsaved', 'Unsaved changes')}</span>}
        <Button variant="ghost" size="sm" onClick={() => setDraft(saved)} disabled={!dirty || saving}>
          {t('restrictions.reset', 'Reset')}
        </Button>
        <Button size="sm" onClick={() => { void save(); }} disabled={!dirty} loading={saving}>
          {t('common.save', 'Save')}
        </Button>
      </div>
    </div>
  );
}
