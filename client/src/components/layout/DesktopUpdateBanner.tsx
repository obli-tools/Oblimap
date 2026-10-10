import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { X, Download } from 'lucide-react';
import apiClient from '@/api/client';
import { storageGet, storageSet } from '@/utils/safeStorage';

// ── Types injected by the Go overlay ─────────────────────────────────────────
type OblimapWindow = Window & {
  __oblimap_is_native_app?: boolean;
  __oblimap_app_version?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const SKIP_KEY = 'oblimap:skipped-desktop-version';

/** Parse "X.Y.Z" → [X, Y, Z] as numbers. */
function parseVersion(v: string): [number, number, number] {
  const parts = v.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Returns true when `candidate` is strictly older than `latest`. */
function isOutdated(candidate: string, latest: string): boolean {
  const [ca, cb, cc] = parseVersion(candidate);
  const [la, lb, lc] = parseVersion(latest);
  if (ca !== la) return ca < la;
  if (cb !== lb) return cb < lb;
  return cc < lc;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DesktopUpdateBanner() {
  const { t } = useTranslation();
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const ow = typeof window !== 'undefined' ? (window as OblimapWindow) : null;
  const isNative = !!ow?.__oblimap_is_native_app;
  // Old builds (before version injection was added) won't have this property.
  // Treat them as "0.0.0" so any server version triggers the banner.
  const currentVersion = ow?.__oblimap_app_version ?? null;
  const effectiveVersion = currentVersion ?? (isNative ? '0.0.0' : null);

  useEffect(() => {
    // Fetch the latest version whenever we're inside the native app,
    // whether or not the current build reports its version.
    if (!isNative) return;

    apiClient
      .get<{ version: string }>('/agent/desktop-version')
      .then(res => setLatestVersion(res.data.version))
      .catch(() => { /* silently ignore — no banner on error */ });
  }, [isNative]);

  // Nothing to show if:
  // • not running inside the native app
  // • version fetch failed or server returned nothing
  // • already up to date
  // • user dismissed this session OR skipped this specific version
  if (!isNative || !effectiveVersion || !latestVersion) return null;
  if (!isOutdated(effectiveVersion, latestVersion)) return null;
  if (dismissed) return null;

  const skippedVersion = storageGet(SKIP_KEY);
  if (skippedVersion === latestVersion) return null;

  const handleSkip = () => {
    storageSet(SKIP_KEY, latestVersion);
    setDismissed(true);
  };

  const versionCls = { v: <span className="font-semibold text-accent" />, c: <span className="font-mono" /> };

  return (
    <div className="flex items-center gap-3 bg-accent/10 border-b border-accent/30 px-4 py-2 text-sm shrink-0">
      <Download size={15} className="text-accent shrink-0" />
      <span className="text-text-primary flex-1">
        {currentVersion ? (
          <Trans
            i18nKey="desktopUpdate.availableWithCurrent"
            defaults="Desktop app <v>v{{latest}}</v> is available (you have <c>{{current}}</c>)."
            values={{ latest: latestVersion, current: currentVersion }}
            components={versionCls}
          />
        ) : (
          <Trans
            i18nKey="desktopUpdate.available"
            defaults="Desktop app <v>v{{latest}}</v> is available — please update to get the latest features."
            values={{ latest: latestVersion }}
            components={versionCls}
          />
        )}
      </span>
      <Link
        to="/download"
        className="shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-semibold text-white hover:bg-accent/80 transition-colors"
      >
        {t('desktopUpdate.download', 'Download update')}
      </Link>
      <button
        type="button"
        onClick={handleSkip}
        title={t('desktopUpdate.skipVersion', 'Skip this version')}
        className="shrink-0 text-text-secondary hover:text-text-primary transition-colors text-xs underline underline-offset-2"
      >
        {t('common.skip', 'Skip')}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title={t('desktopUpdate.dismiss', 'Dismiss')}
        aria-label={t('desktopUpdate.dismiss', 'Dismiss')}
        className="shrink-0 text-text-secondary hover:text-text-primary transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
