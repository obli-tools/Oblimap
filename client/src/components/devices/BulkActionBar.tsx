import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, BookmarkPlus, FileDown, Tag, Trash2, X, AlertTriangle } from 'lucide-react';
import type { DeviceType } from '@oblimap/shared';
import { DEVICE_TYPE_OPTIONS, deviceTypeIcon, deviceTypeLabel } from '@/utils/deviceTypes';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { IconButton } from '@/components/common/IconButton';
import { cn } from '@/utils/cn';

/*
 * Sticky bar of the device table's selection (Obliance DeviceTable batch
 * menu, components/devices/DeviceTable.tsx:1046-1100). The table decides
 * what is allowed: the bar only renders the actions it is given.
 *
 *  - `mixedSites`: the selection spans several sites. The bulk route acts
 *    on one site at a time, so the bar asks for rows of one site instead of
 *    offering actions.
 *  - `canWrite` false: write on the selection's site is missing; only the
 *    export (a read) is offered.
 */

export interface BulkActionBarProps {
  /** Selected rows. */
  count: number;
  /** The selection's site name (already anonymized), when it is one site. */
  siteLabel?: string;
  mixedSites: boolean;
  /** Write on the selection's site: set type / reserve / delete. */
  canWrite: boolean;
  /** A request is running: the actions are disabled. */
  busy?: boolean;
  onSetType: (type: DeviceType) => void;
  onReserve: () => void;
  onDelete: () => void;
  onExport: () => void;
  /** 'deviceChecks.manage' and the selection has checks: "Run checks now". */
  onRunChecks?: () => void;
  onClear: () => void;
  className?: string;
}

function BarButton({
  icon, label, onClick, disabled, danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-9 disabled:opacity-50',
        danger
          ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
          : 'bg-bg-tertiary text-text-primary hover:bg-bg-hover',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function BulkActionBar({
  count,
  siteLabel,
  mixedSites,
  canWrite,
  busy = false,
  onSetType,
  onReserve,
  onDelete,
  onExport,
  onRunChecks,
  onClear,
  className,
}: BulkActionBarProps) {
  const { t } = useTranslation();
  if (count === 0) return null;

  const typeItems: ActionMenuItem[] = DEVICE_TYPE_OPTIONS.map((type) => {
    const Icon = deviceTypeIcon(type);
    return {
      key: type,
      icon: <Icon size={14} />,
      label: deviceTypeLabel(t, type),
      onClick: () => onSetType(type),
    };
  });

  return (
    <div
      role="region"
      aria-label={t('bulk.region', 'Selected devices')}
      className={cn(
        'sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-bg-secondary/95 px-3 py-2 shadow-lg backdrop-blur',
        className,
      )}
    >
      <span className="text-sm font-medium text-text-primary">
        {t('bulk.selected', {
          count,
          defaultValue_one: '{{count}} device selected',
          defaultValue_other: '{{count}} devices selected',
        })}
      </span>
      {siteLabel && !mixedSites && (
        <span className="text-xs text-text-muted">· {siteLabel}</span>
      )}

      {mixedSites ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle size={12} />
          {t('bulk.oneSite', 'Select rows of one site to act on them together')}
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {canWrite && (
            <ActionMenu
              label={t('bulk.setType', 'Set type')}
              items={typeItems}
              align="start"
              menuClassName="w-56 max-h-80 overflow-y-auto"
              disabled={busy}
              trigger={(p) => (
                <button
                  {...p}
                  type="button"
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-bg-hover coarse:min-h-9 disabled:opacity-50"
                >
                  <Tag size={13} />
                  {t('bulk.setType', 'Set type')}
                </button>
              )}
            />
          )}
          {canWrite && (
            <BarButton
              icon={<BookmarkPlus size={13} />}
              label={t('bulk.reserve', 'Reserve IPs')}
              onClick={onReserve}
              disabled={busy}
            />
          )}
          <BarButton
            icon={<FileDown size={13} />}
            label={t('bulk.export', 'Export selected')}
            onClick={onExport}
            disabled={busy}
          />
          {onRunChecks && (
            <BarButton
              icon={<Activity size={13} />}
              label={t('bulk.runChecks', 'Run checks now')}
              onClick={onRunChecks}
              disabled={busy}
            />
          )}
          {canWrite && (
            <BarButton
              icon={<Trash2 size={13} />}
              label={t('common.delete', 'Delete')}
              onClick={onDelete}
              disabled={busy}
              danger
            />
          )}
          {!canWrite && (
            <span className="text-xs text-text-muted">
              {t('bulk.readOnly', 'Read-only on this site: only the export is available')}
            </span>
          )}
        </div>
      )}

      <IconButton
        label={t('bulk.clear', 'Clear the selection')}
        icon={<X size={14} />}
        size="sm"
        className="ml-auto"
        onClick={onClear}
      />
    </div>
  );
}
