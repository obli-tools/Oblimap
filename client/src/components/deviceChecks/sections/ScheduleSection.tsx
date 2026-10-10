/**
 * ScheduleSection — how often the probe runs the check:
 * interval (from the policy minimum to 1 h), random jitter and timeout.
 */

import { useTranslation } from 'react-i18next';
import { DEVICE_CHECK_LIMITS, type DeviceCheckSchedule } from '@oblimap/shared';
import { FormRow, NumberInput, type IssueIndex } from './GeneralSection';

interface ScheduleSectionProps {
  schedule: DeviceCheckSchedule;
  onChange: (s: DeviceCheckSchedule) => void;
  /** Platform policy minimum interval (never below the compiled 30 s). */
  minIntervalSeconds: number;
  errors: IssueIndex;
}

export function ScheduleSection({ schedule, onChange, minIntervalSeconds, errors }: ScheduleSectionProps) {
  const { t } = useTranslation();
  const minInterval = Math.max(DEVICE_CHECK_LIMITS.minIntervalSeconds, minIntervalSeconds);
  const L = DEVICE_CHECK_LIMITS;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <FormRow
        label={t('deviceChecks.editor.schedule.interval', 'Every (seconds)')}
        hint={t('deviceChecks.editor.schedule.intervalHint', { min: minInterval, max: L.maxIntervalSeconds, defaultValue: 'From {{min}} to {{max}} s' })}
        error={errors.at('schedule.intervalSeconds')}
      >
        <NumberInput
          value={schedule.intervalSeconds}
          min={minInterval}
          max={L.maxIntervalSeconds}
          onChange={(intervalSeconds) => onChange({ ...schedule, intervalSeconds })}
          error={errors.at('schedule.intervalSeconds')}
        />
      </FormRow>
      <FormRow
        label={t('deviceChecks.editor.schedule.jitter', 'Random delay (seconds)')}
        hint={t('deviceChecks.editor.schedule.jitterHint', { max: L.maxJitterSeconds, defaultValue: 'Spreads the runs of many devices, 0 to {{max}} s' })}
        error={errors.at('schedule.jitterSeconds')}
      >
        <NumberInput
          value={schedule.jitterSeconds}
          min={0}
          max={L.maxJitterSeconds}
          onChange={(jitterSeconds) => onChange({ ...schedule, jitterSeconds })}
          error={errors.at('schedule.jitterSeconds')}
        />
      </FormRow>
      <FormRow
        label={t('deviceChecks.editor.schedule.timeout', 'Timeout (ms)')}
        hint={t('deviceChecks.editor.schedule.timeoutHint', { min: L.minTimeoutMs, max: L.maxTimeoutMs, defaultValue: 'Per request, {{min}} to {{max}} ms' })}
        error={errors.at('schedule.timeoutMs')}
      >
        <NumberInput
          value={schedule.timeoutMs}
          min={L.minTimeoutMs}
          max={L.maxTimeoutMs}
          step={500}
          onChange={(timeoutMs) => onChange({ ...schedule, timeoutMs })}
          error={errors.at('schedule.timeoutMs')}
        />
      </FormRow>
    </div>
  );
}
