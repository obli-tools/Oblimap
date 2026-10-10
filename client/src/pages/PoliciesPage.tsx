import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, ListChecks, ShieldCheck, SlidersHorizontal, Wrench } from 'lucide-react';
import { PageContainer, EmbeddedProvider } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { MaintenancePanel } from '@/components/policies/MaintenancePanel';
import { useUrlTab } from '@/hooks/useUrlTab';
import { PAGE_ACCESS, usePageAccessChecker, type PageAccess } from '@/store/authStore';
import { AdminDeviceChecksPage } from './AdminDeviceChecksPage';
import { NotificationsPage } from './NotificationsPage';

type PolicyTab = 'checks' | 'notifications' | 'maintenance' | 'defaults';

interface PolicyTabDef {
  id: PolicyTab;
  label: string;
  icon: ReactNode;
  access: PageAccess;
}

/** Tenant-wide default settings ('settings' capability, server settings routes). */
const DEFAULTS_ACCESS: PageAccess = { all: ['settings'] };
/** Maintenance windows ('settings' capability, server maintenance routes). */
const MAINTENANCE_ACCESS: PageAccess = { all: ['settings'] };

/**
 * Policies hub (ported from Obliance PoliciesPage): the day-to-day monitoring
 * policy of the tenant — device-check rules, notification channels and the
 * default site / probe settings. Each tab follows its own page gate; the
 * route is gated by their union (PAGE_ACCESS.policies). `?tab=` deep links.
 */
export function PoliciesPage() {
  const { t } = useTranslation();
  const allowed = usePageAccessChecker();

  const allTabs: PolicyTabDef[] = [
    { id: 'checks', label: t('policies.tabChecks', 'Device checks'), icon: <ListChecks size={16} />, access: PAGE_ACCESS.deviceChecks },
    { id: 'notifications', label: t('policies.tabNotifications', 'Notifications'), icon: <Bell size={16} />, access: PAGE_ACCESS.notifications },
    { id: 'maintenance', label: t('policies.tabMaintenance', 'Maintenance'), icon: <Wrench size={16} />, access: MAINTENANCE_ACCESS },
    { id: 'defaults', label: t('policies.tabDefaults', 'Default settings'), icon: <SlidersHorizontal size={16} />, access: DEFAULTS_ACCESS },
  ];
  const tabs = allTabs.filter((tab) => allowed(tab.access));
  const ids = tabs.map((tab) => tab.id);
  const [tab, setTab] = useUrlTab<PolicyTab>(ids, ids[0] ?? 'checks');

  const segments: SegmentedTab<PolicyTab>[] = tabs.map(({ id, label, icon }) => ({ id, label, icon }));

  return (
    <PageContainer
      title={t('policies.title', 'Policies')}
      subtitle={t('policies.subtitle', 'Device checks, notification channels, maintenance windows and default settings of this tenant.')}
      icon={<ShieldCheck className="h-5 w-5" />}
      className="space-y-6"
    >
      <SegmentedTabs tabs={segments} value={tab} onChange={setTab} ariaLabel={t('policies.title', 'Policies')} />
      {ids.includes(tab) && (
        <EmbeddedProvider>
          {tab === 'checks' && <AdminDeviceChecksPage />}
          {tab === 'notifications' && <NotificationsPage />}
          {tab === 'maintenance' && <MaintenancePanel />}
          {tab === 'defaults' && (
            <SettingsPanel
              scope="global"
              scopeId={null}
              title={t('settings.defaultSiteProbeSettings', 'Default site & probe settings (this tenant)')}
            />
          )}
        </EmbeddedProvider>
      )}
    </PageContainer>
  );
}
