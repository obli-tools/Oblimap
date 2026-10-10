import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Shield, ShieldAlert } from 'lucide-react';
import { PageContainer, EmbeddedProvider } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useUrlTab } from '@/hooks/useUrlTab';
import { PAGE_ACCESS, usePageAccessChecker, type PageAccess } from '@/store/authStore';
import { AuditLogPage } from './AuditLogPage';
import { RestrictionsPanel } from '@/components/security/RestrictionsPanel';

type SecurityTab = 'audit' | 'restrictions';

/** The restrictions matrix: platform admins and admins of the current tenant. */
const RESTRICTIONS_ACCESS: PageAccess = { fullAccess: true };

interface SecurityTabDef {
  id: SecurityTab;
  label: string;
  icon: ReactNode;
  access: PageAccess;
}

/**
 * Security hub (ported from Obliance SecurityPage): the audit log, and the
 * action restrictions of the tenant (2FA step-up, tenant admins and platform
 * admins only: fullAccess). The audit tab is gated by PAGE_ACCESS.audit
 * ('audit.read'), not platform-admin only as in Obliance. `?tab=` deep links.
 */
export function SecurityPage() {
  const { t } = useTranslation();
  const allowed = usePageAccessChecker();

  const allTabs: SecurityTabDef[] = [
    { id: 'audit', label: t('security.tabAudit', 'Audit log'), icon: <FileText size={16} />, access: PAGE_ACCESS.audit },
    { id: 'restrictions', label: t('security.tabRestrictions', 'Restrictions'), icon: <ShieldAlert size={16} />, access: RESTRICTIONS_ACCESS },
  ];
  const tabs = allTabs.filter((tab) => allowed(tab.access));
  const ids = tabs.map((tab) => tab.id);
  const [tab, setTab] = useUrlTab<SecurityTab>(ids, ids[0] ?? 'audit');

  const segments: SegmentedTab<SecurityTab>[] = tabs.map(({ id, label, icon }) => ({ id, label, icon }));

  return (
    <PageContainer
      title={t('security.title', 'Security')}
      subtitle={t('security.subtitleRestrictions', 'Audit trail of the security-relevant actions and the actions that need a two-factor confirmation.')}
      icon={<Shield className="h-5 w-5" />}
      className="space-y-6"
    >
      <SegmentedTabs tabs={segments} value={tab} onChange={setTab} ariaLabel={t('security.title', 'Security')} />
      {ids.includes(tab) && (
        <EmbeddedProvider>
          {tab === 'audit' && <AuditLogPage />}
          {tab === 'restrictions' && <RestrictionsPanel />}
        </EmbeddedProvider>
      )}
    </PageContainer>
  );
}
