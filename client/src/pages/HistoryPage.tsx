import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';
import { HistoryPanel } from '@/components/supervision/HistoryPanel';

/** IPAM history of the tenant: open to every member (the panel shows only readable sites). */
export function HistoryPage() {
  const { t } = useTranslation();
  return (
    <PageContainer
      title={t('history.title', 'History')}
      subtitle={t('history.subtitle', 'What changed on your networks.')}
      icon={<History className="h-5 w-5" />}
    >
      <HistoryPanel />
    </PageContainer>
  );
}
