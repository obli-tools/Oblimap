import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Monitor } from 'lucide-react';
import type { GroupTreeNode, SiteItem } from '@oblimap/shared';
import type { ItemListEntry } from '@/api/items.api';
import { PageContainer } from '@/components/common/PageContainer';
import { MasterDetail } from '@/components/common/MasterDetail';
import { GroupSitePanel, type GroupSiteSelection } from '@/components/devices/GroupSitePanel';
import { DeviceTable } from '@/components/ipam/DeviceTable';
import { useAuthStore, useTenantCapability } from '@/store/authStore';
import { useGroupStore } from '@/store/groupStore';
import { useTenantStore } from '@/store/tenantStore';
import { MEDIA, useMediaQuery } from '@/hooks/useMediaQuery';
import { useAnonymize } from '@/utils/anonymize';
import { parseRouteId } from '@/utils/routeId';
import { storageGet, storageSet } from '@/utils/safeStorage';

/*
 * Devices of every readable site of the tenant (/devices), ported from
 * Obliance DeviceListPage + DevicesPageLayout: the groups → sites panel on
 * the left (its selection writes ?groupId= / ?siteId=; a group includes its
 * sub-groups), the server-paged DeviceTable on the right.
 *
 * The URL carries every filter (q, status, type, vendor, new, conflict,
 * checks=failing, undocumented, stale, page, sort / dir), so the dashboard
 * links land on the matching view and a device page's Back returns to it.
 * Members only see the sites they may read (the server filters); the bulk
 * actions need write on the selected rows' site.
 */

/** Previous visit of the page (localStorage, per tenant): the "New since my last visit" preset. */
const LAST_VISIT_KEY = 'oblimap:devices:lastVisit';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function validIso(v: string | null): string | null {
  return v && ISO_RE.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * The previous visit, stable for the browser session: the first mount of a
 * session reads the stored marker, keeps it in sessionStorage and stores
 * "now" as the next session's marker (coming back from a device page does
 * not move it).
 */
function readLastVisit(tenantId: number | null): string | null {
  const key = `${LAST_VISIT_KEY}:${tenantId ?? 0}`;
  const sessionValue = storageGet(key, 'session');
  if (sessionValue !== null) return validIso(sessionValue);
  const previous = validIso(storageGet(key));
  storageSet(key, previous ?? '', 'session');
  storageSet(key, new Date().toISOString());
  return previous;
}

function findGroup(nodes: GroupTreeNode[], id: number): GroupTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findGroup(node.children, id);
    if (found) return found;
  }
  return null;
}

function findSiteName(nodes: GroupTreeNode[], id: number): string | null {
  for (const node of nodes) {
    const site = (node.sites ?? []).find((s) => s.id === id);
    if (site) return site.name;
    const found = findSiteName(node.children, id);
    if (found) return found;
  }
  return null;
}

export function DevicesPage() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [searchParams, setSearchParams] = useSearchParams();
  const wide = useMediaQuery(MEDIA.lg);
  const tree = useGroupStore((s) => s.tree);
  const tenantId = useTenantStore((s) => s.currentTenantId);
  // Re-render when the permissions are reloaded (per-row write checks).
  const permissions = useAuthStore((s) => s.permissions);
  const canWriteSite = useAuthStore((s) => s.canWriteSite);
  const canManageProbes = useTenantCapability('probes.manage');

  const groupId = parseRouteId(searchParams.get('groupId'));
  const siteId = parseRouteId(searchParams.get('siteId'));

  // The table reads the URL filters at mount and then owns them (its own URL
  // writes and the panel's selection use replace). A navigation from outside
  // (a link to /devices?q=…, Back / Forward) remounts it so the URL seeds it again.
  const location = useLocation();
  const navigationType = useNavigationType();
  const [tableKey, setTableKey] = useState(location.key);
  useEffect(() => {
    if (navigationType !== 'REPLACE') setTableKey(location.key);
  }, [location.key, navigationType]);

  // Narrow screens: one pane at a time; the panel opens from the back bar.
  const [panelOpen, setPanelOpen] = useState(false);

  const [lastVisit] = useState(() => ({ tenantId, at: readLastVisit(tenantId) }));
  // A tenant switch while on the page: that tenant's own marker.
  const lastVisitAt = lastVisit.tenantId === tenantId ? lastVisit.at : readLastVisit(tenantId);

  const onSelect = useCallback((sel: GroupSiteSelection) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('groupId');
      next.delete('siteId');
      next.delete('page');
      if (sel.type === 'group') next.set('groupId', String(sel.groupId));
      if (sel.type === 'site') next.set('siteId', String(sel.siteId));
      return next;
    }, { replace: true });
    setPanelOpen(false);
  }, [setSearchParams]);

  const canWriteItem = useCallback(
    (item: SiteItem) => canWriteSite(item.siteId, (item as ItemListEntry).groupId ?? null),
    // permissions: canWriteSite reads them from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWriteSite, permissions],
  );

  const scope = useMemo(() => ({ siteId, groupId: siteId === null ? groupId : null }), [siteId, groupId]);

  const scopeLabel = useMemo(() => {
    if (siteId !== null) {
      const name = findSiteName(tree, siteId);
      return name ? anonymize(name, 'hostname') : t('devices.scopeSite', 'Site #{{id}}', { id: siteId });
    }
    if (groupId !== null) {
      const name = findGroup(tree, groupId)?.name ?? useGroupStore.getState().getGroup(groupId)?.name;
      return name ? anonymize(name, 'hostname') : t('devices.scopeGroup', 'Group #{{id}}', { id: groupId });
    }
    return t('groupPanel.allSites', 'All sites');
  }, [anonymize, groupId, siteId, t, tree]);

  return (
    <PageContainer title={t('devices.title', 'Devices')} icon={<Monitor className="h-5 w-5" />}>
      <MasterDetail
        master={(
          <GroupSitePanel
            showAll
            selectedGroupId={siteId === null ? groupId : null}
            selectedSiteId={siteId}
            onSelect={onSelect}
            title={t('devices.panelTitle', 'Groups and sites')}
            className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-10rem)]"
          />
        )}
        hasDetail={wide || !panelOpen}
        onBack={() => setPanelOpen(true)}
        backLabel={t('devices.chooseScope', 'Groups and sites')}
        detailTitle={scopeLabel}
        detail={(
          <DeviceTable
            key={tableKey}
            mode="server"
            stateKey="devices"
            scope={scope}
            urlSeedKeys={['groupId', 'siteId']}
            lastVisitAt={lastVisitAt}
            showSite
            canWrite={false}
            canWriteItem={canWriteItem}
            canManageProbes={canManageProbes}
            exportName={t('devices.exportName', 'devices')}
          />
        )}
      />
    </PageContainer>
  );
}
