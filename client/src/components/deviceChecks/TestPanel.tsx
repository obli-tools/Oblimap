/**
 * TestPanel — runs the rule being edited once, on one real device, through
 * the probe that would run it. Pick a site, then a matched
 * device; credentials are the rule's stored ones or typed inline (never
 * stored, never kept after this panel closes).
 *
 * Output: the trace, the extracted values, the server-evaluated checks and a
 * searchable body snippet (≤ 4 KiB, redacted by the probe). The body is how
 * admins find the real path and labels of a device: JSON / XML paths and the
 * selected text can be copied into the active extractor.
 *
 * Everything the device returned is rendered as text only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { FlaskConical, Loader2, Play, RefreshCw, Search, Crosshair, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import type {
  DeviceCheckField,
  DeviceCheckSpec,
  DeviceCheckTestResponse,
  Site,
  SiteItem,
} from '@oblimap/shared';
import {
  deviceChecksApi,
  deviceCheckErrorLabel,
  describeDeviceCheckError,
  parseDeviceCheckError,
  type DeviceCheckIssue,
} from '@/api/deviceChecks.api';
import { Button } from '@/components/common/Button';
import { useAnonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { DEVICE_CHECK_TONE_CLASSES, deviceCheckStatusLabel, formatDeviceCheckValue } from './DeviceCheckChip';
import { TraceView, maskDeviceAddresses } from './TraceView';
import { cleanMatch } from './sections/MatchSection';
import { EXTRACTOR_TYPE_FALLBACKS, type ExtractorType } from './sections/ExtractorRow';
import { inputCls } from './sections/GeneralSection';

// ─── Body helpers ─────────────────────────────────────────────────────────────

const MAX_PATHS = 200;
const JSON_KEY_RE = /^[A-Za-z_][\w-]{0,63}$/;
const XML_NAME_RE = /^[A-Za-z_][\w.-]{0,63}$/;

interface PathEntry { path: string; value: string }

/** Leaf paths of a JSON document, in the extractor syntax (a.b[0].c), max 12 segments. */
function jsonPaths(root: unknown): PathEntry[] {
  const out: PathEntry[] = [];
  const walk = (v: unknown, path: string, segments: number) => {
    if (out.length >= MAX_PATHS || segments > 12) return;
    if (Array.isArray(v)) {
      // One index per segment, right after a key (root or nested arrays are not addressable).
      if (!path || path.endsWith(']')) return;
      v.slice(0, 20).forEach((x, i) => walk(x, `${path}[${i}]`, segments));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (JSON_KEY_RE.test(k)) walk(x, path ? `${path}.${k}` : k, segments + 1);
      }
    } else if (path) {
      out.push({ path, value: v === null ? 'null' : String(v) });
    }
  };
  walk(root, '', 0);
  return out;
}

/** Leaf element and attribute paths of an XML document (/a/b/c, /a/b/@attr), local names. */
function xmlPaths(text: string): PathEntry[] | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch {
    return null;
  }
  if (doc.getElementsByTagName('parsererror').length > 0 || !doc.documentElement) return null;
  const out: PathEntry[] = [];
  const seen = new Set<string>();
  const add = (path: string, value: string) => {
    if (out.length >= MAX_PATHS || seen.has(path)) return;
    seen.add(path);
    out.push({ path, value: value.trim() });
  };
  const walk = (el: Element, parent: string, depth: number) => {
    if (out.length >= MAX_PATHS || depth > 12 || !XML_NAME_RE.test(el.localName)) return;
    const p = `${parent}/${el.localName}`;
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith('xmlns') && XML_NAME_RE.test(attr.localName)) add(`${p}/@${attr.localName}`, attr.value);
    }
    const children = Array.from(el.children);
    if (children.length === 0) add(p, el.textContent ?? '');
    else children.forEach((c) => walk(c, p, depth + 1));
  };
  walk(doc.documentElement, '', 1);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A pattern that captures the text that follows a label ("Now playing: <b>Title</b>"). */
function patternAfterLabel(label: string): string {
  const esc = escapeRegExp(label.trim().slice(0, 100)).replace(/\s+/g, '\\s*');
  return `(?is)${esc}\\s*:?\\s*(?:</?[a-z][^>]{0,80}>\\s*){0,6}([^<\\r\\n]{0,200})`;
}

/** The snippet split around the (case-insensitive) search matches. */
function highlight(text: string, query: string): Array<{ text: string; hit: boolean }> {
  if (!query) return [{ text, hit: false }];
  const re = new RegExp(escapeRegExp(query), 'gi');
  const parts: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export interface ActiveExtractorInfo {
  /** "#1 › nowPlaying" */
  label: string;
  type: ExtractorType;
}

interface TestPanelProps {
  /** The spec as it would be saved (normalized by the page). */
  spec: DeviceCheckSpec;
  ruleId: number | null;
  hasStoredCredentials: boolean;
  /** Sites of the rule's scope. */
  sites: Site[];
  preferredSiteId: number | null;
  activeExtractor: ActiveExtractorInfo | null;
  onCopyToExtractor: (kind: 'pattern' | 'path', value: string) => void;
  onResult: (res: DeviceCheckTestResponse | null) => void;
  className?: string;
}

type CredMode = 'stored' | 'inline';

export function TestPanel({
  spec, ruleId, hasStoredCredentials, sites, preferredSiteId, activeExtractor, onCopyToExtractor, onResult, className,
}: TestPanelProps) {
  const { t } = useTranslation();
  const { anonymize, isAnonymous } = useAnonymize();

  const [siteId, setSiteId] = useState<number | null>(preferredSiteId ?? (sites.length === 1 ? sites[0].id : null));
  const [devices, setDevices] = useState<SiteItem[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [itemId, setItemId] = useState<number | null>(null);

  const usesBasic = spec.variants.some((v) => v.request.auth === 'basic');
  const canUseStored = ruleId !== null && hasStoredCredentials;
  const [credMode, setCredMode] = useState<CredMode>(canUseStored ? 'stored' : 'inline');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const missingInline = usesBasic && credMode === 'inline' && (!username || !password);

  // Follow the stored credentials as they appear (set in the Credentials
  // section, or the rule just saved) or disappear, unless some were typed.
  useEffect(() => {
    if (canUseStored) setCredMode((m) => (m === 'inline' && !username && !password ? 'stored' : m));
    else setCredMode('inline');
  }, [canUseStored]); // eslint-disable-line react-hooks/exhaustive-deps

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runIssues, setRunIssues] = useState<DeviceCheckIssue[]>([]);
  const [result, setResult] = useState<DeviceCheckTestResponse | null>(null);
  const [search, setSearch] = useState('');
  const preRef = useRef<HTMLPreElement>(null);

  // Keep the selected site valid when the scope changes (once the sites are loaded).
  useEffect(() => {
    if (sites.length === 0) return;
    if (siteId !== null && !sites.some((s) => s.id === siteId)) setSiteId(null);
    if (siteId === null && preferredSiteId !== null && sites.some((s) => s.id === preferredSiteId)) setSiteId(preferredSiteId);
  }, [sites, siteId, preferredSiteId]);

  const matchKey = JSON.stringify(cleanMatch(spec.match));

  const loadDevices = useCallback(async (sid: number) => {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const res = await deviceChecksApi.previewMatches({ match: JSON.parse(matchKey), siteId: sid });
      setDevices(res.sample.filter((i) => i.siteId === sid));
    } catch (err) {
      setDevices([]);
      setDevicesError(describeDeviceCheckError(err, t, t('deviceChecks.test.devicesFailed', 'Could not list the matched devices: check the target devices section')));
    } finally {
      setDevicesLoading(false);
    }
  }, [matchKey, t]);

  useEffect(() => {
    setItemId(null);
    setDevices([]);
    setPassword('');
    if (siteId !== null) void loadDevices(siteId);
    // Reload only when the site changes; "refresh" re-reads the match.
  }, [siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (itemId !== null && !devices.some((d) => d.id === itemId)) setItemId(null);
    if (itemId === null && devices.length === 1) setItemId(devices[0].id);
  }, [devices, itemId]);

  const run = async () => {
    if (itemId === null || missingInline) return;
    setRunning(true);
    setRunError(null);
    setRunIssues([]);
    try {
      const credentials = !usesBasic ? undefined : credMode === 'stored' ? 'stored' as const : { username, password };
      const res = await deviceChecksApi.test({
        spec,
        ...(ruleId !== null ? { ruleId } : {}),
        siteItemId: itemId,
        ...(credentials ? { credentials } : {}),
      });
      setResult(res);
      onResult(res);
    } catch (err) {
      const e = parseDeviceCheckError(err);
      if (e.status === 429) {
        setRunError(t('deviceChecks.test.rateLimited', 'Too many tests in a short time: wait a few minutes.'));
      } else {
        setRunError(describeDeviceCheckError(err, t, t('deviceChecks.test.failed', 'The test failed')));
      }
      setRunIssues(e.issues);
    } finally {
      setRunning(false);
    }
  };

  const res = result?.result;
  const snippet = res?.bodySnippet ?? '';
  const shownSnippet = isAnonymous ? maskDeviceAddresses(snippet) : snippet;
  const parts = useMemo(() => highlight(shownSnippet, search.trim()), [shownSnippet, search]);
  const hits = parts.filter((p) => p.hit).length;

  const paths = useMemo<{ kind: 'json' | 'xml'; list: PathEntry[] } | null>(() => {
    const s = snippet.trim();
    if (!s) return null;
    if (s.startsWith('{') || s.startsWith('[')) {
      try { return { kind: 'json', list: jsonPaths(JSON.parse(s)) }; } catch { return null; }
    }
    if (s.startsWith('<') && !/^<!doctype html|^<html/i.test(s)) {
      const list = xmlPaths(s);
      return list ? { kind: 'xml', list } : null;
    }
    return null;
  }, [snippet]);

  const fieldByKey = useMemo(() => new Map<string, DeviceCheckField>(spec.fields.map((f) => [f.key, f])), [spec.fields]);

  const copyPath = (kind: 'json' | 'xml', path: string) => {
    if (!activeExtractor) {
      toast.error(t('deviceChecks.test.noActiveExtractor', 'Click the target icon of an extractor row first'));
      return;
    }
    if (activeExtractor.type !== kind) {
      toast.error(t('deviceChecks.test.wrongType', { type: t(`deviceChecks.editor.extract.types.${kind}`, EXTRACTOR_TYPE_FALLBACKS[kind]), defaultValue: 'The active extractor is not a {{type}} extractor' }));
      return;
    }
    onCopyToExtractor('path', path);
    toast.success(t('deviceChecks.test.copiedToExtractor', 'Copied to the extractor'));
  };

  const copySelection = () => {
    // Anonymous mode shows a masked body: a pattern or path built from masked
    // text ("•") would never match the real device.
    if (isAnonymous) {
      toast.error(t('deviceChecks.test.copySelectionAnonymous', 'Anonymous mode masks the body: turn it off to copy a selection to the extractor.'));
      return;
    }
    const sel = window.getSelection();
    const text = sel && preRef.current && sel.anchorNode && preRef.current.contains(sel.anchorNode) ? sel.toString() : '';
    if (!text.trim()) {
      toast.error(t('deviceChecks.test.selectFirst', 'Select a label or a path in the body first'));
      return;
    }
    if (!activeExtractor) {
      toast.error(t('deviceChecks.test.noActiveExtractor', 'Click the target icon of an extractor row first'));
      return;
    }
    if (activeExtractor.type === 'regex') onCopyToExtractor('pattern', patternAfterLabel(text));
    else if (activeExtractor.type === 'json' || activeExtractor.type === 'xml') onCopyToExtractor('path', text.trim().slice(0, 512));
    else {
      toast.error(t('deviceChecks.test.noExpression', 'This extractor type has no pattern or path'));
      return;
    }
    toast.success(t('deviceChecks.test.copiedToExtractor', 'Copied to the extractor'));
  };

  const statusTone = result ? (result.status === 'ok' ? 'ok' : result.status === 'fail' ? 'bad' : 'warn') : 'neutral';

  return (
    <div className={cn('rounded-xl bg-bg-secondary shadow-[var(--shadow-card)]', className)}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <FlaskConical size={15} className="text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">{t('deviceChecks.test.title', 'Test on a device')}</h2>
      </div>

      <div className="space-y-3 p-4">
        {/* Target */}
        <div className="space-y-2">
          <select
            value={siteId ?? ''}
            onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : null)}
            className={inputCls}
            aria-label={t('deviceChecks.test.site', 'Site')}
          >
            <option value="">{t('deviceChecks.test.pickSite', 'Pick a site…')}</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{anonymize(s.name, 'hostname')}</option>)}
          </select>
          <div className="flex gap-2">
            <select
              value={itemId ?? ''}
              onChange={(e) => setItemId(e.target.value ? Number(e.target.value) : null)}
              disabled={siteId === null || devicesLoading}
              className={cn(inputCls, 'flex-1')}
              aria-label={t('deviceChecks.test.device', 'Device')}
            >
              <option value="">
                {devicesLoading
                  ? t('common.loading', 'Loading…')
                  : siteId !== null && devices.length === 0
                    ? t('deviceChecks.test.noDevice', 'No matched device on this site')
                    : t('deviceChecks.test.pickDevice', 'Pick a matched device…')}
              </option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {anonymize(d.ip, 'ip')} · {anonymize(d.customName || d.hostname || d.vendor || '', 'hostname') || '—'}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => siteId !== null && void loadDevices(siteId)}
              disabled={siteId === null || devicesLoading}
              className="rounded-md bg-bg-tertiary px-2 text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
              title={t('deviceChecks.test.refreshDevices', 'Match again with the current target devices')}
              aria-label={t('deviceChecks.test.refreshDevices', 'Match again with the current target devices')}
            >
              <RefreshCw size={13} className={cn(devicesLoading && 'animate-spin')} />
            </button>
          </div>
          {devicesError && <p className="text-xs text-status-down">{devicesError}</p>}
        </div>

        {/* Credentials */}
        {usesBasic && (
          <div className="space-y-2 rounded-md bg-bg-tertiary/40 p-2">
            <div className="flex gap-3 text-xs">
              <label className={cn('flex items-center gap-1.5', !canUseStored && 'opacity-50')}>
                <input
                  type="radio"
                  name="dc-test-cred"
                  checked={credMode === 'stored'}
                  disabled={!canUseStored}
                  onChange={() => setCredMode('stored')}
                />
                {t('deviceChecks.test.credStored', 'Stored credentials')}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="dc-test-cred" checked={credMode === 'inline'} onChange={() => setCredMode('inline')} />
                {t('deviceChecks.test.credInline', 'Type them for this test')}
              </label>
            </div>
            {credMode === 'inline' && (
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={username}
                  maxLength={128}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('deviceChecks.editor.credentials.username', 'Username')}
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(inputCls, 'text-xs')}
                />
                <input
                  type="password"
                  value={password}
                  maxLength={256}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('deviceChecks.editor.credentials.password', 'Password')}
                  autoComplete="new-password"
                  className={cn(inputCls, 'text-xs')}
                />
                <p className={cn('col-span-2 text-[11px]', missingInline ? 'text-amber-400' : 'text-text-muted')}>
                  {missingInline
                    ? t('deviceChecks.test.credMissing', 'Type the username and the password to run the test (used for this test only, never stored).')
                    : t('deviceChecks.test.credInlineHint', 'Used for this test only, never stored.')}
                </p>
              </div>
            )}
          </div>
        )}

        <Button
          type="button"
          onClick={() => void run()}
          disabled={running || itemId === null || missingInline}
          className="w-full gap-2 px-3"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {running ? t('deviceChecks.test.running', 'Running (up to 20 s)…') : t('deviceChecks.test.run', 'Run test')}
        </Button>

        {runError && <p className="text-xs text-status-down">{runError}</p>}
        {runIssues.length > 0 && (
          <ul className="max-h-32 space-y-0.5 overflow-y-auto text-[11px] text-status-down">
            {runIssues.map((i, k) => <li key={k}><span className="font-mono">{i.path || t('deviceChecks.test.specRoot', '(spec)')}</span>: {i.message}</li>)}
          </ul>
        )}

        {result && res && (
          <div className="space-y-4 border-t border-border pt-3">
            {/* Summary */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={cn('rounded-full px-2 py-0.5 font-medium', DEVICE_CHECK_TONE_CLASSES[statusTone])}>
                {deviceCheckStatusLabel(result.status, t)}
              </span>
              {res.variantId && <span className="font-mono text-text-secondary">{res.variantId}</span>}
              {res.httpStatus !== undefined && <span className="font-mono text-text-secondary">{t('deviceChecks.test.httpStatus', { status: res.httpStatus, defaultValue: 'HTTP {{status}}' })}</span>}
              <span className="font-mono text-text-muted">{t('deviceChecks.test.durationMs', { ms: Math.round(res.durationMs), defaultValue: '{{ms}} ms' })}</span>
              {res.bytes !== undefined && (
                <span className="font-mono text-text-muted">
                  {t('deviceChecks.test.bytes', { bytes: res.bytes, defaultValue: '{{bytes}} B' })}{res.truncated ? ` (${t('deviceChecks.test.truncated', 'truncated')})` : ''}
                </span>
              )}
              <span className={cn('font-mono', res.macCheck === 'match' ? 'text-accent' : 'text-amber-400')}>
                {t('deviceChecks.test.mac', {
                  state: res.macCheck === 'match' ? t('deviceChecks.test.macMatch', 'verified') : t('deviceChecks.test.macUnverified', 'unverified'),
                  defaultValue: 'MAC {{state}}',
                })}
              </span>
            </div>
            {res.error && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-400">
                <span className="font-medium">{deviceCheckErrorLabel(res.error.code, t) ?? res.error.code}</span>
                {res.error.message && (
                  <span className="block break-words text-text-secondary [overflow-wrap:anywhere]">
                    {isAnonymous ? maskDeviceAddresses(res.error.message) : res.error.message}
                  </span>
                )}
              </p>
            )}

            {/* Trace */}
            <div>
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-text-muted">{t('deviceChecks.test.trace', 'Trace')}</p>
              <TraceView steps={res.trace} />
            </div>

            {/* Values */}
            <div>
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-text-muted">{t('deviceChecks.test.values', 'Extracted values')}</p>
              <table className="w-full text-xs">
                <tbody>
                  {spec.fields.map((f) => {
                    const raw = res.values?.[f.key];
                    let shown = formatDeviceCheckValue(raw ?? null, t, 200);
                    if (f.sensitive && isAnonymous && shown !== '—') shown = anonymize(shown, 'hostname');
                    return (
                      <tr key={f.key} className="border-t border-border first:border-0">
                        <td className="py-1 pr-2 align-top text-text-muted">{f.label || f.key}</td>
                        <td className="break-words py-1 font-mono text-text-primary [overflow-wrap:anywhere]">{shown}</td>
                      </tr>
                    );
                  })}
                  {Object.keys(res.values ?? {}).filter((k) => !fieldByKey.has(k)).length > 0 && (
                    <tr><td colSpan={2} className="pt-1 text-[11px] text-text-muted">{t('deviceChecks.test.undeclared', 'Undeclared values were ignored.')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Assertions */}
            {result.assertions.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11px] uppercase tracking-wide text-text-muted">{t('deviceChecks.test.assertions', 'Checks')}</p>
                <ul className="space-y-1 text-xs">
                  {result.assertions.map((a) => (
                    <li key={a.id} className="flex items-start gap-1.5">
                      {a.skipped
                        ? <MinusCircle size={13} className="mt-0.5 shrink-0 text-zinc-400" />
                        : a.pass
                          ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-accent" />
                          : <XCircle size={13} className="mt-0.5 shrink-0 text-red-400" />}
                      <span className="min-w-0">
                        <span className="text-text-primary">{a.label || a.id}</span>
                        {a.skipped && <span className="ml-1 text-text-muted">({t('deviceChecks.test.skipped', 'skipped')})</span>}
                        {a.actual !== undefined && (
                          <span className="block break-words font-mono text-text-muted [overflow-wrap:anywhere]">
                            {formatDeviceCheckValue(a.actual, t, 200)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Body snippet */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-wide text-text-muted">{t('deviceChecks.test.body', 'Body (first 4 KiB, redacted)')}</p>
                {snippet && <span className="text-[11px] text-text-muted">{t('deviceChecks.test.chars', { chars: snippet.length, defaultValue: '{{chars}} ch' })}</span>}
              </div>
              <div className="flex items-center gap-1.5 text-[11px]">
                <Crosshair size={12} className={activeExtractor ? 'text-accent' : 'text-text-muted'} />
                {activeExtractor ? (
                  <span className="text-text-secondary">
                    {t('deviceChecks.test.target', {
                      target: activeExtractor.label,
                      type: t(`deviceChecks.editor.extract.types.${activeExtractor.type}`, EXTRACTOR_TYPE_FALLBACKS[activeExtractor.type]),
                      defaultValue: 'Copy target: {{target}} ({{type}})',
                    })}
                  </span>
                ) : (
                  <span className="text-text-muted">{t('deviceChecks.test.noActiveExtractor', 'Click the target icon of an extractor row first')}</span>
                )}
              </div>
              {snippet ? (
                <>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t('deviceChecks.test.search', 'Search the body')}
                        className={cn(inputCls, 'pl-7 text-xs')}
                      />
                    </div>
                    {search.trim() && <span className="self-center text-[11px] text-text-muted">{hits}</span>}
                  </div>
                  <pre
                    ref={preRef}
                    className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-primary p-2 font-mono text-[11px] leading-relaxed text-text-secondary"
                  >
                    {parts.map((p, i) => (p.hit
                      ? <mark key={i} className="rounded-sm bg-accent/30 text-text-primary">{p.text}</mark>
                      : <span key={i}>{p.text}</span>))}
                  </pre>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={copySelection}
                    disabled={isAnonymous}
                    className="inline-flex items-center gap-1.5 rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-bg-tertiary disabled:hover:text-text-secondary"
                    title={t('deviceChecks.test.copySelectionHint', 'Regex extractor: the selection is used as the label that precedes the value. JSON / XML extractor: the selection is used as the path.')}
                  >
                    <Crosshair size={12} />{t('deviceChecks.test.copySelection', 'Copy the selection to the extractor')}
                  </button>
                  {isAnonymous && (
                    <p className="text-[11px] text-text-muted">
                      {t('deviceChecks.test.copySelectionAnonymous', 'Anonymous mode masks the body: turn it off to copy a selection to the extractor.')}
                    </p>
                  )}

                  {paths && paths.list.length > 0 && (
                    <div>
                      <p className="mb-1 text-[11px] text-text-muted">
                        {paths.kind === 'json'
                          ? t('deviceChecks.test.jsonPaths', 'JSON paths (click to copy to the extractor)')
                          : t('deviceChecks.test.xmlPaths', 'XML paths (click to copy to the extractor)')}
                      </p>
                      <ul className="max-h-48 overflow-y-auto rounded-md bg-bg-primary text-[11px]">
                        {paths.list.map((p) => (
                          <li key={p.path} className="border-b border-border last:border-0">
                            <button
                              type="button"
                              onClick={() => copyPath(paths.kind, p.path)}
                              className="flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-bg-hover"
                            >
                              <span className="shrink-0 font-mono text-accent">{p.path}</span>
                              <span className="min-w-0 truncate font-mono text-text-muted">
                                {isAnonymous ? maskDeviceAddresses(p.value) : p.value}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!paths && (snippet.trim().startsWith('{') || snippet.trim().startsWith('<?xml')) && (
                    <p className="text-[11px] text-text-muted">{t('deviceChecks.test.pathsUnavailable', 'The body is truncated or not valid: paths are not available.')}</p>
                  )}
                </>
              ) : (
                <p className="text-xs text-text-muted">{t('deviceChecks.test.noBody', 'No body was returned.')}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
