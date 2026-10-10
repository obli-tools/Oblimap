import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import type { BusinessHours, SettingValue, SettingsScope } from '@oblimap/shared';
import type { SettingsKey, SettingDefinition } from '@oblimap/shared';
import { InheritanceBadge } from './InheritanceBadge';
import { BusinessHoursEditor } from './BusinessHoursEditor';

/** 'schedule' settings (businessHours) hold a BusinessHours object. */
export type SettingRawValue = number | boolean | string | string[] | number[] | BusinessHours;

interface SettingFieldProps {
  definition: SettingDefinition;
  inheritedValue: SettingValue;
  overrideValue: SettingRawValue | undefined;
  scope: SettingsScope;
  /** Resolves to true when the value was saved. */
  onSave: (key: SettingsKey, value: SettingRawValue) => Promise<boolean>;
  onReset: (key: SettingsKey) => Promise<void>;
}

/** English fallbacks of the 'select' option labels (settings.options.<key>.<value>). */
const OPTION_FALLBACKS: Record<string, string> = {
  'probeUpdatePolicy.auto': 'Automatic',
  'probeUpdatePolicy.manual': 'Manual',
  'probeUpdatePolicy.frozen': 'Frozen',
};

function resolveEffective(inherited: SettingValue): SettingRawValue {
  const v = inherited.value;
  if (v === null || v === undefined) return 0;
  return v as SettingRawValue;
}

export function SettingField({
  definition,
  inheritedValue,
  overrideValue,
  scope,
  onSave,
  onReset,
}: SettingFieldProps) {
  const { t } = useTranslation();
  const hasOverride = overrideValue !== undefined;
  const [isOverriding, setIsOverriding] = useState(hasOverride);
  const effective = resolveEffective(inheritedValue);
  const [localValue, setLocalValue] = useState<SettingRawValue>(overrideValue ?? effective);
  const [saving, setSaving] = useState(false);

  const handleToggleOverride = async () => {
    if (isOverriding) {
      setSaving(true);
      try {
        await onReset(definition.key);
        setIsOverriding(false);
        setLocalValue(effective);
      } finally {
        setSaving(false);
      }
    } else {
      setIsOverriding(true);
      setLocalValue(effective);
    }
  };

  const handleSave = async (val: SettingRawValue): Promise<boolean> => {
    setSaving(true);
    try {
      return await onSave(definition.key, val);
    } finally {
      setSaving(false);
    }
  };

  const disabled = scope !== 'global' && !isOverriding;

  // ── Boolean toggle ─────────────────────────────────────────────────────
  function renderBoolean() {
    const checked = isOverriding ? !!localValue : !!effective;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          const next = !checked;
          setLocalValue(next);
          handleSave(next);
        }}
        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors ${
          checked ? 'bg-accent' : 'bg-bg-hover'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    );
  }

  // ── Number input ───────────────────────────────────────────────────────
  function renderNumber() {
    const val = isOverriding ? (localValue as number) : (effective as number);
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={val}
          onChange={(e) => setLocalValue(parseInt(e.target.value, 10) || 0)}
          onBlur={() => {
            if (isOverriding && localValue !== overrideValue) handleSave(localValue);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isOverriding) handleSave(localValue);
          }}
          disabled={disabled}
          min={definition.min}
          max={definition.max}
          className={`w-24 rounded-md border px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent ${
            disabled
              ? 'border-border bg-bg-tertiary text-text-muted cursor-not-allowed'
              : 'border-border bg-bg-tertiary text-text-primary'
          }`}
        />
        {definition.unit && <span className="text-xs text-text-muted w-12">{definition.unit}</span>}
      </div>
    );
  }

  // ── JSON (subnet/port list) ────────────────────────────────────────────
  function renderJson() {
    const raw = isOverriding ? localValue : effective;
    let arr: string[] = [];
    if (Array.isArray(raw)) arr = raw.map(String);
    else if (typeof raw === 'string') {
      try { arr = JSON.parse(raw); } catch { arr = []; }
    }
    const [input, setInput] = useState('');

    const add = () => {
      const v = input.trim();
      if (!v || arr.includes(v)) return;
      const next = [...arr, v];
      setLocalValue(next);
      setInput('');
      handleSave(next);
    };

    const remove = (i: number) => {
      const next = arr.filter((_, idx) => idx !== i);
      setLocalValue(next);
      handleSave(next);
    };

    return (
      <div className="flex flex-col gap-1.5 min-w-[200px]">
        {arr.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {arr.map((v, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary font-mono"
              >
                {v}
                {!disabled && (
                  <button onClick={() => remove(i)} className="text-text-muted hover:text-red-400 ml-0.5">&times;</button>
                )}
              </span>
            ))}
          </div>
        )}
        {!disabled && (
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              placeholder={definition.key.includes('Subnet') ? '192.168.1.0/24' : '80, 443, 3306'}
              className="w-40 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button onClick={add} className="text-xs text-accent hover:text-accent-hover font-medium px-1">+</button>
          </div>
        )}
        {arr.length === 0 && disabled && (
          <span className="text-xs text-text-muted">—</span>
        )}
      </div>
    );
  }

  // ── Select (probeUpdatePolicy): one of the definition's options ──────────
  function renderSelect() {
    const options = definition.options ?? [];
    const raw = isOverriding ? localValue : effective;
    const val = typeof raw === 'string' && options.includes(raw) ? raw : String(definition.defaultValue);
    return (
      <select
        value={val}
        disabled={disabled || saving}
        onChange={(e) => {
          if (disabled) return;
          const next = e.target.value;
          const previous = localValue;
          setLocalValue(next);
          void handleSave(next).then((ok) => { if (!ok) setLocalValue(previous); });
        }}
        aria-label={t(`settings.keys.${definition.key}`, definition.label)}
        className={`rounded-md border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent ${
          disabled
            ? 'border-border bg-bg-tertiary text-text-muted cursor-not-allowed'
            : 'border-border bg-bg-tertiary text-text-primary'
        }`}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {t(`settings.options.${definition.key}.${option}`, OPTION_FALLBACKS[`${definition.key}.${option}`] ?? option)}
          </option>
        ))}
      </select>
    );
  }

  // ── Schedule (businessHours): full-width editor below the header row ─────
  function renderSchedule() {
    return (
      <BusinessHoursEditor
        value={isOverriding ? localValue : effective}
        disabled={disabled}
        unsaved={scope !== 'global' && isOverriding && overrideValue === undefined}
        onSave={async (next: BusinessHours) => {
          const ok = await handleSave(next);
          if (ok) setLocalValue(next);
          return ok;
        }}
      />
    );
  }

  return (
    <div className="py-3 border-b border-border last:border-b-0">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{t(`settings.keys.${definition.key}`, definition.label)}</span>
            {scope !== 'global' && (
              isOverriding ? (
                <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                  {t('common.override', 'Override')}
                </span>
              ) : (
                <InheritanceBadge setting={inheritedValue} />
              )
            )}
          </div>
          {definition.description && <p className="text-xs text-text-muted mt-0.5">{t(`settings.descriptions.${definition.key}`, definition.description)}</p>}
        </div>

        <div className="flex items-center gap-2">
          {definition.type === 'boolean' && renderBoolean()}
          {definition.type === 'number' && renderNumber()}
          {definition.type === 'json' && renderJson()}
          {definition.type === 'select' && renderSelect()}
        </div>

        {scope !== 'global' && (
          <button
            onClick={handleToggleOverride}
            disabled={saving}
            className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              isOverriding
                ? 'text-amber-500 hover:bg-amber-500/10'
                : 'text-text-muted hover:bg-bg-hover hover:text-text-primary'
            }`}
            title={isOverriding ? t('settings.panel.reset', 'Reset to inherited') : t('settings.panel.overrideLocally', 'Override locally')}
          >
            {isOverriding ? (
              <span className="flex items-center gap-1">
                <RotateCcw size={12} />
                {t('common.reset', 'Reset')}
              </span>
            ) : (
              t('common.override', 'Override')
            )}
          </button>
        )}
      </div>
      {definition.type === 'schedule' && <div className="mt-2">{renderSchedule()}</div>}
    </div>
  );
}
