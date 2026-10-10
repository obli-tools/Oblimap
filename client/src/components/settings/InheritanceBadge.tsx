import { useTranslation } from 'react-i18next';
import type { SettingValue } from '@oblimap/shared';
import { useAnonymize } from '@/utils/anonymize';

interface InheritanceBadgeProps {
  setting: SettingValue;
}

export function InheritanceBadge({ setting }: InheritanceBadgeProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();

  if (setting.source === 'default') {
    return (
      <span className="text-xs text-text-muted">
        {t('settings.source.default', 'Default')}
      </span>
    );
  }

  if (setting.source === 'global') {
    return (
      <span className="text-xs text-accent">
        {t('common.global', 'Global')}
      </span>
    );
  }

  if (setting.source === 'group') {
    return (
      <span className="text-xs text-accent">
        {setting.sourceName ? anonymize(setting.sourceName, 'hostname') : setting.sourceName}
      </span>
    );
  }

  if (setting.source === 'monitor') {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
        {t('settings.source.override', 'Override')}
      </span>
    );
  }

  return null;
}
