/**
 * GeneralSection — name, description and scope (whole tenant / group / site)
 * of a device check rule.
 *
 * Also exports the small form controls shared by every editor section
 * (FormRow, CheckRow, TagListInput, NumberInput, input classes, issue index,
 * device type list), so the sections look and validate the same way.
 */

import { useEffect, useMemo, useState, type ReactNode, type KeyboardEvent, type ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { GroupTreeNode, Site } from '@oblimap/shared';
import type { DeviceCheckIssue } from '@/api/deviceChecks.api';
import { GroupPicker } from '@/components/common/GroupPicker';
import { Checkbox } from '@/components/ui/Checkbox';
import { useAuthStore } from '@/store/authStore';
import { useAnonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';

// ─── Shared form controls ─────────────────────────────────────────────────────

export const inputCls =
  'w-full rounded-md border border-border bg-bg-tertiary px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-muted '
  + 'focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50';

export const invalidCls = 'border-status-down focus:ring-status-down';

/** Every DeviceType value and its English label (re-exported from utils/deviceTypes). */
export { DEVICE_TYPE_OPTIONS, DEVICE_TYPE_FALLBACK_LABELS as DEVICE_TYPE_FALLBACKS } from '@/utils/deviceTypes';

/** Validation issues of the rule, looked up by path ("variants.0.request.port"). */
export interface IssueIndex {
  /** Messages of the issues at exactly this path, joined. */
  at: (path: string) => string | undefined;
  /** Issues at this path or below it. */
  under: (prefix: string) => DeviceCheckIssue[];
  /** Messages of the issues at this path or below it (list inputs: "match.vendorContains.2"), joined. */
  within: (prefix: string) => string | undefined;
}

export function buildIssueIndex(issues: DeviceCheckIssue[]): IssueIndex {
  const byPath = new Map<string, string[]>();
  for (const i of issues) {
    const list = byPath.get(i.path) ?? [];
    if (i.message && !list.includes(i.message)) list.push(i.message);
    byPath.set(i.path, list);
  }
  const under = (prefix: string) => issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));
  return {
    at: (path) => {
      const list = byPath.get(path);
      return list && list.length > 0 ? list.join(' · ') : undefined;
    },
    under,
    within: (prefix) => {
      const messages = [...new Set(under(prefix).map((i) => i.message).filter(Boolean))];
      return messages.length > 0 ? messages.join(' · ') : undefined;
    },
  };
}

export const EMPTY_ISSUES: IssueIndex = buildIssueIndex([]);

export function FormRow({
  label, hint, error, children, className, htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-xs font-medium text-text-secondary">{label}</label>
      )}
      {children}
      {error
        ? <p className="text-xs text-status-down">{error}</p>
        : hint ? <p className="text-[11px] leading-snug text-text-muted">{hint}</p> : null}
    </div>
  );
}

export function CheckRow({
  checked, onChange, label, hint, disabled, id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  id: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} wrapperClassName="mt-0.5" />
      <div className="min-w-0">
        <label htmlFor={id} className={cn('text-sm text-text-primary', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
          {label}
        </label>
        {hint && <p className="text-[11px] leading-snug text-text-muted">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * Number input that keeps what the user types (empty, "-", partial) and emits
 * a number only when the text is a finite number.
 */
export function NumberInput({
  value, onChange, min, max, step, error, className, id, placeholder, disabled,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  error?: string;
  className?: string;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === undefined || Number.isNaN(value) ? '' : String(value));
  useEffect(() => {
    setText((prev) => (prev !== '' && Number(prev) === value ? prev : value === undefined || Number.isNaN(value) ? '' : String(value)));
  }, [value]);
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      value={text}
      min={min}
      max={max}
      step={step ?? 1}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        const n = e.target.value.trim() === '' ? NaN : Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => setText(value === undefined || Number.isNaN(value) ? '' : String(value))}
      className={cn(inputCls, 'tabular-nums', error && invalidCls, className)}
    />
  );
}

/**
 * Tag list editor: Enter, comma or paste adds; Backspace on the empty input
 * removes the last tag. `normalize` returns null to refuse a value.
 */
export function TagListInput({
  values, onChange, placeholder, normalize, max, error, mono, id, disabled,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  normalize?: (raw: string) => string | null;
  max?: number;
  error?: string;
  mono?: boolean;
  id?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const full = max !== undefined && values.length >= max;

  const add = (raw: string) => {
    const parts = raw.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...values];
    let bad: string | null = null;
    for (const p of parts) {
      const v = normalize ? normalize(p) : p;
      if (v === null) { bad = p; continue; }
      if (!next.includes(v) && (max === undefined || next.length < max)) next.push(v);
    }
    setRefused(bad);
    if (next.length !== values.length) onChange(next);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (/[,;\n]/.test(text)) {
      e.preventDefault();
      add(text);
    }
  };

  return (
    <div>
      <div
        className={cn(
          'flex min-h-[34px] flex-wrap items-center gap-1 rounded-md border border-border bg-bg-tertiary px-1.5 py-1',
          'focus-within:ring-1 focus-within:ring-accent',
          error && invalidCls,
          disabled && 'opacity-50',
        )}
      >
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className={cn('inline-flex max-w-full items-center gap-1 rounded bg-bg-hover px-1.5 py-0.5 text-xs text-text-primary', mono && 'font-mono')}
          >
            <span className="truncate">{v}</span>
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(values.filter((_, j) => j !== i))}
                className="text-text-muted hover:text-text-primary"
                aria-label={t('deviceChecks.editor.removeValue', { value: v, defaultValue: 'Remove {{value}}' })}
              >
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        {!full && !disabled && (
          <input
            id={id}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setRefused(null); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => { if (draft.trim()) add(draft); }}
            placeholder={values.length === 0 ? placeholder : undefined}
            className={cn('min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none', mono && 'font-mono')}
          />
        )}
      </div>
      {refused && (
        <p className="mt-1 text-xs text-status-down">
          {t('deviceChecks.editor.valueRefused', { value: refused, defaultValue: '"{{value}}" is not a valid value' })}
        </p>
      )}
    </div>
  );
}

// ─── General section ──────────────────────────────────────────────────────────

export type DeviceCheckScopeKind = 'tenant' | 'group' | 'site';

export interface GeneralValue {
  name: string;
  description: string;
  scope: DeviceCheckScopeKind;
  groupId: number | null;
  siteId: number | null;
}

interface GeneralSectionProps {
  value: GeneralValue;
  onChange: (patch: Partial<GeneralValue>) => void;
  sites: Site[];
  groupTree: GroupTreeNode[];
  errors: IssueIndex;
  /**
   * The author has no full access in the workspace: the server only
   * accepts a group or site they can write, never the whole workspace. The
   * 'whole workspace' option is hidden and only writable groups / sites are
   * listed (the rule's current scope stays shown, flagged, when it is not).
   */
  restricted?: boolean;
}

interface GroupOption {
  id: number;
  /** Path from the root ("Paris / Floor 2"), each segment anonymized. */
  label: string;
}

/** Groups of the tree, depth first, with their path; `keep` filters (ancestors are still walked). */
function flattenGroups(
  tree: GroupTreeNode[],
  keep: (id: number) => boolean,
  mask: (name: string) => string,
  prefix = '',
  out: GroupOption[] = [],
): GroupOption[] {
  for (const node of tree) {
    const label = prefix ? `${prefix} / ${mask(node.name)}` : mask(node.name);
    if (keep(node.id)) out.push({ id: node.id, label });
    flattenGroups(node.children, keep, mask, label, out);
  }
  return out;
}

export function GeneralSection({ value, onChange, sites, groupTree, errors, restricted = false }: GeneralSectionProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  // Subscribed so the lists follow a permissions reload (tenant switch, team change).
  const permissions = useAuthStore((s) => s.permissions);
  const canWriteSite = useAuthStore((s) => s.canWriteSite);
  const canWriteGroup = useAuthStore((s) => s.canWriteGroup);

  const siteOptions = useMemo(
    () => (restricted ? sites.filter((s) => canWriteSite(s.id, s.groupId) || s.id === value.siteId) : sites),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [restricted, sites, value.siteId, permissions, canWriteSite],
  );
  const groupOptions = useMemo(
    () => (restricted
      ? flattenGroups(groupTree, (id) => canWriteGroup(id) || id === value.groupId, (name) => anonymize(name, 'hostname'))
      : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [restricted, groupTree, value.groupId, permissions, canWriteGroup, anonymize],
  );
  const readOnlySuffix = t('deviceChecks.editor.general.notWritable', '(read-only for you)');
  const currentNotWritable = restricted && (
    value.scope === 'tenant'
    || (value.scope === 'site' && value.siteId !== null && !canWriteSite(value.siteId, sites.find((s) => s.id === value.siteId)?.groupId ?? null))
    || (value.scope === 'group' && value.groupId !== null && !canWriteGroup(value.groupId))
  );

  const allScopeOptions: Array<{ kind: DeviceCheckScopeKind; label: string; hint: string }> = [
    {
      kind: 'tenant',
      label: t('deviceChecks.editor.general.scopeTenant', 'Whole workspace'),
      hint: t('deviceChecks.editor.general.scopeTenantHint', 'Every site of this workspace'),
    },
    {
      kind: 'group',
      label: t('deviceChecks.editor.general.scopeGroup', 'Group'),
      hint: t('deviceChecks.editor.general.scopeGroupHint', 'The sites of a group and its sub-groups'),
    },
    {
      kind: 'site',
      label: t('deviceChecks.editor.general.scopeSite', 'Site'),
      hint: t('deviceChecks.editor.general.scopeSiteHint', 'One site only'),
    },
  ];
  // The whole workspace stays shown only on a rule that already has it (read-only for them).
  const scopeOptions = restricted
    ? allScopeOptions.filter((o) => o.kind !== 'tenant' || value.scope === 'tenant')
    : allScopeOptions;

  const scopeError = errors.at('groupId') ?? errors.at('siteId')
    ?? (value.scope === 'group' && value.groupId === null
      ? t('deviceChecks.editor.general.pickGroup', 'Pick a group')
      : value.scope === 'site' && value.siteId === null
        ? t('deviceChecks.editor.general.pickSite', 'Pick a site')
        : undefined);

  return (
    <div className="space-y-4">
      <FormRow label={t('deviceChecks.editor.general.name', 'Name')} error={errors.at('name')} htmlFor="dc-name">
        <input
          id="dc-name"
          value={value.name}
          maxLength={128}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t('deviceChecks.editor.general.namePlaceholder', 'e.g. Barix music playing')}
          className={cn(inputCls, errors.at('name') && invalidCls)}
        />
      </FormRow>

      <FormRow label={t('deviceChecks.editor.general.description', 'Description')} error={errors.at('description')} htmlFor="dc-description">
        <textarea
          id="dc-description"
          value={value.description}
          maxLength={2000}
          rows={2}
          onChange={(e) => onChange({ description: e.target.value })}
          className={cn(inputCls, 'resize-y', errors.at('description') && invalidCls)}
        />
      </FormRow>

      <FormRow label={t('deviceChecks.editor.general.scope', 'Scope')} error={scopeError}>
        <div className={cn('grid grid-cols-1 gap-2', scopeOptions.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
          {scopeOptions.map((o) => (
            <button
              key={o.kind}
              type="button"
              onClick={() => onChange({
                scope: o.kind,
                groupId: o.kind === 'group' ? value.groupId : null,
                siteId: o.kind === 'site' ? value.siteId : null,
              })}
              aria-pressed={value.scope === o.kind}
              className={cn(
                'rounded-md border px-3 py-2 text-left transition-colors',
                value.scope === o.kind
                  ? 'border-accent bg-accent/10'
                  : 'border-border bg-bg-tertiary hover:border-accent/40',
              )}
            >
              <div className={cn('text-sm font-medium', value.scope === o.kind ? 'text-accent' : 'text-text-primary')}>{o.label}</div>
              <div className="text-[11px] text-text-muted">{o.hint}</div>
            </button>
          ))}
        </div>
        {value.scope === 'group' && !restricted && (
          <div className="mt-2">
            <GroupPicker
              value={value.groupId}
              onChange={(groupId) => onChange({ groupId })}
              tree={groupTree}
              placeholder={t('deviceChecks.editor.general.pickGroup', 'Pick a group')}
            />
          </div>
        )}
        {value.scope === 'group' && restricted && (
          <select
            value={value.groupId ?? ''}
            onChange={(e) => onChange({ groupId: e.target.value ? Number(e.target.value) : null })}
            className={cn(inputCls, 'mt-2')}
          >
            <option value="">{t('deviceChecks.editor.general.pickGroup', 'Pick a group')}</option>
            {groupOptions.map((g) => (
              <option key={g.id} value={g.id}>
                {canWriteGroup(g.id) ? g.label : `${g.label} ${readOnlySuffix}`}
              </option>
            ))}
          </select>
        )}
        {value.scope === 'site' && (
          <select
            value={value.siteId ?? ''}
            onChange={(e) => onChange({ siteId: e.target.value ? Number(e.target.value) : null })}
            className={cn(inputCls, 'mt-2')}
          >
            <option value="">{t('deviceChecks.editor.general.pickSite', 'Pick a site')}</option>
            {siteOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {!restricted || canWriteSite(s.id, s.groupId)
                  ? anonymize(s.name, 'hostname')
                  : `${anonymize(s.name, 'hostname')} ${readOnlySuffix}`}
              </option>
            ))}
          </select>
        )}
        {restricted && (
          <p className={cn('mt-1.5 text-[11px] leading-snug', currentNotWritable ? 'text-amber-400' : 'text-text-muted')}>
            {currentNotWritable
              ? t('deviceChecks.editor.general.scopeNotWritable', 'You cannot change a check of this scope: only a group or site you can edit, or a workspace admin.')
              : t('deviceChecks.editor.general.scopeRestrictedHint', 'Only the groups and sites you can edit are listed. A whole-workspace check needs a workspace admin.')}
          </p>
        )}
      </FormRow>
    </div>
  );
}
