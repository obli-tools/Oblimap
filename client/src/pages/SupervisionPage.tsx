import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Cable, Laptop } from 'lucide-react';
import { PageContainer, EmbeddedProvider } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { TunnelsPanel } from '@/components/supervision/TunnelsPanel';
import { useUrlTab } from '@/hooks/useUrlTab';
import { PAGE_ACCESS, usePageAccessChecker, type PageAccess } from '@/store/authStore';

type SupervisionTab = 'tunnels';

interface SupervisionTabDef {
  id: SupervisionTab;
  label: string;
  icon: ReactNode;
  access: PageAccess;
}

/**
 * Supervision hub (Obliance pattern): the TCP / web tunnels opened through
 * the probes. Gated by PAGE_ACCESS.supervision ('tunnels.use'). `?tab=`
 * deep links.
 */
export function SupervisionPage() {
  const { t } = useTranslation();
  const allowed = usePageAccessChecker();

  const allTabs: SupervisionTabDef[] = [
    { id: 'tunnels', label: t('supervision.tabTunnels', 'Tunnels'), icon: <Cable size={16} />, access: PAGE_ACCESS.supervision },
  ];
  const tabs = allTabs.filter((tab) => allowed(tab.access));
  const ids = tabs.map((tab) => tab.id);
  const [tab, setTab] = useUrlTab<SupervisionTab>(ids, ids[0] ?? 'tunnels');

  const segments: SegmentedTab<SupervisionTab>[] = tabs.map(({ id, label, icon }) => ({ id, label, icon }));

  return (
    <PageContainer
      title={t('supervision.title', 'Supervision')}
      subtitle={t('supervision.subtitle', 'Tunnels opened through the probes.')}
      icon={<Laptop className="h-5 w-5" />}
      className="space-y-6"
    >
      <SegmentedTabs tabs={segments} value={tab} onChange={setTab} ariaLabel={t('supervision.title', 'Supervision')} />
      {ids.includes(tab) && (
        <EmbeddedProvider>
          {tab === 'tunnels' && <TunnelsPanel />}
        </EmbeddedProvider>
      )}
    </PageContainer>
  );
}
