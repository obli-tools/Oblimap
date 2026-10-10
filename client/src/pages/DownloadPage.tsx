import { useState, useEffect } from 'react';
import {
  Monitor, Apple, Download, ExternalLink, FolderOpen,
  Loader2, CheckCircle, AlertCircle,
} from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { PageContainer } from '@/components/common/PageContainer';

// ── Native desktop-app Go bindings ───────────────────────────────────────────

type NativeWindow = Window & {
  __oblimap_is_native_app?: boolean;
  __go_getDownloadDir?: () => Promise<string>;
  __go_chooseDownloadDir?: () => Promise<string>;
  __go_downloadFile?: (relUrl: string, filename: string) => Promise<string>;
};

const nw = typeof window !== 'undefined' ? (window as NativeWindow) : null;
const isNativeApp = !!nw?.__oblimap_is_native_app;

// ── Static data ───────────────────────────────────────────────────────────────

interface DownloadEntry {
  label: string;
  sublabel: string;
  filename: string;
  primary?: boolean;
}

interface Platform {
  name: string;
  icon: React.ReactNode;
  downloads: DownloadEntry[];
}

// ── Reusable download button ──────────────────────────────────────────────────

interface DownloadButtonProps {
  entry: DownloadEntry;
  relDir: string;
  downloading: Record<string, boolean>;
  downloaded: Record<string, string>;
  dlErrors: Record<string, string>;
  onNativeDownload: (relUrl: string, filename: string) => void;
}

function DownloadButton({
  entry: d, relDir,
  downloading, downloaded, dlErrors,
  onNativeDownload,
}: DownloadButtonProps) {
  const { t } = useTranslation();
  const isLoading = !!downloading[d.filename];
  const isSaved   = !!downloaded[d.filename];
  const hasError  = !!dlErrors[d.filename];

  const base      = 'flex flex-col items-center justify-center gap-1 rounded-lg px-3 py-5 text-center transition-colors disabled:opacity-60 w-full';
  const primary   = `${base} bg-accent font-semibold text-white hover:opacity-90`;
  const secondary = `${base} bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary`;

  const inner = isLoading ? (
    <>
      <Loader2 size={15} className="animate-spin" />
      <span className="text-xs mt-0.5">{t('common.downloading')}</span>
    </>
  ) : isSaved ? (
    <>
      <CheckCircle size={15} className={d.primary ? 'text-white/80' : 'text-green-400'} />
      <span className="text-xs mt-0.5">{t('common.saved')}</span>
    </>
  ) : (
    <>
      <Download size={15} />
      <span className="text-xs font-semibold leading-tight mt-0.5">{d.label}</span>
      <span className="text-xs leading-tight opacity-60">{d.sublabel}</span>
    </>
  );

  return (
    <div className="flex flex-col">
      {hasError && isNativeApp && (
        <div className="mb-1 flex items-center gap-1 text-xs text-red-400">
          <AlertCircle size={10} />
          <span className="truncate">{dlErrors[d.filename]}</span>
        </div>
      )}
      {isNativeApp ? (
        <button
          onClick={() => onNativeDownload(`${relDir}${d.filename}`, d.filename)}
          disabled={isLoading}
          className={d.primary ? primary : secondary}
        >
          {inner}
        </button>
      ) : (
        <a
          href={`${relDir}${d.filename}`}
          download={d.filename}
          className={d.primary ? primary : secondary}
        >
          {inner}
        </a>
      )}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DownloadPage() {
  const { t } = useTranslation();

  const DESKTOP_PLATFORMS: Platform[] = [
    {
      name: t('download.windows'),
      icon: <Monitor size={24} />,
      downloads: [
        {
          label: t('download.installer'),
          sublabel: t('download.installerSub'),
          filename: 'ObliToolsSetup.msi',
          primary: true,
        },
        {
          label: t('download.portable'),
          sublabel: t('download.portableSub'),
          filename: 'ObliTools.exe',
        },
      ],
    },
    {
      name: t('download.macos'),
      icon: <Apple size={24} />,
      downloads: [
        {
          label: t('download.dmg'),
          sublabel: t('download.dmgSubArm'),
          filename: 'ObliTools-arm64.dmg',
          primary: true,
        },
        {
          label: t('download.dmg'),
          sublabel: t('download.dmgSubIntel'),
          filename: 'ObliTools-amd64.dmg',
          primary: true,
        },
        {
          label: t('download.zip'),
          sublabel: t('download.dmgSubArm'),
          filename: 'ObliTools-arm64.zip',
        },
        {
          label: t('download.zip'),
          sublabel: t('download.dmgSubIntel'),
          filename: 'ObliTools-amd64.zip',
        },
      ],
    },
  ];

  const [downloadDir, setDownloadDir] = useState<string>('');
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [downloaded, setDownloaded]   = useState<Record<string, string>>({});
  const [dlErrors, setDlErrors]       = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isNativeApp || !nw?.__go_getDownloadDir) return;
    nw.__go_getDownloadDir()
      .then(dir => setDownloadDir(dir))
      .catch(() => {});
  }, []);

  const handleChangeDir = async () => {
    const go = nw?.__go_chooseDownloadDir;
    if (!go) return;
    try {
      const dir = await go();
      setDownloadDir(dir);
    } catch { /* cancelled */ }
  };

  const handleNativeDownload = async (relUrl: string, filename: string) => {
    const go = nw?.__go_downloadFile;
    if (!go) return;
    setDownloading(prev => ({ ...prev, [filename]: true }));
    setDlErrors(prev => { const n = { ...prev }; delete n[filename]; return n; });
    try {
      const dest = await go(relUrl, filename);
      setDownloaded(prev => ({ ...prev, [filename]: dest }));
      setTimeout(() => {
        setDownloaded(prev => { const n = { ...prev }; delete n[filename]; return n; });
      }, 6000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'cancelled') {
        setDlErrors(prev => ({ ...prev, [filename]: msg }));
      }
      if (nw?.__go_getDownloadDir) {
        nw.__go_getDownloadDir().then(dir => setDownloadDir(dir)).catch(() => {});
      }
    } finally {
      setDownloading(prev => { const n = { ...prev }; delete n[filename]; return n; });
    }
  };

  const btnProps = { downloading, downloaded, dlErrors, onNativeDownload: handleNativeDownload };

  return (
    <PageContainer className="mx-auto max-w-2xl sm:py-12 lg:py-12">

      {/* Header */}
      <div className="mb-8 text-center">
        <div className="mb-4 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Download size={32} />
          </div>
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-text-primary">{t('download.pageTitle')}</h1>
        <p className="text-text-secondary">{t('download.pageDesc')}</p>
      </div>

      {/* Section header */}
      <div className="mb-6 text-center">
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('download.title')}</h2>
        <p className="text-sm text-text-secondary whitespace-pre-line">{t('download.description')}</p>
      </div>

      {/* Download folder row — shown only inside the native app */}
      {isNativeApp && (
        <div className="mb-6 flex items-center gap-3 rounded-xl bg-bg-secondary px-4 py-3 text-sm shadow-[var(--shadow-card)]">
          <FolderOpen size={15} className="text-text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-text-secondary">{t('download.downloadFolder')}</span>
            {downloadDir
              ? <span className="font-mono text-text-primary break-all">{downloadDir}</span>
              : <span className="text-text-muted italic">{t('download.downloadFolderPlaceholder')}</span>
            }
          </div>
          <Button variant="secondary" size="sm" onClick={handleChangeDir} className="shrink-0 text-xs">
            {t('download.changeFolder')}
          </Button>
        </div>
      )}

      {/* Feature pills */}
      <div className="mb-8 flex flex-wrap justify-center gap-2">
        {[
          t('download.features.soundAlerts'),
          t('download.features.agentAlerts'),
          t('download.features.noBrowserOverhead'),
          t('download.features.remembersUrl'),
          t('download.features.alwaysUpToDate'),
        ].map((f) => (
          <span
            key={f}
            className="rounded-full bg-bg-secondary px-3 py-1 text-xs text-text-secondary"
          >
            {f}
          </span>
        ))}
      </div>

      {/* Download cards */}
      <div className="flex flex-col gap-4">
        {DESKTOP_PLATFORMS.map((p) => (
          <div key={p.name} className="rounded-xl bg-bg-secondary p-5 shadow-[var(--shadow-card)]">
            <div className="mb-3 flex items-center gap-2.5 text-text-primary">
              <span className="text-text-secondary">{p.icon}</span>
              <span className="font-semibold">{p.name}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {p.downloads.map((d) => (
                <DownloadButton key={d.filename} entry={d} relDir="/downloads/" {...btnProps} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Build from source */}
      <div className="mt-8 rounded-xl bg-bg-secondary p-5 shadow-[var(--shadow-card)]">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ExternalLink size={14} />
          {t('download.buildFromSource')}
        </div>
        <p className="text-sm text-text-secondary leading-relaxed">
          {t('download.buildFromSourceDesc')}{' '}
          <Trans
            i18nKey="download.buildFromSourceDetail"
            defaults={
              'It is a Go application using the native OS webview (WebView2 on Windows, WKWebView on macOS). '
              + 'On Windows run <code>.\\build-windows.ps1</code> (requires WiX v4: <code>dotnet tool install --global wix</code>). '
              + 'On macOS run <code>./build-mac.sh</code>.'
            }
            components={{
              code: <code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs font-mono text-text-primary" />,
            }}
          />
        </p>
      </div>

      {/* How it works */}
      <div className="mt-6 rounded-xl bg-bg-secondary p-5 shadow-[var(--shadow-card)]">
        <div className="mb-3 text-sm font-semibold text-text-primary">{t('download.howItWorks')}</div>
        <ul className="space-y-2 text-sm text-text-secondary">
          {(['step1','step2','step3','step4','step5'] as const).map((step, i) => (
            <li key={step} className="flex gap-2">
              <span className="mt-0.5 shrink-0 text-accent">{i + 1}.</span>
              {t(`download.${step}`)}
            </li>
          ))}
        </ul>
      </div>
    </PageContainer>
  );
}
