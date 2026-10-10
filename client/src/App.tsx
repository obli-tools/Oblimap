import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import {
  useAuthStore,
  useCanManageGroups,
  usePageAccess,
  PAGE_ACCESS,
  type PageAccess,
} from '@/store/authStore';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ConfirmProvider } from '@/components/common/ConfirmDialog';
import { LoginPage } from '@/pages/LoginPage';
import { EnrollmentPage } from '@/pages/EnrollmentPage';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { SitesPage } from '@/pages/SitesPage';
import { SiteDetailPage } from '@/pages/SiteDetailPage';
import { GroupManagePage } from '@/pages/GroupManagePage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AdminUsersPage } from '@/pages/AdminUsersPage';
import { ProbeDetailPage } from '@/pages/ProbeDetailPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { GroupDetailPage } from '@/pages/GroupDetailPage';
import { GroupEditPage } from '@/pages/GroupEditPage';
import { DownloadPage } from '@/pages/DownloadPage';
import { ImportExportPage } from '@/pages/ImportExportPage';
import { AdminTenantsPage } from '@/pages/AdminTenantsPage';
import { DeviceCheckEditPage } from '@/pages/DeviceCheckEditPage';
import { PoliciesPage } from '@/pages/PoliciesPage';
import { DiscoveryPage } from '@/pages/DiscoveryPage';
import { SecurityPage } from '@/pages/SecurityPage';
import { SupervisionPage } from '@/pages/SupervisionPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { DevicesPage } from '@/pages/DevicesPage';
import { DeviceDetailPage } from '@/pages/DeviceDetailPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import '@/i18n';

/**
 * Renders the page when `allowed`, else goes back to the dashboard. The
 * permissions of a fresh sign-in load in the background: until they are
 * known (one reload is attempted), a spinner instead of a redirect.
 */
function GateOutlet({ allowed }: { allowed: boolean }) {
  const pending = useAuthStore((s) => s.user?.role !== 'admin' && s.permissions === null);
  const [retried, setRetried] = useState(false);

  useEffect(() => {
    if (allowed || !pending || retried) return;
    void useAuthStore.getState().refreshPermissions().finally(() => setRetried(true));
  }, [allowed, pending, retried]);

  if (allowed) return <Outlet />;
  if (pending && !retried) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }
  return <Navigate to="/" replace />;
}

/**
 * Pages gated on the tenant capabilities the server enforces on their routes
 * (PAGE_ACCESS); platform admins always pass. The server stays the authority:
 * this only keeps users off pages whose every request would be refused.
 */
function CapabilityRoute({ access }: { access: PageAccess }) {
  return <GateOutlet allowed={usePageAccess(access)} />;
}

/** Group management: full access, may create groups, groups.manage or write on a group. */
function GroupsRoute() {
  return <GateOutlet allowed={useCanManageGroups()} />;
}

/**
 * Old URL of a page that moved into a hub: replaced by the hub URL with the
 * tab set, keeping the rest of the query string and the hash (bookmarks,
 * links in e-mails, deep links such as ?filter=…). `keepTabs`: an existing
 * ?tab= of the old URL among these is kept (the page read it itself, e.g.
 * AdminProbePage's probes / keys), else `tab` is set.
 */
// Cross-app links (Obligate device_links) registered before 2026-10-08 point
// to /probes/:id; the probe page is /manage/probes/:id.
function ProbeLinkRedirect() {
  const { id } = useParams();
  return <Navigate to={`/manage/probes/${encodeURIComponent(id ?? '')}`} replace />;
}

function HubAlias({ to, tab, keepTabs = [] }: { to: string; tab: string; keepTabs?: readonly string[] }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  if (!keepTabs.includes(params.get('tab') ?? '')) params.set('tab', tab);
  return <Navigate to={{ pathname: to, search: `?${params.toString()}`, hash: location.hash }} replace />;
}

export default function App() {
  const { checkSession } = useAuthStore();

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return (
    <BrowserRouter>
      {/* Styled confirm / prompt dialogs (useConfirm / usePrompt), inside the
          router so dialog content may use <Link> / router hooks; without it
          they fall back to window.confirm / window.prompt. */}
      <ConfirmProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            {/* Enrollment — full-screen, outside AppLayout */}
            <Route path="/enroll" element={<EnrollmentPage />} />
            <Route element={<AppLayout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/sites" element={<SitesPage />} />
              <Route path="/sites/:id" element={<SiteDetailPage />} />
              <Route path="/download" element={<DownloadPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/group/:id" element={<GroupDetailPage />} />
              <Route path="/group/:id/edit" element={<GroupEditPage />} />
              {/* Every member: the pages show only the sites they may read. */}
              <Route path="/devices" element={<DevicesPage />} />
              <Route path="/sites/:siteId/devices/:itemId" element={<DeviceDetailPage />} />
              <Route path="/history" element={<HistoryPage />} />

              {/* Old URLs of pages that moved into a hub (the hub route gates them). */}
              <Route path="/notifications" element={<HubAlias to="/policies" tab="notifications" />} />
              <Route path="/manage/device-checks" element={<HubAlias to="/policies" tab="checks" />} />
              <Route path="/manage/probes" element={<HubAlias to="/manage/discovery" tab="probes" keepTabs={['probes', 'keys']} />} />
              <Route path="/manage/vendor-rules" element={<HubAlias to="/manage/discovery" tab="vendor-rules" />} />
              <Route path="/manage/mac-vendors" element={<HubAlias to="/manage/discovery" tab="mac-vendors" />} />
              <Route path="/manage/audit" element={<HubAlias to="/manage/security" tab="audit" />} />

              {/* Hubs: gated by the union of their tabs, each tab by its own page gate. */}
              <Route element={<CapabilityRoute access={PAGE_ACCESS.policies} />}>
                <Route path="/policies" element={<PoliciesPage />} />
              </Route>
              <Route element={<CapabilityRoute access={PAGE_ACCESS.discovery} />}>
                <Route path="/manage/discovery" element={<DiscoveryPage />} />
              </Route>
              <Route element={<CapabilityRoute access={PAGE_ACCESS.security} />}>
                <Route path="/manage/security" element={<SecurityPage />} />
              </Route>
              <Route element={<CapabilityRoute access={PAGE_ACCESS.supervision} />}>
                <Route path="/manage/supervision" element={<SupervisionPage />} />
              </Route>

              {/* Tenant pages: the tenant capabilities of their server routes */}
              {/* Groups are managed in the /devices panel (GroupSitePanel); the
                  old page stays reachable for direct links, same gate. */}
              <Route path="/groups" element={<Navigate to="/devices" replace />} />
              <Route element={<GroupsRoute />}>
                <Route path="/manage/groups" element={<GroupManagePage />} />
              </Route>
              <Route element={<CapabilityRoute access={PAGE_ACCESS.users} />}>
                <Route path="/manage/users" element={<AdminUsersPage />} />
              </Route>
              {/* Real routes: server-written live alerts link to them (liveAlert.service capability filter). */}
              <Route element={<CapabilityRoute access={PAGE_ACCESS.probes} />}>
                <Route path="/manage/probes/:id" element={<ProbeDetailPage />} />
                <Route path="/probes/:id" element={<ProbeLinkRedirect />} />
              </Route>
              <Route element={<CapabilityRoute access={PAGE_ACCESS.importExport} />}>
                <Route path="/manage/import-export" element={<ImportExportPage />} />
              </Route>
              <Route element={<CapabilityRoute access={PAGE_ACCESS.deviceChecks} />}>
                <Route path="/manage/device-checks/new" element={<DeviceCheckEditPage />} />
                <Route path="/manage/device-checks/:id" element={<DeviceCheckEditPage />} />
              </Route>
              <Route element={<CapabilityRoute access={PAGE_ACCESS.settings} />}>
                <Route path="/settings" element={<SettingsPage />} />
              </Route>

              {/* Platform-admin routes (platform functions) */}
              <Route element={<ProtectedRoute requiredRole="admin" />}>
                <Route path="/manage/tenants" element={<AdminTenantsPage />} />
                <Route path="/workspace" element={<AdminTenantsPage />} />
              </Route>
            </Route>
          </Route>

          {/* 404 */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>

        <Toaster
          position="top-right"
          toastOptions={{
            className: '!bg-bg-secondary !text-text-primary !border !border-border',
            duration: 4000,
          }}
        />
      </ConfirmProvider>
    </BrowserRouter>
  );
}
