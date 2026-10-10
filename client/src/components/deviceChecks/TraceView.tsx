/**
 * TraceView — the steps of one device check run (target, mac, request:<variant>,
 * decode, extract:<field>, regex:<test>, assert:<id>) as status chips with
 * their duration and detail. Details are probe-supplied text: rendered as
 * text only. In anonymous mode, IP and MAC addresses in details are masked.
 */

import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import type { DeviceCheckTraceStep } from '@oblimap/shared';
import { anonymize, useAnonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';

const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const MAC_RE = /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g;

/** Masks every IPv4 and MAC address in free text (use only in anonymous mode). */
export function maskDeviceAddresses(text: string): string {
  return text
    .replace(IPV4_RE, (ip) => anonymize(ip, 'ip'))
    .replace(MAC_RE, (mac) => anonymize(mac.replace(/-/g, ':'), 'mac'));
}

const STEP_STYLES: Record<DeviceCheckTraceStep['status'], { chip: string; Icon: typeof CheckCircle2 }> = {
  ok: { chip: 'bg-accent/10 text-accent', Icon: CheckCircle2 },
  failed: { chip: 'bg-red-500/10 text-red-400', Icon: XCircle },
  skipped: { chip: 'bg-zinc-500/10 text-zinc-400', Icon: MinusCircle },
};

export interface TraceViewProps {
  steps: DeviceCheckTraceStep[] | null | undefined;
  className?: string;
  /** Text shown when there is no step (default: "No trace for this run."). */
  emptyText?: string;
}

export function TraceView({ steps, className, emptyText }: TraceViewProps) {
  const { t } = useTranslation();
  const { isAnonymous } = useAnonymize();

  if (!steps || steps.length === 0) {
    return (
      <p className={cn('text-xs text-text-muted', className)}>
        {emptyText ?? t('deviceChecks.trace.empty', 'No trace for this run.')}
      </p>
    );
  }

  return (
    <ol className={cn('space-y-1', className)}>
      {steps.map((step, i) => {
        const style = STEP_STYLES[step.status] ?? STEP_STYLES.skipped;
        const detail = step.detail ? (isAnonymous ? maskDeviceAddresses(step.detail) : step.detail) : '';
        const statusText = t(`deviceChecks.trace.status.${step.status}`, step.status);
        return (
          <li key={`${i}-${step.step}`} className="flex min-w-0 items-start gap-2 text-xs">
            <span
              className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px]', style.chip)}
              title={statusText}
            >
              <style.Icon size={11} aria-hidden="true" />
              <span className="max-w-[14rem] truncate">{step.step}</span>
            </span>
            <span className="shrink-0 pt-0.5 font-mono tabular-nums text-text-muted">
              {Number.isFinite(step.ms) ? t('deviceChecks.test.durationMs', { ms: Math.round(step.ms), defaultValue: '{{ms}} ms' }) : ''}
            </span>
            {detail && (
              <span className="min-w-0 break-words pt-0.5 text-text-secondary [overflow-wrap:anywhere]">{detail}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
