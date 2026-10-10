import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Key, Radar, Shuffle } from 'lucide-react';
import { PageContainer, EmbeddedProvider } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useUrlTab } from '@/hooks/useUrlTab';
import { PAGE_ACCESS, usePageAccessChecker, type PageAccess } from '@/store/authStore';
import { AdminProbePage } from './AdminProbePage';
import { AdminVendorRulesPage } from './AdminVendorRulesPage';
import { AdminMacVendorsPage } from './AdminMacVendorsPage';

type DiscoveryTab = 'probes' | 'keys' | 'vendor-rules' | 'mac-vendors';

interface DiscoveryTabDef {
  id: DiscoveryTab;
  label: string;
  icon: ReactNode;
  access: PageAccess;
}

/**
 * Discovery hub (Obliance "Agent config" pattern): how devices are found and
 * identified — probes and their API keys, vendor → device type rules and MAC
 * vendor (OUI) overrides. Each tab follows its own page gate; the route is
 * gated by their union (PAGE_ACCESS.discovery). `?tab=` deep links.
 *
 * The probes and keys tabs both render AdminProbePage, which reads `?tab=`
 * itself to pick its own section (same component at the same position: no
 * remount when switching between them).
 */
export function DiscoveryPage() {
  const { t } = useTranslation();
  const allowed = usePageAccessChecker();

  const allTabs: DiscoveryTabDef[] = [
    { id: 'probes', label: t('discovery.tabProbes', 'Probes'), icon: <Radar size={16} />, access: PAGE_ACCESS.probes },
    { id: 'keys', label: t('discovery.tabKeys', 'API keys'), icon: <Key size={16} />, access: PAGE_ACCESS.probeKeys },
    { id: 'vendor-rules', label: t('discovery.tabVendorRules', 'Vendor rules'), icon: <Shuffle size={16} />, access: PAGE_ACCESS.vendorRules },
    { id: 'mac-vendors', label: t('discovery.tabMacVendors', 'MAC vendors'), icon: <Database size={16} />, access: PAGE_ACCESS.macVendors },
  ];
  const tabs = allTabs.filter((tab) => allowed(tab.access));
  const ids = tabs.map((tab) => tab.id);
  const [tab, setTab] = useUrlTab<DiscoveryTab>(ids, ids[0] ?? 'probes');

  const segments: SegmentedTab<DiscoveryTab>[] = tabs.map(({ id, label, icon }) => ({ id, label, icon }));

  return (
    <PageContainer
      title={t('discovery.title', 'Discovery')}
      subtitle={t('discovery.subtitle', 'Probes, API keys and the rules that identify discovered devices.')}
      icon={<Radar className="h-5 w-5" />}
      className="space-y-6"
    >
      <SegmentedTabs tabs={segments} value={tab} onChange={setTab} ariaLabel={t('discovery.title', 'Discovery')} />
      {ids.includes(tab) && (
        <EmbeddedProvider>
          {(tab === 'probes' || tab === 'keys') && <AdminProbePage />}
          {tab === 'vendor-rules' && <AdminVendorRulesPage />}
          {tab === 'mac-vendors' && <AdminMacVendorsPage />}
        </EmbeddedProvider>
      )}
    </PageContainer>
  );
}
