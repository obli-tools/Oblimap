/**
 * DeviceCheckEditPage — create or edit a device check rule.
 *
 * Routes: /manage/device-checks/new[?preset=<key>] and /manage/device-checks/:id.
 * Two columns: the form (accordion sections) on the left, a sticky Test panel
 * on the right (stacked on small screens). The form is fully form-based: the
 * only raw JSON is the read-only Advanced view and its import, which goes
 * through POST /device-checks/validate.
 *
 * Live validation calls POST /device-checks/validate 500 ms after the last
 * change and maps issues[].path onto the fields. Rules are created disabled;
 * "Enable after save" sends a separate, audited enable call.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle, ChevronDown, ChevronRight, ListChecks, Loader2, Save, ShieldAlert,
} from 'lucide-react';
import {
  getDeviceCheckPreset,
  type DeviceCheckPreset,
  type DeviceCheckRule,
  type DeviceCheckSpec,
  type DeviceCheckTestResponse,
  type GroupTreeNode,
  type Site,
} from '@oblimap/shared';
import {
  DEFAULT_DEVICE_CHECKS_POLICY,
  deviceChecksApi,
  describeDeviceCheckError,
  deviceCheckErrorLabel,
  parseDeviceCheckError,
  type DeviceCheckIssue,
  type DeviceCheckRulePatch,
  type DeviceChecksPolicy,
} from '@/api/deviceChecks.api';
import { siteApi } from '@/api/site.api';
import { usersApi } from '@/api/users.api';
import { useGroupStore } from '@/store/groupStore';
import { useFullAccess } from '@/store/authStore';
import { useAnonymize } from '@/utils/anonymize';
import { apiErrorMessage, isHandled } from '@/utils/apiError';
import { cn } from '@/utils/cn';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/common/Button';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { LoadError } from '@/components/common/LoadError';
import { DeviceCheckIconGlyph } from '@/components/deviceChecks/DeviceCheckChip';
import { TestPanel, type ActiveExtractorInfo } from '@/components/deviceChecks/TestPanel';
import { GeneralSection, buildIssueIndex, type GeneralValue } from '@/components/deviceChecks/sections/GeneralSection';
import { MatchSection, cleanMatch } from '@/components/deviceChecks/sections/MatchSection';
import { FieldsSection } from '@/components/deviceChecks/sections/FieldsSection';
import { VariantsSection, newVariant, type ExtractorPosition } from '@/components/deviceChecks/sections/VariantsSection';
import { AssertionsSection } from '@/components/deviceChecks/sections/AssertionsSection';
import { DisplaySection } from '@/components/deviceChecks/sections/DisplaySection';
import { ScheduleSection } from '@/components/deviceChecks/sections/ScheduleSection';
import { AlertingSection, type BusinessHoursLink } from '@/components/deviceChecks/sections/AlertingSection';
import { CredentialsSection } from '@/components/deviceChecks/sections/CredentialsSection';
import { AdvancedSection, type ImportedRuleMeta } from '@/components/deviceChecks/sections/AdvancedSection';

// ─── Spec helpers ─────────────────────────────────────────────────────────────

const VALIDATE_DEBOUNCE_MS = 500;
const VALIDATE_PAUSE_MS = 60_000;
const ID_RE = /^[1-9]\d{0,9}$/;

/** Where the editor goes back to: the Device checks tab of the Policies hub. */
const LIST_PATH = '/policies?tab=checks';

type SectionKey =
  | 'general' | 'match' | 'fields' | 'variants' | 'assertions' | 'display' | 'schedule' | 'alerting' | 'credentials' | 'advanced';

/** Rule-level (not spec) paths, shown in the General section. */
const GENERAL_PATHS = ['name', 'description', 'groupId', 'siteId', 'presetKey', 'presetVersion', 'enabled'];

function sectionOfPath(path: string): SectionKey | null {
  const head = path.split('.')[0];
  if (GENERAL_PATHS.includes(head)) return 'general';
  switch (head) {
    case 'match': return 'match';
    case 'fields': return 'fields';
    case 'variants': return 'variants';
    case 'assertions': return 'assertions';
    case 'display': return 'display';
    case 'schedule': return 'schedule';
    case 'alerting': return 'alerting';
    default: return null;
  }
}

function blankSpec(allowedPorts: number[]): DeviceCheckSpec {
  return {
    schemaVersion: 1,
    match: { requireMac: true },
    schedule: { intervalSeconds: 60, jitterSeconds: 10, timeoutMs: 5000 },
    fields: [],
    variants: [newVariant([], allowedPorts)],
    assertions: [],
    display: { icon: 'info' },
    alerting: {
      enabled: true, severity: 'down',
      failAfterRuns: 3, failForSeconds: 180, recoverAfterRuns: 2, recoverForSeconds: 60,
      treatErrorAs: 'fail', skipWhenDeviceOffline: true,
      window: 'always', graceAfterOpenSeconds: 0, onWindowClose: 'silent',
      renotifyEverySeconds: 0, notify: true, notifyRecovery: true, liveAlert: true,
    },
  };
}

/** Deep copy of a JSON value (presets and loaded rules are never edited in place). */
function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Fills missing top-level parts of a spec coming from the server or an import. */
function ensureSpecShape(spec: Partial<DeviceCheckSpec> | null | undefined): DeviceCheckSpec {
  const base = blankSpec(DEFAULT_DEVICE_CHECKS_POLICY.allowedPorts);
  const s = spec ?? {};
  return {
    schemaVersion: 1,
    match: s.match ?? base.match,
    schedule: { ...base.schedule, ...(s.schedule ?? {}) },
    fields: Array.isArray(s.fields) ? s.fields : [],
    variants: Array.isArray(s.variants) ? s.variants.map((v) => ({ ...v, extract: Array.isArray(v.extract) ? v.extract : [] })) : base.variants,
    assertions: Array.isArray(s.assertions) ? s.assertions : [],
    display: s.display ?? base.display,
    alerting: { ...base.alerting, ...(s.alerting ?? {}) },
  };
}

/**
 * Clone of a preset spec, with field and check labels translated
 * (deviceChecks.presets.<key>.fields.<field> / .assertions.<id>).
 */
function clonePresetSpec(preset: DeviceCheckPreset, t: (k: string, d: string) => string): DeviceCheckSpec {
  const spec = cloneJson(preset.spec);
  spec.fields = spec.fields.map((f) => ({ ...f, label: t(`deviceChecks.presets.${preset.key}.fields.${f.key}`, f.label) }));
  spec.assertions = spec.assertions.map((a) => ({ ...a, label: t(`deviceChecks.presets.${preset.key}.assertions.${a.id}`, a.label) }));
  return spec;
}

/** The spec as it is sent: empty match lists dropped, requireMac forced by Basic auth. */
function normalizeSpec(spec: DeviceCheckSpec): DeviceCheckSpec {
  const basic = spec.variants.some((v) => v.request.auth === 'basic');
  return { ...spec, match: { ...cleanMatch(spec.match), requireMac: spec.match.requireMac || basic } };
}

/** JSON with sorted keys and without undefined (PostgreSQL jsonb reorders keys). */
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') {
      return Object.keys(x as Record<string, unknown>)
        .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => { acc[k] = sort((x as Record<string, unknown>)[k]); return acc; }, {});
    }
    return x;
  };
  return JSON.stringify(sort(v));
}

function collectGroupIds(tree: GroupTreeNode[], rootId: number): Set<number> {
  const ids = new Set<number>();
  const add = (n: GroupTreeNode) => { ids.add(n.id); n.children.forEach(add); };
  const find = (nodes: GroupTreeNode[]): boolean => {
    for (const n of nodes) {
      if (n.id === rootId) { add(n); return true; }
      if (find(n.children)) return true;
    }
    return false;
  };
  find(tree);
  return ids;
}

interface Draft {
  general: GeneralValue;
  presetKey: string | null;
  presetVersion: number | null;
  spec: DeviceCheckSpec;
}

function draftFromRule(rule: DeviceCheckRule): Draft {
  return {
    general: {
      name: rule.name,
      description: rule.description ?? '',
      scope: rule.siteId !== null ? 'site' : rule.groupId !== null ? 'group' : 'tenant',
      groupId: rule.groupId,
      siteId: rule.siteId,
    },
    presetKey: rule.presetKey,
    presetVersion: rule.presetVersion,
    spec: ensureSpecShape(cloneJson(rule.spec)),
  };
}

function snapshotOf(d: Draft): string {
  return canonical({ g: { ...d.general, name: d.general.name.trim(), description: d.general.description.trim() }, s: normalizeSpec(d.spec) });
}

// ─── Accordion ────────────────────────────────────────────────────────────────

function Section({
  id, title, summary, issues, open, onToggle, children,
}: {
  id: SectionKey;
  title: string;
  summary?: ReactNode;
  issues: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section id={`dc-section-${id}`} className="scroll-mt-4 rounded-xl bg-bg-secondary">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left hover:bg-bg-hover/40 coarse:min-h-11"
      >
        {open ? <ChevronDown size={15} className="text-text-muted" /> : <ChevronRight size={15} className="text-text-muted" />}
        <span className="text-sm font-semibold text-text-primary">{title}</span>
        {summary && <span className="min-w-0 truncate text-xs text-text-muted">{summary}</span>}
        {issues > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-status-down/15 px-2 py-0.5 text-[11px] font-medium text-status-down">
            {t('deviceChecks.editor.issueCount', { count: issues, defaultValue: '{{count}} to fix' })}
          </span>
        )}
      </button>
      {open && <div className="border-t border-border px-4 py-4">{children}</div>}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function DeviceCheckEditPage() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const navigate = useNavigate();
  const { id: idParam } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const presetParam = searchParams.get('preset');

  const isNew = idParam === undefined;
  const ruleId = !isNew && ID_RE.test(idParam) ? Number(idParam) : null;
  const badId = !isNew && ruleId === null;

  // Without full access a check is scoped to a group or site the
  // author can edit (the server refuses anything else with scope_not_allowed).
  const fullAccess = useFullAccess();
  const restricted = !fullAccess;
  const restrictedRef = useRef(restricted);
  restrictedRef.current = restricted;

  /**
   * The server's refusal, readable: a known device-check code, the scope
   * refusal, else the server's sentence (apiErrorMessage), else `fallback`.
   */
  const refusalMessage = (err: unknown, fallback: string): string => {
    const e = parseDeviceCheckError(err);
    if (e.code === 'scope_not_allowed') {
      return t('deviceChecks.errors.scope_not_allowed', 'You can only manage checks of a group or site you can edit (a whole-workspace check needs a workspace admin)');
    }
    return deviceCheckErrorLabel(e.code, t) ?? apiErrorMessage(err, fallback);
  };

  const { tree, fetchTree } = useGroupStore();
  const [sites, setSites] = useState<Site[]>([]);
  const [policy, setPolicy] = useState<DeviceChecksPolicy>(DEFAULT_DEVICE_CHECKS_POLICY);
  const [userNames, setUserNames] = useState<Map<number, string>>(new Map());

  const [rule, setRule] = useState<DeviceCheckRule | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [snapshot, setSnapshot] = useState('');
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [specIssues, setSpecIssues] = useState<DeviceCheckIssue[]>([]);
  const [generalIssues, setGeneralIssues] = useState<DeviceCheckIssue[]>([]);
  const [validating, setValidating] = useState(false);
  const [validateNote, setValidateNote] = useState<string | null>(null);
  const validateSeq = useRef(0);
  const validatePausedUntil = useRef(0);

  const [saving, setSaving] = useState(false);
  const [enableAfterSave, setEnableAfterSave] = useState(false);
  const [lastTest, setLastTest] = useState<DeviceCheckTestResponse | null>(null);
  const [activeExtractor, setActiveExtractor] = useState<ExtractorPosition | null>(null);
  const [open, setOpen] = useState<Set<SectionKey>>(() => new Set<SectionKey>(['general', 'match']));

  // Read by the route effect and after awaits, without re-running anything.
  const ruleRef = useRef<DeviceCheckRule | null>(rule);
  ruleRef.current = rule;
  const routeRuleId = useRef<number | null>(ruleId);
  routeRuleId.current = ruleId;

  // ── Reference data (sites, groups, policy, users) ──
  useEffect(() => {
    siteApi.list().then(({ sites: list }) => setSites([...list].sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {});
    deviceChecksApi.getPolicy().then(setPolicy).catch(() => { /* defaults */ });
    usersApi.list()
      .then((users) => setUserNames(new Map(users.map((u) => [u.id, u.displayName || u.username]))))
      .catch(() => {});
    if (useGroupStore.getState().tree.length === 0) void fetchTree();
  }, [fetchTree]);

  // ── Rule / preset / blank ──
  const loadRule = useCallback(async (id: number, resetDraft: boolean) => {
    try {
      const r = await deviceChecksApi.get(id);
      if (routeRuleId.current !== id) return; // the route moved to another rule meanwhile
      setRule(r);
      if (resetDraft) {
        const d = draftFromRule(r);
        setDraft(d);
        setSnapshot(snapshotOf(d));
      }
      setLoadError(null);
    } catch (err) {
      if (routeRuleId.current !== id) return;
      const e = parseDeviceCheckError(err);
      setLoadError(e.status === 404
        ? t('deviceChecks.editor.notFound', 'This check does not exist, or it belongs to another workspace.')
        : describeDeviceCheckError(err, t, t('deviceChecks.editor.loadFailed', 'Failed to load the check')));
    } finally {
      if (routeRuleId.current === id) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    // The rule save() just created (new → :id): it is already loaded, so the
    // page, and the Test panel's site, device and result, stay as they are.
    if (ruleId !== null && ruleRef.current?.id === ruleId) return;
    // Another rule, or a new one: nothing of the previous one carries over.
    setRule(null);
    setLoadError(null);
    setLastTest(null);
    setActiveExtractor(null);
    setSpecIssues([]);
    setGeneralIssues([]);
    setEnableAfterSave(false);
    if (ruleId !== null) {
      setDraft(null);
      setLoading(true);
      void loadRule(ruleId, true);
      return;
    }
    if (!isNew) return;
    let d: Draft;
    // A whole-workspace check is for full access only: others start on a site.
    const defaultScope: GeneralValue['scope'] = restrictedRef.current ? 'site' : 'tenant';
    const preset = presetParam ? getDeviceCheckPreset(presetParam) : undefined;
    if (presetParam && !preset) {
      toast.error(t('deviceChecks.editor.unknownPreset', 'Unknown preset: starting from a blank rule'));
    }
    if (preset) {
      d = {
        general: {
          name: t(preset.titleKey, preset.titleFallback).slice(0, 128),
          description: t(preset.descriptionKey, preset.descriptionFallback),
          scope: defaultScope,
          groupId: null,
          siteId: null,
        },
        presetKey: preset.key,
        presetVersion: preset.version,
        spec: clonePresetSpec(preset, (k, fb) => t(k, fb)),
      };
    } else {
      d = {
        general: { name: '', description: '', scope: defaultScope, groupId: null, siteId: null },
        presetKey: null,
        presetVersion: null,
        spec: blankSpec(DEFAULT_DEVICE_CHECKS_POLICY.allowedPorts),
      };
    }
    setDraft(d);
    setSnapshot(snapshotOf(d));
    setLoading(false);
    // Built once per route (preset param); later edits live in the draft.
  }, [ruleId, isNew, presetParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // Full access can become known after the draft was built (tenant list
  // still loading): a new, untouched draft then moves to the whole-workspace
  // default it would have had.
  useEffect(() => {
    if (!fullAccess || !isNew || !draft) return;
    if (draft.general.scope !== 'site' || draft.general.siteId !== null) return;
    if (snapshotOf(draft) !== snapshot) return;
    const d: Draft = { ...draft, general: { ...draft.general, scope: 'tenant' } };
    setDraft(d);
    setSnapshot(snapshotOf(d));
  }, [fullAccess, isNew, draft, snapshot]);

  // ── Live validation (debounced) ──
  const specJson = useMemo(() => (draft ? JSON.stringify(normalizeSpec(draft.spec)) : ''), [draft]);
  useEffect(() => {
    const seq = ++validateSeq.current; // also drops an answer still in flight for the previous rule
    if (!specJson) return;
    const timer = setTimeout(async () => {
      if (Date.now() < validatePausedUntil.current) return;
      setValidating(true);
      try {
        const res = await deviceChecksApi.validate(JSON.parse(specJson) as DeviceCheckSpec);
        if (seq !== validateSeq.current) return;
        setSpecIssues(res.issues.filter((i) => sectionOfPath(i.path) !== 'general'));
        setValidateNote(null);
      } catch (err) {
        if (seq !== validateSeq.current) return;
        const e = parseDeviceCheckError(err);
        if (e.status === 429) {
          validatePausedUntil.current = Date.now() + VALIDATE_PAUSE_MS;
          setValidateNote(t('deviceChecks.editor.validatePaused', 'Live validation paused for a minute (too many requests). Saving still validates.'));
        } else {
          setValidateNote(t('deviceChecks.editor.validateUnavailable', 'Live validation is unavailable. Saving still validates.'));
        }
      } finally {
        if (seq === validateSeq.current) setValidating(false);
      }
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [specJson, t]);

  const issues = useMemo(() => [...generalIssues, ...specIssues], [generalIssues, specIssues]);
  const errors = useMemo(() => buildIssueIndex(issues), [issues]);
  const issuesBySection = useMemo(() => {
    const m = new Map<SectionKey | null, number>();
    for (const i of issues) {
      const s = sectionOfPath(i.path);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [issues]);

  const dirty = !!draft && snapshotOf(draft) !== snapshot;
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // ── Derived ──
  const spec = draft?.spec;
  const usesBasic = !!spec?.variants.some((v) => v.request.auth === 'basic');
  const preset = draft?.presetKey ? getDeviceCheckPreset(draft.presetKey) : undefined;
  const presetUpdate = preset && draft?.presetVersion != null && preset.version > draft.presetVersion ? preset.version : null;

  const scopeSites = useMemo(() => {
    if (!draft) return sites;
    const g = draft.general;
    if (g.scope === 'site' && g.siteId !== null) return sites.filter((s) => s.id === g.siteId);
    if (g.scope === 'group' && g.groupId !== null) {
      const ids = collectGroupIds(tree, g.groupId);
      return sites.filter((s) => s.groupId !== null && ids.has(s.groupId));
    }
    return sites;
  }, [draft, sites, tree]);

  const activeInfo: ActiveExtractorInfo | null = useMemo(() => {
    if (!spec || !activeExtractor) return null;
    const x = spec.variants[activeExtractor.variant]?.extract[activeExtractor.index];
    if (!x) return null;
    return { label: `#${activeExtractor.variant + 1} › ${x.field || '?'}`, type: x.type };
  }, [spec, activeExtractor]);

  const normalizedSpec = useMemo(() => (spec ? normalizeSpec(spec) : null), [spec]);

  // ── Updaters ──
  const setSpec = useCallback((updater: (s: DeviceCheckSpec) => DeviceCheckSpec) => {
    setDraft((d) => (d ? { ...d, spec: updater(d.spec) } : d));
  }, []);

  const toggle = (k: SectionKey) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const reveal = (k: SectionKey) => {
    setOpen((prev) => new Set(prev).add(k));
    requestAnimationFrame(() => document.getElementById(`dc-section-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const copyToExtractor = (kind: 'pattern' | 'path', value: string) => {
    if (!activeExtractor) return;
    setSpec((s) => ({
      ...s,
      variants: s.variants.map((v, vi) => (vi !== activeExtractor.variant ? v : {
        ...v,
        extract: v.extract.map((x, xi) => {
          if (xi !== activeExtractor.index) return x;
          if (kind === 'pattern' && x.type === 'regex') return { ...x, pattern: value, group: 1 };
          if (kind === 'path' && (x.type === 'json' || x.type === 'xml')) return { ...x, path: value };
          return x;
        }),
      })),
    }));
    setOpen((prev) => new Set(prev).add('variants'));
  };

  // Removing a field also removes the extractors that read it: keep the
  // "copy to extractor" target on its row (found by identity, the kept rows are
  // the same objects), or clear it when that row went.
  const onFieldsChange = (next: DeviceCheckSpec) => {
    if (spec && activeExtractor) {
      const before = spec.variants[activeExtractor.variant]?.extract ?? [];
      const after = next.variants[activeExtractor.variant]?.extract ?? [];
      if (after.length !== before.length) {
        const index = after.indexOf(before[activeExtractor.index]);
        setActiveExtractor(index === -1 ? null : { ...activeExtractor, index });
      }
    }
    setSpec(() => next);
  };

  const onImport = (imported: DeviceCheckSpec, meta: ImportedRuleMeta) => {
    setDraft((d) => {
      if (!d) return d;
      const general = { ...d.general };
      if (meta.name && !general.name.trim()) general.name = meta.name;
      if (meta.description !== undefined && !general.description.trim()) general.description = meta.description ?? '';
      return { ...d, general, spec: ensureSpecShape(cloneJson(imported)) };
    });
    setActiveExtractor(null);
  };

  // ── Save ──
  const save = async () => {
    if (!draft || !normalizedSpec) return;
    const g = draft.general;
    const local: DeviceCheckIssue[] = [];
    if (!g.name.trim()) local.push({ path: 'name', message: t('deviceChecks.editor.general.nameRequired', 'A name is required') });
    if (g.scope === 'group' && g.groupId === null) local.push({ path: 'groupId', message: t('deviceChecks.editor.general.pickGroup', 'Pick a group') });
    if (g.scope === 'site' && g.siteId === null) local.push({ path: 'siteId', message: t('deviceChecks.editor.general.pickSite', 'Pick a site') });
    if (local.length > 0) {
      setGeneralIssues(local);
      reveal('general');
      return;
    }

    const body = {
      name: g.name.trim(),
      description: g.description.trim() || null,
      groupId: g.scope === 'group' ? g.groupId : null,
      siteId: g.scope === 'site' ? g.siteId : null,
      spec: normalizedSpec,
    };

    setSaving(true);
    try {
      let saved: DeviceCheckRule;
      if (rule === null) {
        saved = await deviceChecksApi.create({ ...body, presetKey: draft.presetKey, presetVersion: draft.presetVersion });
      } else {
        const patch: DeviceCheckRulePatch = {};
        if (body.name !== rule.name) patch.name = body.name;
        if (body.description !== (rule.description ?? null)) patch.description = body.description;
        if (body.groupId !== rule.groupId) patch.groupId = body.groupId;
        if (body.siteId !== rule.siteId) patch.siteId = body.siteId;
        if (canonical(body.spec) !== canonical(rule.spec)) patch.spec = body.spec;
        if (draft.presetVersion !== rule.presetVersion) patch.presetVersion = draft.presetVersion;
        saved = Object.keys(patch).length > 0 || rule.suspendedReason
          ? await deviceChecksApi.update(rule.id, Object.keys(patch).length > 0 ? patch : { name: body.name })
          : rule;
      }
      if (!saved || typeof saved.id !== 'number') {
        // Unexpected answer shape: the rule exists, go back to the list.
        toast.success(t('deviceChecks.editor.saved', 'Check saved'));
        navigate(LIST_PATH);
        return;
      }

      if (enableAfterSave && !saved.enabled) {
        try {
          const enabled = await deviceChecksApi.enable(saved.id);
          saved = enabled ?? { ...saved, enabled: true };
          toast.success(t('deviceChecks.editor.savedEnabled', 'Check saved and enabled'));
        } catch (err) {
          if (!isHandled(err)) toast.error(refusalMessage(err, t('deviceChecks.editor.enableFailed', 'Saved, but enabling failed')));
        }
      } else {
        toast.success(t('deviceChecks.editor.saved', 'Check saved'));
      }

      setGeneralIssues([]);
      setEnableAfterSave(false);
      setRule(saved);
      const d = draftFromRule(saved);
      setDraft(d);
      setSnapshot(snapshotOf(d));
      if (rule === null) navigate(`/manage/device-checks/${saved.id}`, { replace: true });
    } catch (err) {
      const e = parseDeviceCheckError(err);
      if (e.issues.length > 0) {
        setGeneralIssues(e.issues.filter((i) => sectionOfPath(i.path) === 'general'));
        const specOnes = e.issues.filter((i) => sectionOfPath(i.path) !== 'general');
        if (specOnes.length > 0) setSpecIssues(specOnes);
        const first = e.issues.map((i) => sectionOfPath(i.path)).find((s): s is SectionKey => s !== null);
        if (first) reveal(first);
        toast.error(t('deviceChecks.editor.fixErrors', 'Fix the highlighted fields'));
      } else if (e.status === 409 && !e.code) {
        setGeneralIssues([{ path: 'name', message: e.message ?? t('deviceChecks.editor.nameTaken', 'Another check already has this name') }]);
        reveal('general');
        toast.error(e.message ?? t('deviceChecks.editor.nameTaken', 'Another check already has this name'));
      } else if (e.code === 'scope_not_allowed') {
        // The scope is not a group or site the author can edit.
        const message = refusalMessage(err, t('deviceChecks.editor.saveFailed', 'Failed to save the check'));
        setGeneralIssues([{ path: g.scope === 'group' ? 'groupId' : 'siteId', message }]);
        reveal('general');
        if (!isHandled(err)) toast.error(message);
      } else if (!isHandled(err)) {
        toast.error(refusalMessage(err, t('deviceChecks.editor.saveFailed', 'Failed to save the check')));
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Render ──
  if (badId || loadError) {
    return (
      <PageContainer
        title={t('deviceChecks.editor.back', 'Device checks')}
        icon={<ListChecks className="h-5 w-5" />}
        backTo={LIST_PATH}
      >
        <LoadError
          message={loadError ?? t('deviceChecks.editor.notFound', 'This check does not exist, or it belongs to another workspace.')}
          onRetry={loadError && ruleId !== null ? () => { setLoading(true); setLoadError(null); void loadRule(ruleId, true); } : undefined}
        />
      </PageContainer>
    );
  }

  if (loading || !draft || !spec || !normalizedSpec) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={28} />
      </div>
    );
  }

  const g = draft.general;
  const sectionIssues = (k: SectionKey) => issuesBySection.get(k) ?? 0;
  const otherIssues = issues.filter((i) => sectionOfPath(i.path) === null);
  const updatedBy = rule?.updatedBy != null ? userNames.get(rule.updatedBy) : undefined;
  const matchCriteria = (spec.match.vendorContains?.length ?? 0) + (spec.match.macPrefixes?.length ?? 0)
    + (spec.match.deviceTypes?.length ?? 0) + (spec.match.itemIds?.length ?? 0);
  const scopeSummary = g.scope === 'site'
    ? anonymize(sites.find((s) => s.id === g.siteId)?.name ?? t('deviceChecks.editor.general.scopeSite', 'Site'), 'hostname')
    : g.scope === 'group'
      ? t('deviceChecks.editor.general.scopeGroup', 'Group')
      : t('deviceChecks.editor.general.scopeTenant', 'Whole workspace');
  // Business hours come from each device's settings chain; link to the page of the rule's scope.
  const hoursLink: BusinessHoursLink | null = g.scope === 'site'
    ? (g.siteId !== null ? { to: `/sites/${g.siteId}?tab=settings`, label: t('deviceChecks.editor.alerting.hoursLinkSite', 'Open the site (Settings tab)') } : null)
    : g.scope === 'group'
      ? (g.groupId !== null ? { to: `/group/${g.groupId}/edit?section=settings`, label: t('deviceChecks.editor.alerting.hoursLinkGroupSettings', 'Open the group settings') } : null)
      : { to: '/policies?tab=defaults', label: t('deviceChecks.editor.alerting.hoursLinkWorkspace', 'Open the workspace default settings') };

  return (
    <PageContainer className="space-y-5">
      {/* Header */}
      <div className="space-y-3">
        <PageHeader
          className="mb-0"
          backTo={LIST_PATH}
          backLabel={t('deviceChecks.editor.back', 'Device checks')}
          icon={<DeviceCheckIconGlyph icon={spec.display.icon} size={18} />}
          title={g.name.trim() || (rule ? rule.name : t('deviceChecks.editor.newTitle', 'New device check'))}
          actions={
            <>
              {validating && <Loader2 size={14} className="animate-spin text-text-muted" aria-label={t('deviceChecks.editor.validating', 'Validating…')} />}
              {(!rule || !rule.enabled) && (
                <label className="flex items-center gap-1.5 text-sm text-text-secondary coarse:py-2">
                  <Checkbox checked={enableAfterSave} onCheckedChange={setEnableAfterSave} />
                  {t('deviceChecks.editor.enableAfterSave', 'Enable after save')}
                </label>
              )}
              <Button
                onClick={() => void save()}
                loading={saving}
                disabled={!dirty && rule !== null && !rule.suspendedReason && !enableAfterSave}
              >
                {!saving && <Save size={14} className="mr-1.5" />}
                {rule ? t('common.save', 'Save') : t('deviceChecks.editor.create', 'Create')}
              </Button>
            </>
          }
        >
          {(rule || dirty || (preset && !preset.validated) || presetUpdate !== null) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {rule && (
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  rule.enabled ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-muted',
                )}>
                  {rule.enabled ? t('deviceChecks.list.enabled', 'Enabled') : t('deviceChecks.list.disabled', 'Disabled')}
                </span>
              )}
              {dirty && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400">
                  {t('deviceChecks.editor.unsaved', 'Unsaved changes')}
                </span>
              )}
              {preset && !preset.validated && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400" title={t(`deviceChecks.presets.${preset.key}.validationNotes`, preset.validationNotes)}>
                  {t('deviceChecks.list.needsValidation', 'Preset needs validation')}
                </span>
              )}
              {presetUpdate !== null && (
                <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-400">
                  {t('deviceChecks.list.presetUpdate', { version: presetUpdate, defaultValue: 'Preset v{{version}} available' })}
                </span>
              )}
            </div>
          )}
          {rule && (
            <p className="mt-1 text-xs text-text-muted">
              {t('deviceChecks.editor.meta', {
                revision: rule.revision,
                when: new Date(rule.updatedAt).toLocaleString(),
                who: updatedBy ? anonymize(updatedBy, 'username') : rule.updatedBy != null ? `#${rule.updatedBy}` : '—',
                defaultValue: 'Revision {{revision}} · updated {{when}} by {{who}}',
              })}
            </p>
          )}
        </PageHeader>

        {rule?.suspendedReason && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              {rule.suspendedReason === 'accountable_user_invalid'
                ? t('deviceChecks.list.suspended.accountable_user_invalid', 'Suspended: the last person who saved this check is no longer an active admin.')
                : t('deviceChecks.list.suspended.other', { reason: rule.suspendedReason, defaultValue: 'Suspended: {{reason}}' })}
              {' '}
              {t('deviceChecks.editor.suspendedHint', 'Saving it makes you its accountable admin and lifts the suspension.')}
            </span>
          </div>
        )}
        {rule?.enabled && (
          <p className="text-xs text-text-muted">
            {t('deviceChecks.editor.enabledHint', 'This check is enabled: saving sends the changes to the probes right away.')}
          </p>
        )}
        {validateNote && <p className="text-xs text-amber-400">{validateNote}</p>}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        {/* Form */}
        <div className="min-w-0 space-y-3">
          {issues.length > 0 && (
            <div className="rounded-md bg-status-down/10 px-3 py-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-status-down">
                <AlertTriangle size={13} />
                {t('deviceChecks.editor.problems', { count: issues.length, defaultValue: '{{count}} problem(s) to fix before saving' })}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {issues.slice(0, 8).map((i, k) => {
                  const s = sectionOfPath(i.path);
                  return (
                    <li key={k}>
                      <button
                        type="button"
                        onClick={() => s && reveal(s)}
                        className={cn('text-left text-text-secondary', s && 'hover:text-text-primary hover:underline')}
                      >
                        <span className="font-mono text-text-muted">{i.path || '(spec)'}</span> {i.message}
                      </button>
                    </li>
                  );
                })}
                {issues.length > 8 && <li className="text-text-muted">…</li>}
              </ul>
            </div>
          )}

          <Section id="general" title={t('deviceChecks.editor.sections.general', 'General')} summary={scopeSummary}
            issues={sectionIssues('general')} open={open.has('general')} onToggle={() => toggle('general')}>
            <GeneralSection
              value={g}
              onChange={(patch) => {
                setDraft((d) => (d ? { ...d, general: { ...d.general, ...patch } } : d));
                setGeneralIssues([]);
              }}
              sites={sites}
              groupTree={tree}
              errors={errors}
              restricted={restricted}
            />
          </Section>

          <Section id="match" title={t('deviceChecks.editor.sections.match', 'Target devices')}
            summary={t('deviceChecks.editor.summary.match', { count: matchCriteria, defaultValue: '{{count}} criteria' })}
            issues={sectionIssues('match')} open={open.has('match')} onToggle={() => toggle('match')}>
            <MatchSection
              match={spec.match}
              onChange={(match) => setSpec((s) => ({ ...s, match }))}
              requireMacForced={usesBasic}
              errors={errors}
              sites={scopeSites}
              scope={{ groupId: g.scope === 'group' ? g.groupId : null, siteId: g.scope === 'site' ? g.siteId : null }}
            />
          </Section>

          <Section id="fields" title={t('deviceChecks.editor.sections.fields', 'Fields')}
            summary={t('deviceChecks.editor.summary.fields', { count: spec.fields.length, defaultValue: '{{count}} fields' })}
            issues={sectionIssues('fields')} open={open.has('fields')} onToggle={() => toggle('fields')}>
            <FieldsSection spec={spec} onChange={onFieldsChange} errors={errors} />
          </Section>

          <Section id="variants" title={t('deviceChecks.editor.sections.variants', 'Requests and extraction')}
            summary={t('deviceChecks.editor.summary.variants', { count: spec.variants.length, defaultValue: '{{count}} variants' })}
            issues={sectionIssues('variants')} open={open.has('variants')} onToggle={() => toggle('variants')}>
            <VariantsSection
              variants={spec.variants}
              onChange={(variants) => setSpec((s) => ({ ...s, variants }))}
              fields={spec.fields}
              allowedPorts={policy.allowedPorts}
              errors={errors}
              activeExtractor={activeExtractor}
              onActivateExtractor={setActiveExtractor}
            />
          </Section>

          <Section id="assertions" title={t('deviceChecks.editor.sections.assertions', 'Checks')}
            summary={t('deviceChecks.editor.summary.assertions', {
              enabled: spec.assertions.filter((a) => a.enabled).length,
              count: spec.assertions.length,
              defaultValue: '{{enabled}}/{{count}} enabled',
            })}
            issues={sectionIssues('assertions')} open={open.has('assertions')} onToggle={() => toggle('assertions')}>
            <AssertionsSection
              assertions={spec.assertions}
              onChange={(assertions) => setSpec((s) => ({ ...s, assertions }))}
              fields={spec.fields}
              errors={errors}
            />
          </Section>

          <Section id="display" title={t('deviceChecks.editor.sections.display', 'Display')}
            issues={sectionIssues('display')} open={open.has('display')} onToggle={() => toggle('display')}>
            <DisplaySection
              display={spec.display}
              onChange={(display) => setSpec((s) => ({ ...s, display }))}
              fields={spec.fields}
              lastTest={lastTest}
              ruleName={g.name}
              intervalSeconds={spec.schedule.intervalSeconds}
              errors={errors}
            />
          </Section>

          <Section id="schedule" title={t('deviceChecks.editor.sections.schedule', 'Schedule')}
            summary={t('deviceChecks.editor.summary.schedule', { seconds: spec.schedule.intervalSeconds, defaultValue: 'every {{seconds}} s' })}
            issues={sectionIssues('schedule')} open={open.has('schedule')} onToggle={() => toggle('schedule')}>
            <ScheduleSection
              schedule={spec.schedule}
              onChange={(schedule) => setSpec((s) => ({ ...s, schedule }))}
              minIntervalSeconds={policy.minIntervalSeconds}
              errors={errors}
            />
          </Section>

          <Section id="alerting" title={t('deviceChecks.editor.sections.alerting', 'Alerting')}
            summary={spec.alerting.enabled ? t('common.on', 'On') : t('common.off', 'Off')}
            issues={sectionIssues('alerting')} open={open.has('alerting')} onToggle={() => toggle('alerting')}>
            <AlertingSection
              alerting={spec.alerting}
              onChange={(alerting) => setSpec((s) => ({ ...s, alerting }))}
              fields={spec.fields}
              errors={errors}
              hoursLink={hoursLink}
              unsaved={dirty}
            />
          </Section>

          {usesBasic && (
            <Section id="credentials" title={t('deviceChecks.editor.sections.credentials', 'Credentials')}
              summary={t('deviceChecks.editor.summary.credentials', { count: rule?.credentials?.length ?? 0, defaultValue: '{{count}} stored' })}
              issues={0} open={open.has('credentials')} onToggle={() => toggle('credentials')}>
              <CredentialsSection
                ruleId={rule?.id ?? null}
                credentials={rule?.credentials ?? []}
                variants={spec.variants}
                sites={sites}
                overrideSites={scopeSites}
                userNames={userNames}
                onChanged={() => { if (rule) void loadRule(rule.id, false); }}
              />
            </Section>
          )}

          <Section id="advanced" title={t('deviceChecks.editor.sections.advanced', 'Advanced')} summary="JSON"
            issues={otherIssues.length} open={open.has('advanced')} onToggle={() => toggle('advanced')}>
            <AdvancedSection
              spec={normalizedSpec}
              presetKey={draft.presetKey}
              presetVersion={draft.presetVersion}
              onImport={onImport}
            />
          </Section>
        </div>

        {/* Test panel */}
        <div className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <TestPanel
            spec={normalizedSpec}
            ruleId={rule?.id ?? null}
            hasStoredCredentials={(rule?.credentials?.length ?? 0) > 0}
            sites={scopeSites}
            preferredSiteId={g.scope === 'site' ? g.siteId : null}
            activeExtractor={activeInfo}
            onCopyToExtractor={copyToExtractor}
            onResult={setLastTest}
          />
          <p className="mt-2 flex items-start gap-1.5 px-1 text-[11px] text-text-muted">
            <ListChecks size={12} className="mt-0.5 shrink-0" />
            {t('deviceChecks.editor.testHint', 'The test runs the form as it is now, saved or not, through the probe that would run it (it must be connected and up to date).')}
          </p>
        </div>
      </div>
    </PageContainer>
  );
}
