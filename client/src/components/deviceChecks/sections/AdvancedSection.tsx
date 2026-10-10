/**
 * AdvancedSection — read-only JSON of the rule spec with "Copy", and
 * "Import JSON". An imported spec replaces the form
 * only after the server validated it (POST /device-checks/validate): the
 * editor has no other way to edit raw JSON.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Copy, Loader2, Upload } from 'lucide-react';
import type { DeviceCheckSpec } from '@oblimap/shared';
import { deviceChecksApi, describeDeviceCheckError, type DeviceCheckIssue } from '@/api/deviceChecks.api';
import { cn } from '@/utils/cn';
import { copyText } from '@/utils/clipboard';
import { inputCls } from './GeneralSection';
import { withoutExplicitDevices } from './MatchSection';

const MAX_IMPORT_CHARS = 200_000;

export interface ImportedRuleMeta {
  name?: string;
  description?: string | null;
}

interface AdvancedSectionProps {
  spec: DeviceCheckSpec;
  presetKey: string | null;
  presetVersion: number | null;
  onImport: (spec: DeviceCheckSpec, meta: ImportedRuleMeta) => void;
}

export function AdvancedSection({ spec, presetKey, presetVersion, onImport }: AdvancedSectionProps) {
  const { t } = useTranslation();
  const json = useMemo(() => JSON.stringify(spec, null, 2), [spec]);
  const [importOpen, setImportOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<DeviceCheckIssue[]>([]);

  const runImport = async () => {
    setError(null);
    setIssues([]);
    if (text.length > MAX_IMPORT_CHARS) {
      setError(t('deviceChecks.editor.advanced.tooLarge', 'This JSON is too large'));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError(t('deviceChecks.editor.advanced.invalidJson', 'This is not valid JSON'));
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError(t('deviceChecks.editor.advanced.notObject', 'Expected a JSON object: a rule spec or an exported check'));
      return;
    }
    // Accept a bare spec or an exported check ({ name, description, spec, … }).
    const obj = parsed as Record<string, unknown>;
    const isExport = !('schemaVersion' in obj) && !!obj.spec && typeof obj.spec === 'object';
    let candidate = (isExport ? obj.spec : obj) as DeviceCheckSpec;
    const meta: ImportedRuleMeta = {};
    if (isExport && typeof obj.name === 'string') meta.name = obj.name.slice(0, 128);
    if (isExport && (typeof obj.description === 'string' || obj.description === null)) meta.description = obj.description as string | null;
    // Explicit devices are site_items ids of the workspace the spec comes from:
    // never import them (another workspace: Save would fail; this one: the
    // rule would silently target whatever devices carry those ids).
    let droppedDevices = 0;
    if (candidate.match && typeof candidate.match === 'object' && !Array.isArray(candidate.match)) {
      const stripped = withoutExplicitDevices(candidate.match);
      droppedDevices = stripped.dropped;
      if (droppedDevices > 0) candidate = { ...candidate, match: stripped.match };
    }

    setBusy(true);
    try {
      const res = await deviceChecksApi.validate(candidate);
      if (!res.ok) {
        setIssues(res.issues);
        setError(droppedDevices > 0
          ? t('deviceChecks.editor.advanced.rejectedNoDevices', 'The server rejected this spec: nothing was imported. Its explicit devices were left out (they belong to one workspace), so it may have no target left: give it a vendor, MAC prefix or device type.')
          : t('deviceChecks.editor.advanced.rejected', 'The server rejected this spec: nothing was imported'));
        return;
      }
      onImport(candidate, meta);
      setText('');
      setImportOpen(false);
      toast.success(t('deviceChecks.editor.advanced.imported', 'Spec imported. Review it, then save.'));
      if (droppedDevices > 0) {
        toast(t('deviceChecks.editor.advanced.devicesDropped', { count: droppedDevices, defaultValue: 'Its {{count}} explicit device(s) were not imported: they belong to one workspace. Pick them in Target devices.' }));
      }
    } catch (err) {
      setError(describeDeviceCheckError(err, t, t('deviceChecks.editor.advanced.validateFailed', 'Validation failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {presetKey && (
        <p className="text-xs text-text-muted">
          {t('deviceChecks.editor.advanced.preset', { preset: presetKey, version: presetVersion ?? '?', defaultValue: 'Created from preset {{preset}} v{{version}}' })}
        </p>
      )}
      <div className="relative">
        <pre className="max-h-96 overflow-auto rounded-md bg-bg-primary p-3 font-mono text-[11px] leading-relaxed text-text-secondary">
          {json}
        </pre>
        <button
          type="button"
          onClick={async () => {
            const ok = await copyText(json);
            if (ok) toast.success(t('common.copied', 'Copied!'));
            else toast.error(t('common.copyFailed', 'Could not copy — select and copy manually'));
          }}
          className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <Copy size={12} />{t('common.copy', 'Copy')}
        </button>
      </div>

      {!importOpen ? (
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
        >
          <Upload size={12} />{t('deviceChecks.editor.advanced.import', 'Import JSON…')}
        </button>
      ) : (
        <div className="space-y-2 rounded-md bg-bg-tertiary/40 p-3">
          <p className="text-xs text-text-muted">
            {t('deviceChecks.editor.advanced.importHint', 'Paste a rule spec or an exported check. It replaces the whole form once the server has validated it. Explicit devices are never imported: they belong to one workspace.')}
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            spellCheck={false}
            className={cn(inputCls, 'font-mono text-[11px]')}
          />
          {error && <p className="text-xs text-status-down">{error}</p>}
          {issues.length > 0 && (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-status-down">
              {issues.map((i, k) => (
                <li key={k}><span className="font-mono">{i.path || '(spec)'}</span>: {i.message}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void runImport()}
              disabled={busy || !text.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {t('deviceChecks.editor.advanced.validateImport', 'Validate and import')}
            </button>
            <button
              type="button"
              onClick={() => { setImportOpen(false); setText(''); setError(null); setIssues([]); }}
              className="rounded-md bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
            >
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
