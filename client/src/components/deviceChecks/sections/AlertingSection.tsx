/**
 * AlertingSection — when a failing check becomes an alert:
 * debounce by runs AND time, recovery, errors, offline devices,
 * business hours with a grace after opening, renotify, channels, and the
 * notification templates (allowlisted {{variables}} only).
 */

import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DEVICE_CHECK_LIMITS, type DeviceCheckAlerting, type DeviceCheckField } from '@oblimap/shared';
import { cn } from '@/utils/cn';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { CheckRow, FormRow, NumberInput, inputCls, invalidCls, type IssueIndex } from './GeneralSection';

const TEMPLATE_VARS = ['rule', 'site', 'device', 'ip', 'mac', 'status', 'failedAssertion', 'error', 'since'] as const;
const RENOTIFY_CHOICES = [0, 900, 1800, 3600, 7200, 14400, 43200, 86400];
const DEFAULT_TITLE = '{{rule}}: {{device}} ({{site}})';
const DEFAULT_MESSAGE = '{{failedAssertion}}{{error}}';

function humanDuration(seconds: number): string {
  if (seconds <= 0) return '0';
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Where the business hours of the rule's scope are set (a group or site page, or the workspace settings). */
export interface BusinessHoursLink {
  to: string;
  label: string;
}

interface AlertingSectionProps {
  alerting: DeviceCheckAlerting;
  onChange: (a: DeviceCheckAlerting) => void;
  fields: DeviceCheckField[];
  errors: IssueIndex;
  /** Link to the page holding the hours of the rule's scope; null keeps the plain hint. */
  hoursLink?: BusinessHoursLink | null;
  /** The form has unsaved changes: following the hours link asks first (the editor has no in-app blocker). */
  unsaved?: boolean;
}

export function AlertingSection({ alerting: al, onChange, fields, errors, hoursLink = null, unsaved = false }: AlertingSectionProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const set = (patch: Partial<DeviceCheckAlerting>) => onChange({ ...al, ...patch });
  const titleRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [target, setTarget] = useState<'titleTemplate' | 'messageTemplate'>('messageTemplate');
  const e = (k: keyof DeviceCheckAlerting) => errors.at(`alerting.${k}`);

  const vars = [...TEMPLATE_VARS, ...fields.filter((f) => !f.sensitive && f.key).map((f) => `value.${f.key}`)];

  const insertVar = (name: string) => {
    const token = `{{${name}}}`;
    const el = target === 'titleTemplate' ? titleRef.current : messageRef.current;
    const current = al[target] ?? '';
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = (current.slice(0, start) + token + current.slice(end)).slice(0, DEVICE_CHECK_LIMITS.maxTemplateLength);
    set(target === 'titleTemplate' ? { titleTemplate: next } : { messageTemplate: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = Math.min(start + token.length, next.length);
      el.setSelectionRange(pos, pos);
    });
  };

  const renotifyChoices = RENOTIFY_CHOICES.includes(al.renotifyEverySeconds)
    ? RENOTIFY_CHOICES
    : [...RENOTIFY_CHOICES, al.renotifyEverySeconds].sort((a, b) => a - b);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        <CheckRow
          id="dc-alert-enabled"
          checked={al.enabled}
          onChange={(enabled) => set({ enabled })}
          label={t('deviceChecks.editor.alerting.enabled', 'Raise alerts')}
          hint={t('deviceChecks.editor.alerting.enabledHint', 'Off: results and history are still recorded, nothing is sent')}
        />
        <FormRow label={t('deviceChecks.editor.alerting.severity', 'Severity')} error={e('severity')} className="w-44">
          <select value={al.severity} onChange={(ev) => set({ severity: ev.target.value as DeviceCheckAlerting['severity'] })} className={inputCls}>
            <option value="down">{t('deviceChecks.editor.alerting.severityDown', 'Down')}</option>
            <option value="warning">{t('deviceChecks.editor.alerting.severityWarning', 'Warning')}</option>
          </select>
        </FormRow>
      </div>

      <div className={cn('space-y-4', !al.enabled && 'opacity-60')}>
        {/* Debounce */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormRow
            label={t('deviceChecks.editor.alerting.failAfter', 'Alert after')}
            hint={t('deviceChecks.editor.alerting.failAfterHint', 'Both conditions must be met: N failing runs in a row AND failing for at least this long')}
            error={e('failAfterRuns') ?? e('failForSeconds')}
          >
            <div className="flex items-center gap-2">
              <NumberInput value={al.failAfterRuns} min={1} max={60} onChange={(failAfterRuns) => set({ failAfterRuns })} error={e('failAfterRuns')} className="w-20" />
              <span className="shrink-0 text-xs text-text-muted">{t('deviceChecks.editor.alerting.runsAnd', 'runs and')}</span>
              <NumberInput value={al.failForSeconds} min={0} max={86400} onChange={(failForSeconds) => set({ failForSeconds })} error={e('failForSeconds')} className="w-24" />
              <span className="shrink-0 text-xs text-text-muted">s ({humanDuration(al.failForSeconds)})</span>
            </div>
          </FormRow>
          <FormRow
            label={t('deviceChecks.editor.alerting.recoverAfter', 'Recover after')}
            hint={t('deviceChecks.editor.alerting.recoverAfterHint', 'N passing runs in a row AND passing for at least this long')}
            error={e('recoverAfterRuns') ?? e('recoverForSeconds')}
          >
            <div className="flex items-center gap-2">
              <NumberInput value={al.recoverAfterRuns} min={1} max={60} onChange={(recoverAfterRuns) => set({ recoverAfterRuns })} error={e('recoverAfterRuns')} className="w-20" />
              <span className="shrink-0 text-xs text-text-muted">{t('deviceChecks.editor.alerting.runsAnd', 'runs and')}</span>
              <NumberInput value={al.recoverForSeconds} min={0} max={3600} onChange={(recoverForSeconds) => set({ recoverForSeconds })} error={e('recoverForSeconds')} className="w-24" />
              <span className="shrink-0 text-xs text-text-muted">s ({humanDuration(al.recoverForSeconds)})</span>
            </div>
          </FormRow>
        </div>

        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <CheckRow
            id="dc-alert-errors"
            checked={al.treatErrorAs === 'fail'}
            onChange={(v) => set({ treatErrorAs: v ? 'fail' : 'ignore' })}
            label={t('deviceChecks.editor.alerting.errorsFail', 'Errors count as failures')}
            hint={t('deviceChecks.editor.alerting.errorsFailHint', 'A device that does not answer (timeout, refused…) counts as failing')}
          />
          <CheckRow
            id="dc-alert-offline"
            checked={al.skipWhenDeviceOffline}
            onChange={(skipWhenDeviceOffline) => set({ skipWhenDeviceOffline })}
            label={t('deviceChecks.editor.alerting.skipOffline', 'Ignore while the device is offline')}
            hint={t('deviceChecks.editor.alerting.skipOfflineHint', 'The "device offline" notification already covers it')}
          />
        </div>

        {/* Business hours */}
        <div className="space-y-3 rounded-md bg-bg-tertiary/40 p-3">
          <CheckRow
            id="dc-alert-window"
            checked={al.window === 'businessHours'}
            onChange={(v) => set({ window: v ? 'businessHours' : 'always' })}
            label={t('deviceChecks.editor.alerting.businessHours', 'Only during business hours')}
            hint={(
              <>
                {t('deviceChecks.editor.alerting.businessHoursHint', 'Each device uses the hours of its site, else of its groups, else the workspace defaults (Settings tab). No hours set means always open.')}
                {hoursLink && (
                  <>
                    {' '}
                    <Link
                      to={hoursLink.to}
                      onClick={(ev) => {
                        if (!unsaved) return;
                        // Unsaved changes: ask first, then follow the link.
                        ev.preventDefault();
                        const to = hoursLink.to;
                        void confirm({
                          message: t('deviceChecks.editor.alerting.leaveUnsaved', 'This check has unsaved changes. Leave the editor anyway?'),
                          confirmLabel: t('deviceChecks.editor.alerting.leave', 'Leave'),
                          danger: true,
                        }).then((ok) => { if (ok) navigate(to); });
                      }}
                      className="text-accent hover:underline"
                    >
                      {hoursLink.label}
                    </Link>
                  </>
                )}
              </>
            )}
          />
          {al.window === 'businessHours' && (
            <div className="grid grid-cols-1 gap-4 pl-6 sm:grid-cols-2">
              <FormRow
                label={t('deviceChecks.editor.alerting.grace', 'Grace after opening (seconds)')}
                hint={t('deviceChecks.editor.alerting.graceHint', { value: humanDuration(al.graceAfterOpenSeconds), defaultValue: 'No alert opens during the first {{value}} after opening' })}
                error={e('graceAfterOpenSeconds')}
              >
                <NumberInput value={al.graceAfterOpenSeconds} min={0} max={7200} onChange={(graceAfterOpenSeconds) => set({ graceAfterOpenSeconds })} error={e('graceAfterOpenSeconds')} />
              </FormRow>
              <FormRow label={t('deviceChecks.editor.alerting.onClose', 'When the shop closes during an alert')} error={e('onWindowClose')}>
                <select value={al.onWindowClose} onChange={(ev) => set({ onWindowClose: ev.target.value as DeviceCheckAlerting['onWindowClose'] })} className={inputCls}>
                  <option value="silent">{t('deviceChecks.editor.alerting.onCloseSilent', 'Close it silently')}</option>
                  <option value="notify">{t('deviceChecks.editor.alerting.onCloseNotify', 'Close it and notify')}</option>
                </select>
              </FormRow>
            </div>
          )}
        </div>

        {/* Channels */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <CheckRow id="dc-alert-live" checked={al.liveAlert} onChange={(liveAlert) => set({ liveAlert })} label={t('deviceChecks.editor.alerting.liveAlert', 'Live alert in the app')} />
            <CheckRow id="dc-alert-notify" checked={al.notify} onChange={(notify) => set({ notify })} label={t('deviceChecks.editor.alerting.notify', 'Send a notification (site channels)')} />
            <CheckRow id="dc-alert-recovery" checked={al.notifyRecovery} onChange={(notifyRecovery) => set({ notifyRecovery })} label={t('deviceChecks.editor.alerting.notifyRecovery', 'Notify the recovery')} />
          </div>
          <FormRow
            label={t('deviceChecks.editor.alerting.renotify', 'Remind while still failing')}
            error={e('renotifyEverySeconds')}
          >
            <select
              value={al.renotifyEverySeconds}
              onChange={(ev) => set({ renotifyEverySeconds: Number(ev.target.value) })}
              className={cn(inputCls, e('renotifyEverySeconds') && invalidCls)}
            >
              {renotifyChoices.map((s) => (
                <option key={s} value={s}>
                  {s === 0
                    ? t('deviceChecks.editor.alerting.renotifyNever', 'Never')
                    : t('deviceChecks.editor.alerting.renotifyEvery', { value: humanDuration(s), defaultValue: 'Every {{value}}' })}
                </option>
              ))}
            </select>
          </FormRow>
        </div>

        {/* Templates */}
        <div className="space-y-2">
          <FormRow
            label={t('deviceChecks.editor.alerting.titleTemplate', 'Notification title')}
            error={e('titleTemplate')}
          >
            <input
              ref={titleRef}
              value={al.titleTemplate ?? ''}
              maxLength={DEVICE_CHECK_LIMITS.maxTemplateLength}
              onFocus={() => setTarget('titleTemplate')}
              onChange={(ev) => set({ titleTemplate: ev.target.value || undefined })}
              placeholder={DEFAULT_TITLE}
              className={cn(inputCls, 'font-mono text-xs', e('titleTemplate') && invalidCls)}
            />
          </FormRow>
          <FormRow
            label={t('deviceChecks.editor.alerting.messageTemplate', 'Notification message')}
            error={e('messageTemplate')}
          >
            <textarea
              ref={messageRef}
              value={al.messageTemplate ?? ''}
              maxLength={DEVICE_CHECK_LIMITS.maxTemplateLength}
              rows={2}
              onFocus={() => setTarget('messageTemplate')}
              onChange={(ev) => set({ messageTemplate: ev.target.value || undefined })}
              placeholder={DEFAULT_MESSAGE}
              className={cn(inputCls, 'resize-y font-mono text-xs', e('messageTemplate') && invalidCls)}
            />
          </FormRow>
          <div>
            <p className="mb-1 text-[11px] text-text-muted">
              {target === 'titleTemplate'
                ? t('deviceChecks.editor.alerting.insertInTitle', 'Click a variable to insert it in the title:')
                : t('deviceChecks.editor.alerting.insertInMessage', 'Click a variable to insert it in the message:')}
            </p>
            <div className="flex flex-wrap gap-1">
              {vars.map((v) => (
                <button
                  key={v}
                  type="button"
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => insertVar(v)}
                  className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[11px] text-text-secondary hover:bg-bg-hover hover:text-accent"
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-text-muted">
              {t('deviceChecks.editor.alerting.templatesHint', 'Empty = default text. Sensitive fields cannot be used in templates.')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
