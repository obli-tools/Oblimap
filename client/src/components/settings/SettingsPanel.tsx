import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedSettings, SettingsScope } from '@oblimap/shared';
import type { SettingsKey } from '@oblimap/shared';
import { SETTINGS_DEFINITIONS, SOCKET_EVENTS } from '@oblimap/shared';
import { getSocket } from '@/socket/socketClient';
import { settingsApi } from '@/api/settings.api';
import { probeApi } from '@/api/probe.api';
import { siteApi } from '@/api/site.api';
import { useTenantCapability } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useAnonymize } from '@/utils/anonymize';
import { isHandled } from '@/utils/apiError';
import { SettingField, type SettingRawValue } from './SettingField';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import toast from 'react-hot-toast';

interface SettingsPanelProps {
  scope: SettingsScope;
  scopeId: number | null;
  title?: string;
  /** Only these keys are shown (e.g. the probe level: the keys a probe reads). */
  keys?: readonly SettingsKey[];
  /** Called after a value of this scope was saved or reset here. */
  onSaved?: () => void;
}

type LoadError = 'forbidden' | 'notFound' | 'error';

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/** The server's reason for a refused value (400 of validate() or of the settings service). */
function serverMessage(err: unknown, t: TFunction): string | undefined {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { error?: unknown; message?: unknown; issues?: unknown };
  if (Array.isArray(d.issues) && d.issues.length > 0) {
    const first = d.issues[0] as { path?: unknown; message?: unknown } | null;
    if (first && first.message === 'subnet_too_wide') {
      return t('settings.panel.subnetTooWide', 'Subnets wider than /16 cannot be scanned: split them into /16 or smaller subnets');
    }
    if (first && first.message === 'invalid_option') {
      // A 'select' setting (probeUpdatePolicy) refused a value it does not offer.
      return t('settings.panel.invalidOption', 'This value is not one of the options offered');
    }
    if (first && typeof first.message === 'string') {
      return typeof first.path === 'string' && first.path ? `${first.path}: ${first.message}` : first.message;
    }
  }
  if (typeof d.error === 'string' && d.error) return d.error;
  if (typeof d.message === 'string' && d.message) return d.message;
  return undefined;
}

/**
 * The API takes the businessHours object as its JSON text (accepted by every
 * server version); other values (a 'select' option included) are sent as they are.
 */
function toApiValue(value: SettingRawValue): number | boolean | string | string[] | number[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return JSON.stringify(value);
  return value as number | boolean | string | string[] | number[];
}

export function SettingsPanel({ scope, scopeId, title, keys, onSaved }: SettingsPanelProps) {
  const { t } = useTranslation();
  const [resolved, setResolved] = useState<ResolvedSettings | null>(null);
  const [overrides, setOverrides] = useState<Record<string, SettingRawValue>>({});
  const overridesRef = useRef<Record<string, SettingRawValue>>({});
  /** Per-key remount counter, bumped when a key's override changed elsewhere. */
  const [fieldRev, setFieldRev] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);

  /**
   * silent: background refresh after a SETTINGS_UPDATED event — no spinner
   * (fields being edited stay mounted) and no error toast (the shown values
   * stay).
   */
  const fetchSettings = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      let data: { resolved: ResolvedSettings; overrides: Record<string, SettingRawValue> };
      if (scope === 'global') {
        data = await settingsApi.getGlobalResolved();
      } else if (scope === 'group') {
        data = await settingsApi.getGroupResolved(scopeId!);
      } else if (scope === 'site') {
        data = await settingsApi.getSiteResolved(scopeId!);
      } else {
        // Probe level ('monitor' scope): the effective config of the probe;
        // its own overrides are the values whose source is the probe.
        const probeResolved = await probeApi.getEffectiveConfig(scopeId!);
        const own: Record<string, SettingRawValue> = {};
        for (const [key, v] of Object.entries(probeResolved)) {
          if (v?.source === 'monitor' && v.value !== null) own[key] = v.value as SettingRawValue;
        }
        data = { resolved: probeResolved, overrides: own };
      }
      if (silent) {
        // SettingField keeps its override state / value from mount: remount
        // only the fields whose stored override changed elsewhere (the echo
        // of this session's own save carries the same value: no remount).
        const prev = overridesRef.current;
        const changed = new Set<string>();
        for (const key of new Set([...Object.keys(prev), ...Object.keys(data.overrides)])) {
          if (JSON.stringify(prev[key] ?? null) !== JSON.stringify(data.overrides[key] ?? null)) changed.add(key);
        }
        if (changed.size > 0) {
          setFieldRev((r) => {
            const next = { ...r };
            for (const key of changed) next[key] = (next[key] ?? 0) + 1;
            return next;
          });
        }
      }
      overridesRef.current = data.overrides;
      setResolved(data.resolved);
      setOverrides(data.overrides);
      setLoadError(null);
    } catch (err) {
      if (silent) return;
      const status = httpStatus(err);
      setLoadError(status === 403 ? 'forbidden' : status === 404 ? 'notFound' : 'error');
      if (status !== 403 && status !== 404 && !isHandled(err)) toast.error(t('settings.panel.failedLoad', 'Failed to load settings'));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    setResolved(null);
    setLoadError(null);
    fetchSettings();
  }, [scope, scopeId]);

  // Settings changed elsewhere (another session, another admin): refetch when
  // the change is at this panel's scope, or above it (global, any group, or
  // a site for a probe panel: its values may be inherited here). Debounced; events reach the tenant's
  // admins and the holders of the 'settings' capability.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onSettingsUpdated = (data: { scope?: unknown; scopeId?: unknown } | null) => {
      if (!data) return;
      const sameScope = data.scope === scope && (data.scopeId ?? null) === scopeId;
      const inherited = scope !== 'global'
        && (data.scope === 'global' || data.scope === 'group' || (scope === 'monitor' && data.scope === 'site'));
      if (!sameScope && !inherited) return;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void fetchSettings(true);
      }, 500);
    };
    socket.on(SOCKET_EVENTS.SETTINGS_UPDATED, onSettingsUpdated);
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      socket.off(SOCKET_EVENTS.SETTINGS_UPDATED, onSettingsUpdated);
    };
  }, [scope, scopeId]);

  const handleSave = async (key: SettingsKey, value: SettingRawValue): Promise<boolean> => {
    const scopeIdStr = scopeId !== null ? String(scopeId) : 'null';
    try {
      await settingsApi.set(scope, scopeIdStr, key, toApiValue(value));
    } catch (err) {
      if (isHandled(err)) return false;
      const reason = httpStatus(err) === 400 ? serverMessage(err, t) : undefined;
      toast.error(reason
        ? t('settings.panel.refused', { reason, defaultValue: 'Setting refused: {{reason}}' })
        : t('settings.panel.failedSave', 'Failed to save setting'));
      return false;
    }
    toast.success(t('settings.panel.saved', 'Setting saved'));
    onSaved?.();
    await fetchSettings();
    return true;
  };

  const handleReset = async (key: SettingsKey) => {
    const scopeIdStr = scopeId !== null ? String(scopeId) : 'null';
    try {
      await settingsApi.remove(scope, scopeIdStr, key);
      toast.success(t('settings.panel.reset', 'Reset to inherited'));
      onSaved?.();
      await fetchSettings();
    } catch (err) {
      if (!isHandled(err)) toast.error(t('settings.panel.failedReset', 'Failed to reset setting'));
    }
  };

  if (!resolved && loadError) {
    return (
      <div className="rounded-xl bg-bg-secondary p-5 text-center text-sm text-text-muted shadow-[var(--shadow-card)]">
        {loadError === 'forbidden'
          ? t('settings.panel.forbidden', 'You do not have permission to view these settings.')
          : loadError === 'notFound'
            ? t('settings.panel.notFound', 'Not found.')
            : (
              <span className="inline-flex flex-wrap items-center justify-center gap-2">
                {t('settings.panel.failedLoad', 'Failed to load settings')}
                <button type="button" onClick={() => void fetchSettings()} className="text-accent hover:underline">
                  {t('common.retry', 'Retry')}
                </button>
              </span>
            )}
      </div>
    );
  }

  if (loading || !resolved) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-bg-secondary p-5 shadow-[var(--shadow-card)]">
      {title && (
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-4">
          {title}
        </h2>
      )}
      {(scope === 'site' || scope === 'group') && scopeId !== null && (
        <OverridingProbesNotice scope={scope} scopeId={scopeId} />
      )}
      <div>
        {SETTINGS_DEFINITIONS.filter((def) => resolved[def.key] !== undefined && (!keys || keys.includes(def.key))).map((def) => (
          <SettingField
            key={`${def.key}:${fieldRev[def.key] ?? 0}`}
            definition={def}
            inheritedValue={resolved[def.key]}
            overrideValue={overrides[def.key]}
            scope={scope}
            onSave={handleSave}
            onReset={handleReset}
          />
        ))}
      </div>
    </div>
  );
}

/** Scan keys a probe overriding the settings chain does not receive. */
const SCAN_KEYS_LABEL_FALLBACK = 'scan interval, subnets, port scan';

/**
 * Site / group panels, for holders of probes.manage: the probes of the scope
 * that still use their own scan configuration (scanConfigOverride), for
 * which the scan settings edited here do not apply. Nothing when there are
 * none or the lists cannot be loaded.
 */
function OverridingProbesNotice({ scope, scopeId }: { scope: 'site' | 'group'; scopeId: number }) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const canManageProbes = useTenantCapability('probes.manage');
  const epoch = useTenantStore((s) => s.epoch);
  const [probes, setProbes] = useState<Array<{ id: number; label: string }>>([]);

  useEffect(() => {
    setProbes([]);
    if (!canManageProbes) return;
    let cancelled = false;
    void (async () => {
      try {
        const [{ probes: all }, siteIds] = await Promise.all([
          probeApi.list(),
          scope === 'site'
            ? Promise.resolve(new Set([scopeId]))
            : siteApi.list({ groupId: scopeId, includeDescendants: true }).then(({ sites }) => new Set(sites.map((s) => s.id))),
        ]);
        if (cancelled) return;
        setProbes(all
          .filter((p) => p.scanConfigOverride === true && p.siteId !== null && siteIds.has(p.siteId)
            && p.status !== 'refused')
          .map((p) => ({ id: p.id, label: p.name || p.hostname })));
      } catch {
        /* informational only */
      }
    })();
    return () => { cancelled = true; };
  }, [canManageProbes, scope, scopeId, epoch]);

  if (!canManageProbes || probes.length === 0) return null;
  return (
    <div role="note" className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
      <Info size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p>
          {scope === 'site'
            ? t('settings.panel.overridingProbesSite', {
              count: probes.length,
              keys: t('settings.panel.overridingProbesKeys', SCAN_KEYS_LABEL_FALLBACK),
              defaultValue: '{{count}} probe(s) of this site use their own scan configuration: the scan settings here ({{keys}}) do not apply to them.',
            })
            : t('settings.panel.overridingProbesGroup', {
              count: probes.length,
              keys: t('settings.panel.overridingProbesKeys', SCAN_KEYS_LABEL_FALLBACK),
              defaultValue: '{{count}} probe(s) in this group use their own scan configuration: the scan settings here ({{keys}}) do not apply to them.',
            })}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
          {probes.slice(0, 10).map((p) => (
            <Link key={p.id} to={`/manage/probes/${p.id}`} className="text-accent hover:underline">
              {anonymize(p.label, 'hostname')}
            </Link>
          ))}
          {probes.length > 10 && (
            <span className="text-text-muted">{t('settings.panel.overridingProbesMore', { count: probes.length - 10, defaultValue: '+{{count}} more' })}</span>
          )}
        </p>
      </div>
    </div>
  );
}
