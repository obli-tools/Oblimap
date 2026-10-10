import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Key,
  KeyRound,
  Shield,
  ShieldOff,
  UserIcon,
  UserPlus,
  UserX,
  UserMinus,
  Users,
  FolderOpen,
  Check,
  ChevronRight,
  ChevronDown,
  Eye,
  Building2,
  MapPin,
  AlertTriangle,
} from 'lucide-react';
import { useAnonymize } from '../utils/anonymize';
import type {
  User,
  UserTeam,
  GroupTreeNode,
  PermissionLevel,
  Site,
  UserTenantAssignment,
} from '@oblimap/shared';
import { usersApi } from '@/api/users.api';
import {
  teamsApi,
  type TeamEligibleMember,
  type TeamPermissionEntry,
  type TeamPermissionScope,
} from '@/api/teams.api';
import { tenantMembersApi, type TenantMember } from '@/api/tenantMembers.api';
import {
  permissionSetsApi,
  permissionSetSlugForRole,
  LEGACY_MEMBER_ROLE,
  LEGACY_MEMBER_SET,
  TENANT_ADMIN_ROLE,
  type PermissionSet,
} from '@/api/permissionSets.api';
import { groupsApi } from '@/api/groups.api';
import { siteApi } from '@/api/site.api';
import { useAuthStore, useFullAccess } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { Drawer } from '@/components/common/Drawer';
import { ActionMenu } from '@/components/common/ActionMenu';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Checkbox } from '@/components/ui/Checkbox';
import { EffectiveAccessDrawer } from '@/components/users/EffectiveAccessDrawer';
import { useUrlTab } from '@/hooks/useUrlTab';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PermissionSetsTab } from '@/components/PermissionSetsTab';
import { isHandled, toastApiError } from '@/utils/apiError';

const USER_TABS = ['users', 'teams', 'sets'] as const;
type Tab = typeof USER_TABS[number];
/** role: 'admin', legacy 'member' or a permission set slug (kept unchanged). */
type TenantDraft = Record<number, { isMember: boolean; role: string }>;

// Minimum length of the server-side password policy (server/src/validators/password.ts).
const PASSWORD_MIN_LENGTH = 10;
/** Tenant role of a new membership (what the legacy 'member' reads as). */
const DEFAULT_TENANT_ROLE = LEGACY_MEMBER_SET;
const OBLIGATE = 'obligate';

const selectCls = 'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed';

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Toast for a refused / failed call: the server's sentence (a scoped refusal
 * answers 403 {error:'forbidden', reason:<code>, message:<sentence>}: the
 * message is shown, never the code), else the fallback. Errors the API
 * client already reported are skipped.
 */
function toastRefusal(err: unknown, fallback: string): void {
  toastApiError(err, fallback);
}

/** Display name of an account: the og_ prefix of SSO accounts is dropped. */
function shownUsername(username: string): string {
  return username.startsWith('og_') ? username.slice(3) : username;
}

/** Label of a tenant role: 'admin' is the workspace admin, a set its name. */
function tenantRoleLabel(role: string, sets: PermissionSet[] | null, t: TFunction): string {
  const slug = permissionSetSlugForRole(role);
  if (slug === TENANT_ADMIN_ROLE) return t('users.tenants.roleWorkspaceAdmin', 'Workspace admin');
  const set = sets?.find((s) => s.slug === slug);
  if (set) return set.name;
  if (slug === LEGACY_MEMBER_SET) return t('users.tenants.roleViewer', 'Viewer');
  return t('users.tenants.roleUnknown', '{{role}} (unknown role)', { role: slug });
}

/** The permission sets (tenant roles); null while loading, [] when the load failed. */
function useRoleSets(): PermissionSet[] | null {
  const [sets, setSets] = useState<PermissionSet[] | null>(null);
  useEffect(() => {
    let alive = true;
    permissionSetsApi.list()
      .then((s) => { if (alive) setSets(s); })
      .catch(() => { if (alive) setSets([]); });
    return () => { alive = false; };
  }, []);
  return sets;
}

/**
 * Whether the caller may grant / manage a tenant role (the server's
 * dominance rule, mirrored for the UI only — the server decides): platform
 * and tenant admins every role; others only a set whose every capability
 * they hold, never 'admin'.
 */
function useCanGrantRole(sets: PermissionSet[] | null): (role: string) => boolean {
  const fullAccess = useFullAccess();
  const capabilities = useAuthStore((s) => s.permissions?.capabilities);
  return useCallback((role: string) => {
    if (fullAccess) return true;
    const slug = permissionSetSlugForRole(role);
    if (slug === TENANT_ADMIN_ROLE) return false;
    if (!sets) return false;
    const set = sets.find((s) => s.slug === slug);
    if (!set) return false; // unknown or not loaded: the server decides
    const held = new Set(capabilities ?? []);
    return set.capabilities.every((c) => held.has(c));
  }, [fullAccess, capabilities, sets]);
}

/** "SSO" pill of an Obligate account, with the reason as tooltip. */
function SsoBadge({ title }: { title: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full bg-[#1e1b4b]/60 border border-[#4338ca]/40 px-1.5 py-0.5 text-[10px] font-medium text-[#a5b4fc]"
    >
      SSO
    </span>
  );
}

/** Tenant role select: every set, those the caller may not grant disabled. */
function RoleSelect({
  id,
  value,
  sets,
  canGrant,
  onChange,
  disabled,
  title,
  className = selectCls,
}: {
  id?: string;
  value: string;
  sets: PermissionSet[] | null;
  canGrant: (role: string) => boolean;
  onChange: (role: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const shown = permissionSetSlugForRole(value);
  const choices = (sets && sets.length > 0)
    ? sets.map((set) => ({ value: set.slug, label: tenantRoleLabel(set.slug, sets, t) }))
    : [
      { value: TENANT_ADMIN_ROLE, label: t('users.tenants.roleWorkspaceAdmin', 'Workspace admin') },
      { value: LEGACY_MEMBER_SET, label: t('users.tenants.roleViewer', 'Viewer') },
    ];
  if (!choices.some((c) => c.value === shown)) {
    choices.push({ value: shown, label: tenantRoleLabel(shown, sets, t) });
  }
  return (
    <select
      id={id}
      value={shown}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      title={title}
      className={className}
      aria-label={t('users.tenants.roleLabel', 'Role')}
    >
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value} disabled={choice.value !== shown && !canGrant(choice.value)}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export function AdminUsersPage() {
  const { t } = useTranslation();
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  // Users and teams: platform admins and holders of 'users.manage' (the
  // route gate); permission sets are a platform function.
  const [urlTab, setTab] = useUrlTab<Tab>(USER_TABS, 'users');
  const tab: Tab = urlTab === 'sets' && !isPlatformAdmin ? 'users' : urlTab;

  return (
    <PageContainer
      title={t('users.pageTitle', 'Users & teams')}
      icon={<Users size={18} />}
      className="space-y-4"
    >
      <SegmentedTabs<Tab>
        value={tab}
        onChange={setTab}
        className="max-w-xl"
        ariaLabel={t('users.pageTitle', 'Users & teams')}
        tabs={[
          { id: 'users', label: t('users.tabUsers', 'Users'), icon: <UserIcon size={14} /> },
          { id: 'teams', label: t('users.tabTeams', 'Teams'), icon: <Users size={14} /> },
          { id: 'sets', label: t('users.tabPermissions', 'Permissions'), icon: <Shield size={14} />, hidden: !isPlatformAdmin },
        ]}
      />

      {tab === 'users' && (isPlatformAdmin ? <PlatformUsersTab /> : <TenantUsersTab />)}
      {tab === 'teams' && <TeamsTab />}
      {tab === 'sets' && isPlatformAdmin && <PermissionSetsTab />}
    </PageContainer>
  );
}

// ── Create user (both views) ────────────────────────────────────────────────

function CreateUserModal({
  open,
  onClose,
  onCreated,
  platform,
  sets,
  canGrant,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Platform admin: the platform role is offered too. */
  platform: boolean;
  sets: PermissionSet[] | null;
  canGrant: (role: string) => boolean;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [platformRole, setPlatformRole] = useState<'admin' | 'user'>('user');
  const [tenantRole, setTenantRole] = useState(DEFAULT_TENANT_ROLE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername('');
    setDisplayName('');
    setPassword('');
    setPlatformRole('user');
    setTenantRole(DEFAULT_TENANT_ROLE);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await usersApi.create({
        username,
        password,
        displayName: displayName || undefined,
        ...(platform ? { role: platformRole } : {}),
        tenantRole,
      });
      // POST /users applies tenantRole to the current workspace's membership.
      toast.success(t('users.created', 'User created'));
      onClose();
      onCreated();
    } catch (err) {
      toastRefusal(err, t('users.failedCreate', 'Failed to create the user'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('users.newUser', 'New user')}
      icon={<UserPlus size={16} className="text-accent" />}
      footer={(
        <>
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button type="submit" form="create-user-form" size="sm" loading={saving}>{t('common.create', 'Create')}</Button>
        </>
      )}
    >
      <form id="create-user-form" onSubmit={submit} className="space-y-3">
        <Input
          label={t('users.usernameLabel', 'Username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          minLength={3}
          pattern="[a-zA-Z0-9_.\-]+"
          autoComplete="off"
          autoFocus
        />
        <Input label={t('users.displayNameLabel', 'Display name')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <Input
          label={t('users.passwordLabel', 'Password')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={PASSWORD_MIN_LENGTH}
          autoComplete="new-password"
        />
        {platform && (
          <PlatformRoleField value={platformRole} onChange={setPlatformRole} />
        )}
        {platformRole !== 'admin' && (
          <div className="space-y-1">
            <label htmlFor="create-user-tenant-role" className="block text-sm font-medium text-text-secondary">
              {t('users.tenantRoleLabel', 'Role in this workspace')}
            </label>
            <RoleSelect id="create-user-tenant-role" value={tenantRole} sets={sets} canGrant={canGrant} onChange={setTenantRole} />
            <p className="text-xs text-text-muted">
              {t('users.tenantRoleHint', 'The role decides what the user may do here; teams decide which groups and sites.')}
            </p>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Platform role select with the platform-admin warning. */
function PlatformRoleField({ value, onChange }: { value: 'admin' | 'user'; onChange: (v: 'admin' | 'user') => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <label htmlFor="platform-role" className="block text-sm font-medium text-text-secondary">
        {t('users.platformRoleLabel', 'Platform role')}
      </label>
      <select
        id="platform-role"
        value={value}
        onChange={(e) => onChange(e.target.value as 'admin' | 'user')}
        className={selectCls}
      >
        <option value="user">{t('users.roleUser', 'User')}</option>
        <option value="admin">{t('users.rolePlatformAdmin', 'Platform administrator (every workspace)')}</option>
      </select>
      {value === 'admin' && (
        <p className="flex items-start gap-1.5 text-xs text-amber-400">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {t('users.rolePlatformAdminWarning', 'Full control of every workspace, user and platform setting. To administer one workspace only, keep "User" and give the Workspace admin role.')}
        </p>
      )}
    </div>
  );
}

// ── Users: tenant view ('users.manage' holders) ─────────────────────────────

function TenantUsersTab() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const confirm = useConfirm();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const currentTenantName = useTenantStore((s) => s.tenants.find((tn) => tn.id === s.currentTenantId)?.name ?? null);
  const sets = useRoleSets();
  const canGrant = useCanGrantRole(sets);

  const [members, setMembers] = useState<TenantMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [accessFor, setAccessFor] = useState<{ id: number; username: string } | null>(null);

  const load = useCallback(async () => {
    const epoch = useTenantStore.getState().epoch;
    try {
      const rows = await tenantMembersApi.listCurrent();
      if (useTenantStore.getState().epoch !== epoch) return;
      setMembers(rows);
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      toastApiError(err, t('users.failedLoad', 'Failed to load data'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { setLoading(true); void load(); }, [load, currentTenantId]);

  const ssoTitle = t('users.ssoManagedRole', 'Managed in Obligate: role reset at next sign-in');

  // SSO members are managed in Obligate (the server refuses their role and
  // membership changes here): their select and remove item are disabled.
  const changeRole = async (member: TenantMember, role: string) => {
    setBusyId(member.id);
    try {
      await tenantMembersApi.setRoleCurrent(member.id, role);
      toast.success(t('users.roleChanged', 'Role changed'));
      await load();
    } catch (err) {
      toastRefusal(err, t('tenant.failedChangeRole', 'Failed to change the role'));
    } finally {
      setBusyId(null);
    }
  };

  const removeMember = async (member: TenantMember) => {
    const username = anonymize(shownUsername(member.username), 'username');
    const message = t('users.confirmRemoveMember', 'Remove {{username}} from this workspace? The account itself is kept.', { username });
    if (!(await confirm({ message, danger: true, confirmLabel: t('users.removeFromWorkspace', 'Remove from workspace') }))) return;
    try {
      await tenantMembersApi.removeCurrent(member.id);
      toast.success(t('users.memberRemoved', 'Removed from the workspace'));
      await load();
    } catch (err) {
      toastRefusal(err, t('tenant.failedRemoveMember', 'Failed to remove the member'));
    }
  };

  const toggleActive = async (member: TenantMember) => {
    try {
      await usersApi.update(member.id, { isActive: !member.isActive });
      toast.success(member.isActive ? t('users.disabled', 'User disabled') : t('users.enabled', 'User enabled'));
      await load();
    } catch (err) {
      toastRefusal(err, t('users.failedUpdate', 'Failed to update the user'));
    }
  };

  const reset2fa = async (member: TenantMember) => {
    const username = anonymize(shownUsername(member.username), 'username');
    if (!(await confirm({
      title: t('users.reset2fa', 'Reset 2FA'),
      message: t('users.reset2faConfirm', 'Reset the two-factor authentication of {{username}}? Their authenticator app and e-mail codes are removed and they are signed out everywhere.', { username }),
      danger: true,
      confirmLabel: t('users.reset2fa', 'Reset 2FA'),
    }))) return;
    try {
      await usersApi.resetTwoFactor(member.id);
      toast.success(t('users.reset2faDone', 'Two-factor authentication reset'));
    } catch (err) {
      toastRefusal(err, t('users.reset2faFailed', 'Failed to reset the two-factor authentication'));
    }
  };

  const deleteAccount = async (member: TenantMember) => {
    const username = anonymize(shownUsername(member.username), 'username');
    if (!(await confirm({ message: t('users.confirmDelete', 'Delete user "{{username}}"?', { username }), danger: true }))) return;
    try {
      await usersApi.delete(member.id);
      toast.success(t('users.deleted', 'User deleted'));
      await load();
    } catch (err) {
      toastRefusal(err, t('users.failedDelete', 'Failed to delete the user'));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <Building2 size={12} className="shrink-0" />
          {currentTenantName
            ? t('users.tenantMembersNamed', 'Members of workspace {{tenant}}.', { tenant: anonymize(currentTenantName, 'hostname') })
            : t('users.tenantMembers', 'Members of the current workspace.')}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            <UserPlus size={14} className="mr-1" />{t('users.addExisting', 'Add existing account')}
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} className="mr-1" />{t('users.createUser', 'Create user')}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : loadFailed ? (
        <LoadError onRetry={() => { setLoading(true); void load(); }} />
      ) : members.length === 0 ? (
        <EmptyState icon={<Users className="h-6 w-6" />} title={t('tenant.noMembers', 'No members')} />
      ) : (
        <div className="rounded-xl bg-bg-secondary divide-y divide-border shadow-[var(--shadow-card)]">
          {members.map((m) => {
            const isMe = m.id === currentUserId;
            const sso = m.foreignSource === OBLIGATE;
            const platformAdmin = m.platformRole === 'admin';
            const dominated = !isMe && !platformAdmin && canGrant(m.tenantRole);
            // Role and membership: the server refuses one's own row, platform
            // admins, SSO members (managed in Obligate) and roles not dominated.
            const manageable = dominated && !sso;
            // Account-level actions (enable, 2FA, delete) act on the global
            // account: never one's own, an SSO or a platform admin account.
            const accountActions = !isMe && !sso && !platformAdmin;
            // A workspace admin's factors are reset by a platform admin only.
            const targetIsAdmin = permissionSetSlugForRole(m.tenantRole) === TENANT_ADMIN_ROLE;
            const name = anonymize(shownUsername(m.username), 'username');
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">{name}</span>
                    {m.displayName && <span className="text-xs text-text-muted">({anonymize(m.displayName, 'username')})</span>}
                    {isMe && <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-muted">{t('users.you', 'You')}</span>}
                    {platformAdmin && (
                      <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        <Shield size={10} className="mr-0.5 inline" />{t('users.rolePlatformAdminShort', 'Platform admin')}
                      </span>
                    )}
                    {sso && <SsoBadge title={ssoTitle} />}
                    {!m.isActive && (
                      <span className="rounded-full bg-status-down/10 px-1.5 py-0.5 text-[10px] font-medium text-status-down">{t('users.inactive', 'Off')}</span>
                    )}
                  </div>
                  {m.email && <div className="truncate text-xs text-text-muted">{anonymize(m.email, 'username')}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <RoleSelect
                    value={m.tenantRole}
                    sets={sets}
                    canGrant={canGrant}
                    onChange={(role) => { void changeRole(m, role); }}
                    disabled={!manageable || busyId === m.id}
                    title={sso ? ssoTitle : undefined}
                    className="max-w-[12rem] rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                  />
                  <ActionMenu
                    label={t('common.moreActions', 'More actions')}
                    triggerSize="sm"
                    items={[
                      {
                        key: 'access',
                        icon: <KeyRound size={14} />,
                        label: t('users.effectiveAccess', 'Effective access'),
                        onClick: () => setAccessFor({ id: m.id, username: shownUsername(m.username) }),
                        disabled: !isMe && !dominated,
                      },
                      {
                        key: 'active',
                        icon: m.isActive ? <UserX size={14} /> : <UserIcon size={14} />,
                        label: m.isActive ? t('common.disable', 'Disable') : t('common.enable', 'Enable'),
                        onClick: () => { void toggleActive(m); },
                        hidden: !accountActions,
                        disabled: !dominated,
                      },
                      {
                        key: '2fa',
                        icon: <ShieldOff size={14} />,
                        label: t('users.reset2fa', 'Reset 2FA'),
                        onClick: () => { void reset2fa(m); },
                        hidden: !accountActions,
                        disabled: !dominated || targetIsAdmin,
                      },
                      {
                        key: 'remove',
                        icon: <UserMinus size={14} />,
                        label: t('users.removeFromWorkspace', 'Remove from workspace'),
                        onClick: () => { void removeMember(m); },
                        hidden: isMe,
                        disabled: !manageable,
                        separator: true,
                      },
                      {
                        key: 'delete',
                        icon: <Trash2 size={14} />,
                        label: t('users.deleteAccount', 'Delete account'),
                        onClick: () => { void deleteAccount(m); },
                        hidden: !accountActions,
                        disabled: !dominated,
                        danger: true,
                      },
                    ]}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-text-muted">
        {t('users.dominanceHint', 'You can only give or change roles whose every permission you hold. SSO accounts are managed in Obligate.')}
      </p>

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { void load(); }}
        platform={false}
        sets={sets}
        canGrant={canGrant}
      />
      <AddExistingModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => { void load(); }}
        sets={sets}
        canGrant={canGrant}
      />
      <EffectiveAccessDrawer
        open={accessFor !== null}
        onClose={() => setAccessFor(null)}
        userId={accessFor?.id ?? null}
        username={accessFor?.username ?? ''}
      />
    </div>
  );
}

/** Adds an existing account to the current tenant by exact username or e-mail (no search). */
function AddExistingModal({
  open,
  onClose,
  onAdded,
  sets,
  canGrant,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
  sets: PermissionSet[] | null;
  canGrant: (role: string) => boolean;
}) {
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState(DEFAULT_TENANT_ROLE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIdentifier('');
    setRole(DEFAULT_TENANT_ROLE);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = identifier.trim();
    if (!value) return;
    setSaving(true);
    try {
      await tenantMembersApi.addCurrent(value, role);
      toast.success(t('users.memberAdded', 'Account added to the workspace'));
      onClose();
      onAdded();
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      if (status === 404 && !isHandled(err)) {
        toast.error(t('users.addExistingNotFound', 'No account available with this exact username or e-mail address'));
      } else {
        toastRefusal(err, t('tenant.failedAddMember', 'Failed to add the member'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('users.addExisting', 'Add existing account')}
      icon={<UserPlus size={16} className="text-accent" />}
      footer={(
        <>
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button type="submit" form="add-existing-form" size="sm" loading={saving} disabled={!identifier.trim()}>
            {t('tenant.addMember', 'Add member')}
          </Button>
        </>
      )}
    >
      <form id="add-existing-form" onSubmit={submit} className="space-y-3">
        <Input
          label={t('users.usernameOrEmail', 'Exact username or e-mail address')}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
          autoComplete="off"
          autoFocus
        />
        <p className="text-xs text-text-muted">
          {t('users.addExistingHint', 'Accounts cannot be searched from a workspace: type the exact username or e-mail address of the person.')}
        </p>
        <div className="space-y-1">
          <label htmlFor="add-existing-role" className="block text-sm font-medium text-text-secondary">
            {t('users.tenantRoleLabel', 'Role in this workspace')}
          </label>
          <RoleSelect id="add-existing-role" value={role} sets={sets} canGrant={canGrant} onChange={setRole} />
        </div>
      </form>
    </Modal>
  );
}

// ── Users: platform view (every account) ────────────────────────────────────

function PlatformUsersTab() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const confirm = useConfirm();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const sets = useRoleSets();
  const canGrant = useCanGrantRole(sets);

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [accessFor, setAccessFor] = useState<{ id: number; username: string } | null>(null);

  // Edit / password modals
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [passwordUser, setPasswordUser] = useState<User | null>(null);
  const [formUsername, setFormUsername] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<'admin' | 'user'>('user');
  const [saving, setSaving] = useState(false);

  // Tenant assignment panel
  const [tenantPanelUser, setTenantPanelUser] = useState<User | null>(null);
  const [tenantAssignments, setTenantAssignments] = useState<UserTenantAssignment[]>([]);
  const [tenantDraft, setTenantDraft] = useState<TenantDraft>({});
  const [tenantPanelLoading, setTenantPanelLoading] = useState(false);
  const [tenantSaving, setTenantSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers(await usersApi.list());
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      toastApiError(err, t('users.failedLoad', 'Failed to load data'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const openEdit = (user: User) => {
    setEditingUser(user);
    setFormUsername(user.username);
    setFormDisplayName(user.displayName || '');
    setFormRole(user.role);
  };

  const handleEditUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSaving(true);
    try {
      await usersApi.update(editingUser.id, {
        username: formUsername,
        displayName: formDisplayName || null,
        role: formRole,
      });
      toast.success(t('users.updated', 'User updated'));
      setEditingUser(null);
      void load();
    } catch (err) {
      toastRefusal(err, t('users.failedUpdate', 'Failed to update the user'));
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChange = async (e: FormEvent) => {
    e.preventDefault();
    // One's own password changes through the profile (the server answers 400).
    if (!passwordUser || passwordUser.id === currentUserId) return;
    setSaving(true);
    try {
      await usersApi.changePassword(passwordUser.id, formPassword);
      toast.success(t('users.passwordChanged', 'Password changed'));
      setPasswordUser(null);
    } catch (err) {
      toastRefusal(err, t('users.failedChangePassword', 'Failed to change password'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async (user: User) => {
    const username = anonymize(shownUsername(user.username), 'username');
    if (!(await confirm({ message: t('users.confirmDelete', 'Delete user "{{username}}"?', { username }), danger: true }))) return;
    try {
      await usersApi.delete(user.id);
      toast.success(t('users.deleted', 'User deleted'));
      void load();
    } catch (err) {
      toastRefusal(err, t('users.failedDelete', 'Failed to delete the user'));
    }
  };

  const handleToggleActive = async (user: User) => {
    try {
      await usersApi.update(user.id, { isActive: !user.isActive });
      toast.success(user.isActive ? t('users.disabled', 'User disabled') : t('users.enabled', 'User enabled'));
      void load();
    } catch (err) {
      toastRefusal(err, t('users.failedUpdate', 'Failed to update the user'));
    }
  };

  const handleReset2fa = async (user: User) => {
    const username = anonymize(shownUsername(user.username), 'username');
    if (!(await confirm({
      title: t('users.reset2fa', 'Reset 2FA'),
      message: t('users.reset2faConfirm', 'Reset the two-factor authentication of {{username}}? Their authenticator app and e-mail codes are removed and they are signed out everywhere.', { username }),
      danger: true,
      confirmLabel: t('users.reset2fa', 'Reset 2FA'),
    }))) return;
    try {
      await usersApi.resetTwoFactor(user.id);
      toast.success(t('users.reset2faDone', 'Two-factor authentication reset'));
      void load();
    } catch (err) {
      toastRefusal(err, t('users.reset2faFailed', 'Failed to reset the two-factor authentication'));
    }
  };

  // ── Tenant panel ──

  const openTenantPanel = async (user: User) => {
    setTenantPanelUser(user);
    setTenantPanelLoading(true);
    try {
      const assignments = await usersApi.getTenants(user.id);
      setTenantAssignments(assignments);
      const draft: TenantDraft = {};
      for (const a of assignments) {
        draft[a.tenantId] = { isMember: a.isMember, role: a.role };
      }
      setTenantDraft(draft);
    } catch (err) {
      toastApiError(err, t('users.tenants.failedLoad', 'Failed to load tenant assignments'));
      setTenantPanelUser(null);
    } finally {
      setTenantPanelLoading(false);
    }
  };

  const closeTenantPanel = () => {
    setTenantPanelUser(null);
    setTenantAssignments([]);
    setTenantDraft({});
  };

  const toggleTenantMember = (tenantId: number) => {
    setTenantDraft((prev) => {
      const assignment = tenantAssignments.find((a) => a.tenantId === tenantId);
      const current = prev[tenantId] ?? { isMember: false, role: DEFAULT_TENANT_ROLE };
      // A new membership gets the Viewer set (what the legacy 'member' reads as).
      const joining = !current.isMember && !assignment?.isMember;
      return {
        ...prev,
        [tenantId]: {
          isMember: !current.isMember,
          role: joining && current.role === LEGACY_MEMBER_ROLE ? DEFAULT_TENANT_ROLE : current.role,
        },
      };
    });
  };

  const setTenantRole = (tenantId: number, role: string) => {
    setTenantDraft((prev) => {
      const current = prev[tenantId] ?? { isMember: true, role };
      return { ...prev, [tenantId]: { ...current, role } };
    });
  };

  const saveTenantAssignments = async () => {
    if (!tenantPanelUser) return;
    setTenantSaving(true);
    try {
      const assignments = Object.entries(tenantDraft)
        .filter(([, v]) => v.isMember)
        .map(([tenantId, v]) => ({ tenantId: Number(tenantId), role: v.role }));
      await usersApi.setTenants(tenantPanelUser.id, assignments);
      toast.success(t('users.tenants.saved', 'Tenant assignments saved'));
      closeTenantPanel();
    } catch (err) {
      toastRefusal(err, t('users.tenants.failedSave', 'Failed to save tenant assignments'));
    } finally {
      setTenantSaving(false);
    }
  };

  const ssoTitle = t('users.ssoManagedAccount', 'Managed in Obligate: account, role and teams are reset at each sign-in');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">{t('users.platformListHint', 'Every account of the platform.')}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={14} className="mr-1" />{t('users.createUser', 'Create user')}
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : loadFailed ? (
        <LoadError onRetry={() => { setLoading(true); void load(); }} />
      ) : (
        <div className="rounded-xl bg-bg-secondary divide-y divide-border shadow-[var(--shadow-card)]">
          {users.map((user) => {
            const isMe = user.id === currentUserId;
            const sso = user.foreignSource === OBLIGATE;
            const no2fa = user.totpEnabled === false && user.emailOtpEnabled === false;
            return (
              <div key={user.id} className="flex items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">{anonymize(shownUsername(user.username), 'username')}</span>
                    {user.displayName && <span className="text-xs text-text-muted">({anonymize(user.displayName, 'username')})</span>}
                    <span
                      title={user.role === 'admin' ? t('users.rolePlatformAdmin', 'Platform administrator (every workspace)') : undefined}
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        user.role === 'admin' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-muted'
                      }`}
                    >
                      {user.role === 'admin'
                        ? <><Shield size={10} className="mr-0.5 inline" />{t('users.rolePlatformAdminShort', 'Platform admin')}</>
                        : t('users.roleUser', 'User')}
                    </span>
                    {sso && <SsoBadge title={ssoTitle} />}
                    {!user.isActive && (
                      <span className="rounded-full bg-status-down/10 px-1.5 py-0.5 text-[10px] font-medium text-status-down">{t('users.inactive', 'Off')}</span>
                    )}
                  </div>
                </div>
                <ActionMenu
                  label={t('common.moreActions', 'More actions')}
                  triggerSize="sm"
                  items={[
                    {
                      key: 'access',
                      icon: <KeyRound size={14} />,
                      label: t('users.effectiveAccess', 'Effective access'),
                      onClick: () => setAccessFor({ id: user.id, username: shownUsername(user.username) }),
                    },
                    {
                      key: 'edit',
                      icon: <Pencil size={14} />,
                      label: t('common.edit', 'Edit'),
                      onClick: () => openEdit(user),
                      hidden: sso,
                    },
                    {
                      key: 'tenants',
                      icon: <Building2 size={14} />,
                      label: t('users.tenants.manage', 'Manage tenant access'),
                      onClick: () => { void openTenantPanel(user); },
                      hidden: sso,
                    },
                    {
                      key: 'password',
                      icon: <Key size={14} />,
                      label: t('users.changePassword', 'Change password'),
                      onClick: () => { setPasswordUser(user); setFormPassword(''); },
                      hidden: isMe || sso,
                      separator: true,
                    },
                    {
                      key: '2fa',
                      icon: <ShieldOff size={14} />,
                      label: t('users.reset2fa', 'Reset 2FA'),
                      onClick: () => { void handleReset2fa(user); },
                      hidden: isMe || sso,
                      disabled: no2fa,
                    },
                    {
                      key: 'active',
                      icon: user.isActive ? <UserX size={14} /> : <UserIcon size={14} />,
                      label: user.isActive ? t('common.disable', 'Disable') : t('common.enable', 'Enable'),
                      onClick: () => { void handleToggleActive(user); },
                      hidden: isMe || sso,
                    },
                    {
                      key: 'delete',
                      icon: <Trash2 size={14} />,
                      label: t('common.delete', 'Delete'),
                      onClick: () => { void handleDeleteUser(user); },
                      hidden: isMe || sso,
                      danger: true,
                      separator: true,
                    },
                  ]}
                />
              </div>
            );
          })}
        </div>
      )}

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { void load(); }}
        platform
        sets={sets}
        canGrant={canGrant}
      />

      {/* Edit */}
      <Modal
        open={editingUser !== null}
        onClose={() => setEditingUser(null)}
        title={t('users.editUser', 'Edit {{username}}', { username: anonymize(shownUsername(editingUser?.username ?? ''), 'username') })}
        icon={<Pencil size={16} className="text-accent" />}
        footer={(
          <>
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditingUser(null)}>{t('common.cancel', 'Cancel')}</Button>
            <Button type="submit" form="edit-user-form" size="sm" loading={saving}>{t('common.save', 'Save')}</Button>
          </>
        )}
      >
        <form id="edit-user-form" onSubmit={handleEditUser} className="space-y-3">
          <Input label={t('users.usernameLabel', 'Username')} value={formUsername} onChange={(e) => setFormUsername(e.target.value)} required pattern="[a-zA-Z0-9_.\-]+" />
          <Input label={t('users.displayNameLabel', 'Display name')} value={formDisplayName} onChange={(e) => setFormDisplayName(e.target.value)} />
          <PlatformRoleField value={formRole} onChange={setFormRole} />
        </form>
      </Modal>

      {/* Password */}
      <Modal
        open={passwordUser !== null && passwordUser.id !== currentUserId}
        onClose={() => setPasswordUser(null)}
        title={t('users.changePasswordTitle', 'Change password of {{username}}', { username: anonymize(shownUsername(passwordUser?.username ?? ''), 'username') })}
        icon={<Key size={16} className="text-accent" />}
        footer={(
          <>
            <Button type="button" size="sm" variant="secondary" onClick={() => setPasswordUser(null)}>{t('common.cancel', 'Cancel')}</Button>
            <Button type="submit" form="password-user-form" size="sm" loading={saving}>{t('users.changePassword', 'Change password')}</Button>
          </>
        )}
      >
        <form id="password-user-form" onSubmit={handlePasswordChange} className="space-y-3">
          <Input label={t('users.newPassword', 'New password')} type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} required minLength={PASSWORD_MIN_LENGTH} autoComplete="new-password" autoFocus />
          <p className="text-xs text-text-muted">
            {t('users.passwordPolicyHint', 'At least {{min}} characters. The user must choose a new password at the next sign-in.', { min: PASSWORD_MIN_LENGTH })}
          </p>
        </form>
      </Modal>

      {/* Tenant access */}
      <Drawer
        open={tenantPanelUser !== null}
        onClose={closeTenantPanel}
        size="md"
        icon={<Building2 size={16} className="text-accent shrink-0" />}
        title={`${t('users.tenants.title', 'Tenants')} · ${anonymize(shownUsername(tenantPanelUser?.username ?? ''), 'username')}`}
        footer={tenantPanelUser?.role === 'admin' ? (
          <Button size="sm" variant="secondary" onClick={closeTenantPanel}>{t('common.close', 'Close')}</Button>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={closeTenantPanel}>{t('common.cancel', 'Cancel')}</Button>
            <Button size="sm" loading={tenantSaving} onClick={() => { void saveTenantAssignments(); }}>{t('common.save', 'Save')}</Button>
          </>
        )}
      >
        <div className="space-y-2">
          {tenantPanelLoading ? (
            <div className="flex justify-center py-8"><LoadingSpinner /></div>
          ) : tenantPanelUser?.role === 'admin' ? (
            <div className="rounded-lg border border-accent/20 bg-accent/5 p-3">
              <div className="flex items-start gap-2">
                <Shield size={14} className="mt-0.5 shrink-0 text-accent" />
                <p className="text-xs text-text-secondary">
                  {t('users.tenants.platformAdminNotice', 'Platform admins automatically access all tenants. No per-tenant assignment is needed.')}
                </p>
              </div>
            </div>
          ) : tenantAssignments.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">{t('users.tenants.none', 'No tenants available')}</p>
          ) : (
            tenantAssignments.map((assignment) => {
              const draft = tenantDraft[assignment.tenantId] ?? { isMember: assignment.isMember, role: assignment.role };
              return (
                <div
                  key={assignment.tenantId}
                  className={`rounded-lg border p-3 transition-colors ${
                    draft.isMember ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-tertiary'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Building2 size={14} className={draft.isMember ? 'shrink-0 text-accent' : 'shrink-0 text-text-muted'} />
                      <span className="truncate text-sm font-medium text-text-primary">{anonymize(assignment.tenantName, 'hostname')}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleTenantMember(assignment.tenantId)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 transition-colors ${
                        draft.isMember ? 'border-accent bg-accent' : 'border-border bg-bg-tertiary'
                      }`}
                      role="switch"
                      aria-checked={draft.isMember}
                      aria-label={assignment.tenantName}
                    >
                      <span
                        className={`pointer-events-none mt-px inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                          draft.isMember ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                  {draft.isMember && (
                    <div className="mt-2">
                      <div className="flex items-center gap-2">
                        <label htmlFor={`tenant-role-${assignment.tenantId}`} className="text-[10px] text-text-muted">
                          {t('users.tenants.roleLabel', 'Role')}
                        </label>
                        <RoleSelect
                          id={`tenant-role-${assignment.tenantId}`}
                          value={draft.role}
                          sets={sets}
                          canGrant={canGrant}
                          onChange={(role) => setTenantRole(assignment.tenantId, role)}
                          className="min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                        {draft.role === TENANT_ADMIN_ROLE && <Shield size={12} className="shrink-0 text-accent" />}
                      </div>
                      {draft.role === LEGACY_MEMBER_ROLE && (
                        <p className="mt-1 text-[10px] text-text-muted">
                          {t('users.tenants.legacyMember', 'Legacy "member" role: it has the Viewer permissions.')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </Drawer>

      <EffectiveAccessDrawer
        open={accessFor !== null}
        onClose={() => setAccessFor(null)}
        userId={accessFor?.id ?? null}
        username={accessFor?.username ?? ''}
      />
    </div>
  );
}

// ── Teams ───────────────────────────────────────────────────────────────────

function TeamsTab() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const confirm = useConfirm();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const currentTenantName = useTenantStore((s) => s.tenants.find((tn) => tn.id === s.currentTenantId)?.name ?? null);

  const [teams, setTeams] = useState<UserTeam[]>([]);
  const [tree, setTree] = useState<GroupTreeNode[]>([]);
  const [sites, setSites] = useState<Site[]>([]);

  // Team form
  const [teamFormMode, setTeamFormMode] = useState<'create' | 'edit' | null>(null);
  const [editingTeam, setEditingTeam] = useState<UserTeam | null>(null);
  const [formTeamName, setFormTeamName] = useState('');
  const [formTeamDesc, setFormTeamDesc] = useState('');
  const [formCanCreate, setFormCanCreate] = useState(false);
  const [saving, setSaving] = useState(false);

  // Selected team (right panel)
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [teamMembers, setTeamMembers] = useState<number[]>([]);
  // Users who may join the selected team: members of its tenant, with names.
  const [eligible, setEligible] = useState<TeamEligibleMember[]>([]);
  const [teamPermissions, setTeamPermissions] = useState<TeamPermissionEntry[]>([]);
  const [rightTab, setRightTab] = useState<'members' | 'permissions'>('members');

  // Teams are mono-tenant: the tab manages the teams of the current tenant,
  // against that tenant's groups and sites (reloaded on tenant switch).
  const load = useCallback(async () => {
    try {
      const [tm, tr, s] = await Promise.all([
        teamsApi.list(),
        groupsApi.tree(),
        siteApi.list(),
      ]);
      setTeams(tm);
      setTree(tr);
      setSites(s.sites);
    } catch (err) {
      toastApiError(err, t('users.failedLoad', 'Failed to load data'));
    }
  }, [t]);

  useEffect(() => {
    setSelectedTeamId(null);
    void load();
  }, [currentTenantId, load]);

  const loadTeamDetails = async (teamId: number) => {
    try {
      const detail = await teamsApi.getById(teamId);
      setTeamMembers(detail.memberIds);
      setEligible(detail.eligibleMembers);
      setTeamPermissions(detail.permissions);
    } catch (err) {
      toastApiError(err, t('users.teams.failedMembers', 'Failed to load the team'));
    }
  };

  const selectTeam = (teamId: number) => {
    setSelectedTeamId(teamId);
    void loadTeamDetails(teamId);
  };

  // ── Team form handlers ──

  const resetTeamForm = () => {
    setTeamFormMode(null);
    setEditingTeam(null);
    setFormTeamName('');
    setFormTeamDesc('');
    setFormCanCreate(false);
  };

  const submitTeam = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (teamFormMode === 'edit' && editingTeam) {
        await teamsApi.update(editingTeam.id, {
          name: formTeamName,
          description: formTeamDesc || null,
          canCreate: formCanCreate,
        });
        toast.success(t('users.teams.updated', 'Team updated'));
        resetTeamForm();
        void load();
      } else {
        // Created in the current tenant (teams are mono-tenant).
        const team = await teamsApi.create({
          name: formTeamName,
          description: formTeamDesc || null,
          canCreate: formCanCreate,
        });
        toast.success(t('users.teams.created', 'Team created'));
        resetTeamForm();
        void load();
        selectTeam(team.id);
      }
    } catch (err) {
      toastRefusal(err, teamFormMode === 'edit'
        ? t('users.teams.failedUpdate', 'Failed to update the team')
        : t('users.teams.failedCreate', 'Failed to create the team'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTeam = async (team: UserTeam) => {
    if (!(await confirm({ message: t('users.teams.confirmDelete', 'Delete team "{{name}}"?', { name: team.name }), danger: true }))) return;
    try {
      await teamsApi.delete(team.id);
      toast.success(t('users.teams.deleted', 'Team deleted'));
      if (selectedTeamId === team.id) setSelectedTeamId(null);
      void load();
    } catch (err) {
      toastRefusal(err, t('users.teams.failedDelete', 'Failed to delete the team'));
    }
  };

  // ── Members management ──

  // Only members of the team's tenant can join it (the server refuses others).
  const eligibleSet = new Set(eligible.map((m) => m.id));

  const toggleMember = async (userId: number) => {
    if (!selectedTeamId) return;
    const current = teamMembers.filter((id) => eligibleSet.has(id));
    const newMembers = current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId];
    try {
      await teamsApi.setMembers(selectedTeamId, { userIds: newMembers });
      setTeamMembers(newMembers);
    } catch (err) {
      toastRefusal(err, t('users.teams.failedUpdateMembers', 'Failed to update the members'));
    }
  };

  // ── Permissions management ──

  const addPermission = async (scope: TeamPermissionScope, scopeId: number, level: PermissionLevel) => {
    if (!selectedTeamId) return;
    const existing = teamPermissions.find((p) => p.scope === scope && p.scopeId === scopeId);
    const newPerms = existing
      ? teamPermissions.map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.id === existing.id ? level : p.level }))
      : [
        ...teamPermissions.map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.level })),
        { scope, scopeId, level },
      ];
    try {
      await teamsApi.setPermissions(selectedTeamId, { permissions: newPerms });
      await loadTeamDetails(selectedTeamId);
    } catch (err) {
      toastRefusal(err, existing
        ? t('users.teams.failedUpdatePermission', 'Failed to update the permission')
        : t('users.teams.failedAddPermission', 'Failed to add the permission'));
    }
  };

  const removePermission = async (permId: number) => {
    if (!selectedTeamId) return;
    try {
      await teamsApi.removePermission(selectedTeamId, permId);
      setTeamPermissions((prev) => prev.filter((p) => p.id !== permId));
    } catch (err) {
      toastRefusal(err, t('users.teams.failedRemovePermission', 'Failed to remove the permission'));
    }
  };

  const togglePermissionLevel = async (perm: TeamPermissionEntry) => {
    const newLevel: PermissionLevel = perm.level === 'ro' ? 'rw' : 'ro';
    await addPermission(perm.scope, perm.scopeId, newLevel);
  };

  const selectedTeam = teams.find((tm) => tm.id === selectedTeamId);

  // Build sets for quick lookup
  const assignedGroupIds = new Set(teamPermissions.filter((p) => p.scope === 'group').map((p) => p.scopeId));

  // Collect all descendant group IDs covered by a group permission (implicit coverage)
  const coveredGroupIds = new Set<number>();
  const coveredByGroupId = new Map<number, number>(); // descendant → assigned ancestor
  const collectDescendants = (nodes: GroupTreeNode[], coveredBy: number | null) => {
    for (const node of nodes) {
      const directlyAssigned = assignedGroupIds.has(node.id);
      const effectiveCover = directlyAssigned ? node.id : coveredBy;
      if (coveredBy && !directlyAssigned) {
        coveredGroupIds.add(node.id);
        coveredByGroupId.set(node.id, coveredBy);
      }
      collectDescendants(node.children, effectiveCover);
    }
  };
  collectDescendants(tree, null);

  // Get permission for a group / a site
  const getGroupPerm = (groupId: number) => teamPermissions.find((p) => p.scope === 'group' && p.scopeId === groupId);
  const getSitePerm = (siteId: number) => teamPermissions.find((p) => p.scope === 'site' && p.scopeId === siteId);

  // Level a site inherits from group permissions on its group and ancestors.
  const groupParent = new Map<number, number | null>();
  const indexParents = (nodes: GroupTreeNode[]) => {
    for (const node of nodes) {
      groupParent.set(node.id, node.parentId ?? null);
      indexParents(node.children);
    }
  };
  indexParents(tree);
  const inheritedSiteLevel = (site: Site): PermissionLevel | null => {
    let level: PermissionLevel | null = null;
    let groupId = site.groupId;
    const seen = new Set<number>();
    while (groupId !== null && !seen.has(groupId)) {
      seen.add(groupId);
      const perm = getGroupPerm(groupId);
      if (perm?.level === 'rw') return 'rw';
      if (perm) level = 'ro';
      groupId = groupParent.get(groupId) ?? null;
    }
    return level;
  };

  // Tenant sites, by group (ungrouped sites listed on their own)
  const sitesByGroup = new Map<number, Site[]>();
  const ungroupedSites: Site[] = [];
  for (const site of sites) {
    if (site.groupId === null) {
      ungroupedSites.push(site);
    } else {
      const list = sitesByGroup.get(site.groupId) ?? [];
      list.push(site);
      sitesByGroup.set(site.groupId, list);
    }
  }
  const siteRowProps = { getSitePerm, inheritedSiteLevel, addPermission, removePermission, togglePermissionLevel };
  const ssoTeamsTitle = t('users.ssoManagedTeams', 'Managed in Obligate: team membership is reset at the next sign-in');

  return (
    <div className="flex min-w-0 flex-col gap-6 lg:flex-row">
      {/* Left: team list */}
      <div className="min-w-0 flex-1 lg:max-w-xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{t('users.tabTeams', 'Teams')}</h2>
          <Button size="sm" onClick={() => { resetTeamForm(); setTeamFormMode('create'); }}>
            <Plus size={14} className="mr-1" />{t('common.new', 'New')}
          </Button>
        </div>

        {/* Teams are mono-tenant: this tab manages the current tenant's teams */}
        <p className="mb-3 flex items-center gap-1.5 text-xs text-text-muted">
          <Building2 size={12} className="shrink-0" />
          {currentTenantName
            ? t('users.teams.tenantScopeNamed', 'Teams of tenant {{tenant}}. Switch tenant to manage the teams of another tenant.', { tenant: anonymize(currentTenantName, 'hostname') })
            : t('users.teams.tenantScope', 'Teams of the current tenant. Switch tenant to manage the teams of another tenant.')}
        </p>

        <div className="rounded-xl bg-bg-secondary divide-y divide-border shadow-[var(--shadow-card)]">
          {teams.length === 0 ? (
            <div className="py-8 text-center">
              <Users size={28} className="mx-auto mb-2 text-text-muted" />
              <p className="text-sm text-text-muted">{t('users.teams.noTeams', 'No teams yet')}</p>
            </div>
          ) : (
            teams.map((team) => (
              <div
                key={team.id}
                onClick={() => selectTeam(team.id)}
                className={`group flex cursor-pointer items-center gap-2 px-3 py-2.5 transition-colors ${
                  selectedTeamId === team.id ? 'border-l-2 border-l-accent bg-accent/5' : 'hover:bg-bg-hover'
                }`}
              >
                <Users size={14} className="shrink-0 text-text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-text-primary">{team.name}</span>
                    {team.canCreate && (
                      <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        {t('users.teams.createBadge', 'Can create')}
                      </span>
                    )}
                  </div>
                  {team.description && (
                    <p className="truncate text-xs text-text-muted">{team.description}</p>
                  )}
                </div>
                <IconButton
                  label={t('common.edit', 'Edit')}
                  icon={<Pencil size={13} />}
                  size="sm"
                  touchTarget="overlay"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingTeam(team);
                    setFormTeamName(team.name);
                    setFormTeamDesc(team.description || '');
                    setFormCanCreate(team.canCreate);
                    setTeamFormMode('edit');
                  }}
                />
                <IconButton
                  label={t('common.delete', 'Delete')}
                  icon={<Trash2 size={13} />}
                  size="sm"
                  variant="danger"
                  touchTarget="overlay"
                  onClick={(e) => { e.stopPropagation(); void handleDeleteTeam(team); }}
                />
                <ChevronRight size={14} className="shrink-0 text-text-muted" />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right: team details */}
      {selectedTeam && (
        <div className="min-w-0 flex-1 lg:max-w-2xl">
          <div className="lg:sticky lg:top-6">
            <h2 className="mb-1 text-lg font-semibold text-text-primary">{selectedTeam.name}</h2>
            {selectedTeam.description && (
              <p className="mb-4 text-sm text-text-muted">{selectedTeam.description}</p>
            )}

            <SegmentedTabs<'members' | 'permissions'>
              value={rightTab}
              onChange={setRightTab}
              size="sm"
              className="mb-4"
              tabs={[
                { id: 'members', label: t('users.teams.tabMembers', 'Members') },
                { id: 'permissions', label: t('users.teams.tabPermissions', 'Permissions') },
              ]}
            />

            {/* Members — only members of the team's tenant can join */}
            {rightTab === 'members' && (
              <>
                <p className="mb-2 text-xs text-text-muted">
                  {t('users.teams.membersTenantHint', 'Only members of this tenant are listed (Admin > Users > tenant access).')}
                </p>
                <div className="max-h-[60vh] divide-y divide-border overflow-y-auto rounded-xl bg-bg-secondary shadow-[var(--shadow-card)]">
                  {eligible.length === 0 ? (
                    <p className="p-4 text-center text-sm text-text-muted">{t('users.teams.noUsers', 'No users')}</p>
                  ) : (
                    eligible.map((user) => {
                      const isMember = teamMembers.includes(user.id);
                      const sso = user.foreignSource === OBLIGATE;
                      return (
                        <label
                          key={user.id}
                          className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-bg-hover"
                          title={sso ? ssoTeamsTitle : undefined}
                        >
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              isMember ? 'border-accent bg-accent' : 'border-border bg-bg-tertiary'
                            }`}
                            onClick={(e) => { e.preventDefault(); void toggleMember(user.id); }}
                          >
                            {isMember && <Check size={12} className="text-white" />}
                          </div>
                          <span className="text-sm text-text-primary">{anonymize(shownUsername(user.username), 'username')}</span>
                          {user.displayName && <span className="text-xs text-text-muted">({anonymize(user.displayName, 'username')})</span>}
                          {sso && <SsoBadge title={ssoTeamsTitle} />}
                          {!user.isActive && <span className="text-[10px] text-status-down">{t('users.disabled', 'User disabled')}</span>}
                        </label>
                      );
                    })
                  )}
                </div>
              </>
            )}

            {/* Permissions — group tree with its sites, then ungrouped sites */}
            {rightTab === 'permissions' && (
              <>
                <p className="mb-2 text-xs text-text-muted">
                  {t('teams.levelExplain', 'RO lets the members read; RW lets them edit sites, devices and groups, whatever their workspace role.')}
                </p>
                <div className="max-h-[70vh] overflow-y-auto rounded-xl bg-bg-secondary shadow-[var(--shadow-card)]">
                  {tree.length === 0 && ungroupedSites.length === 0 ? (
                    <p className="p-4 text-center text-sm text-text-muted">{t('users.teams.noResources', 'No groups or sites')}</p>
                  ) : (
                    <div className="py-1">
                      {tree.map((node) => (
                        <PermTreeNode
                          key={node.id}
                          node={node}
                          depth={0}
                          getGroupPerm={getGroupPerm}
                          assignedGroupIds={assignedGroupIds}
                          coveredGroupIds={coveredGroupIds}
                          coveredByGroupId={coveredByGroupId}
                          sitesByGroup={sitesByGroup}
                          siteRowProps={siteRowProps}
                          addPermission={addPermission}
                          removePermission={removePermission}
                          togglePermissionLevel={togglePermissionLevel}
                        />
                      ))}
                      {ungroupedSites.length > 0 && (
                        <>
                          <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                            {t('users.teams.ungroupedSites', 'Ungrouped sites')}
                          </div>
                          {ungroupedSites.map((site) => (
                            <PermSiteRow key={site.id} site={site} depth={0} {...siteRowProps} />
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Team form */}
      <Modal
        open={teamFormMode !== null}
        onClose={resetTeamForm}
        title={teamFormMode === 'edit'
          ? t('users.teams.editTeam', 'Edit {{name}}', { name: editingTeam?.name })
          : t('users.teams.newTeam', 'New team')}
        icon={<Users size={16} className="text-accent" />}
        footer={(
          <>
            <Button type="button" size="sm" variant="secondary" onClick={resetTeamForm}>{t('common.cancel', 'Cancel')}</Button>
            <Button type="submit" form="team-form" size="sm" loading={saving}>
              {teamFormMode === 'edit' ? t('common.save', 'Save') : t('common.create', 'Create')}
            </Button>
          </>
        )}
      >
        <form id="team-form" onSubmit={submitTeam} className="space-y-3">
          <Input label={t('users.teams.nameLabel', 'Name')} value={formTeamName} onChange={(e) => setFormTeamName(e.target.value)} required autoFocus />
          <Input label={t('users.teams.descLabel', 'Description')} value={formTeamDesc} onChange={(e) => setFormTeamDesc(e.target.value)} />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
            <Checkbox checked={formCanCreate} onCheckedChange={setFormCanCreate} />
            {t('users.teams.canCreate', 'Can create groups and sites')}
          </label>
        </form>
      </Modal>
    </div>
  );
}

// ── Permission Tree Sub-Components ──

type AddPermission = (scope: TeamPermissionScope, scopeId: number, level: PermissionLevel) => Promise<void>;

interface SiteRowProps {
  getSitePerm: (siteId: number) => TeamPermissionEntry | undefined;
  inheritedSiteLevel: (site: Site) => PermissionLevel | null;
  addPermission: AddPermission;
  removePermission: (permId: number) => Promise<void>;
  togglePermissionLevel: (perm: TeamPermissionEntry) => Promise<void>;
}

interface PermTreeNodeProps {
  node: GroupTreeNode;
  depth: number;
  getGroupPerm: (groupId: number) => TeamPermissionEntry | undefined;
  assignedGroupIds: Set<number>;
  coveredGroupIds: Set<number>;
  coveredByGroupId: Map<number, number>;
  sitesByGroup: Map<number, Site[]>;
  siteRowProps: SiteRowProps;
  addPermission: AddPermission;
  removePermission: (permId: number) => Promise<void>;
  togglePermissionLevel: (perm: TeamPermissionEntry) => Promise<void>;
}

function PermLevelControls({
  perm,
  onAdd,
  removePermission,
  togglePermissionLevel,
}: {
  perm: TeamPermissionEntry | undefined;
  onAdd: (level: PermissionLevel) => void;
  removePermission: (permId: number) => Promise<void>;
  togglePermissionLevel: (perm: TeamPermissionEntry) => Promise<void>;
}) {
  const { t } = useTranslation();
  const roHint = t('teams.levelRoHint', 'Read only');
  const rwHint = t('teams.levelRwHint', "Read & edit (whatever the member's role)");
  if (perm) {
    return (
      <>
        <button
          type="button"
          onClick={() => { void togglePermissionLevel(perm); }}
          className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
            perm.level === 'rw'
              ? 'bg-accent/10 text-accent hover:bg-accent/20'
              : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover'
          }`}
          title={`${perm.level === 'rw' ? rwHint : roHint} · ${t('teams.toggleLevel', 'Click to switch RO / RW')}`}
        >
          {perm.level === 'rw'
            ? <><Pencil size={10} className="mr-0.5 inline" />{t('users.teams.rwLabel', 'RW')}</>
            : <><Eye size={10} className="mr-0.5 inline" />{t('users.teams.roLabel', 'RO')}</>}
        </button>
        <IconButton
          label={t('common.delete', 'Delete')}
          icon={<Trash2 size={11} />}
          size="xs"
          variant="danger"
          touchTarget="overlay"
          onClick={() => { void removePermission(perm.id); }}
        />
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => onAdd('ro')}
        className="shrink-0 rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-bg-hover"
        title={roHint}
      >
        {t('users.teams.roLabel', 'RO')}
      </button>
      <button
        type="button"
        onClick={() => onAdd('rw')}
        className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/20"
        title={rwHint}
      >
        {t('users.teams.rwLabel', 'RW')}
      </button>
    </>
  );
}

/**
 * One site: a direct 'site' permission, or what it inherits from its group
 * chain. A direct permission can still raise an inherited RO to RW.
 */
function PermSiteRow({
  site,
  depth,
  getSitePerm,
  inheritedSiteLevel,
  addPermission,
  removePermission,
  togglePermissionLevel,
}: SiteRowProps & { site: Site; depth: number }) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const perm = getSitePerm(site.id);
  const inherited = inheritedSiteLevel(site);

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1.5 transition-colors hover:bg-bg-hover ${
        perm ? 'bg-accent/5' : inherited ? 'bg-accent/[0.02]' : ''
      }`}
      style={{ paddingLeft: `${depth * 20 + 8 + 18}px` }}
    >
      <MapPin size={12} className={`shrink-0 ${perm ? 'text-accent' : inherited ? 'text-accent/40' : 'text-text-muted'}`} />
      <span className={`flex-1 truncate text-sm ${perm ? 'font-medium text-text-primary' : inherited ? 'text-text-muted' : 'text-text-primary'}`}>
        {anonymize(site.name, 'hostname')}
      </span>

      {inherited && !perm && (
        <span className="shrink-0 text-[10px] italic text-text-muted">
          {t('users.teams.inherited', 'Inherited')} ({inherited === 'rw' ? t('users.teams.rwLabel', 'RW') : t('users.teams.roLabel', 'RO')})
        </span>
      )}

      {/* An inherited RW already grants everything: no direct permission needed */}
      {(perm || inherited !== 'rw') && (
        <PermLevelControls
          perm={perm}
          onAdd={(level) => { void addPermission('site', site.id, level); }}
          removePermission={removePermission}
          togglePermissionLevel={togglePermissionLevel}
        />
      )}
    </div>
  );
}

function PermTreeNode({
  node,
  depth,
  getGroupPerm,
  assignedGroupIds,
  coveredGroupIds,
  coveredByGroupId,
  sitesByGroup,
  siteRowProps,
  addPermission,
  removePermission,
  togglePermissionLevel,
}: PermTreeNodeProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [expanded, setExpanded] = useState(true);
  const perm = getGroupPerm(node.id);
  const isCovered = coveredGroupIds.has(node.id);
  const groupSites = sitesByGroup.get(node.id) ?? [];
  const hasChildren = node.children.length > 0 || groupSites.length > 0;

  return (
    <div>
      {/* Group row */}
      <div
        className={`flex items-center gap-1.5 px-2 py-1.5 transition-colors hover:bg-bg-hover ${
          perm ? 'bg-accent/5' : isCovered ? 'bg-accent/[0.02]' : ''
        }`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? t('common.collapse', 'Collapse') : t('common.expand', 'Expand')}
          className={`shrink-0 p-0.5 text-text-muted transition-colors hover:text-text-primary ${!hasChildren ? 'invisible' : ''}`}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>

        <FolderOpen size={13} className={`shrink-0 ${perm ? 'text-accent' : isCovered ? 'text-accent/40' : 'text-text-muted'}`} />
        <span className={`flex-1 truncate text-sm ${perm ? 'font-medium text-text-primary' : isCovered ? 'text-text-muted' : 'text-text-primary'}`}>
          {anonymize(node.name, 'hostname')}
        </span>

        {node.isGeneral && (
          <span className="shrink-0 rounded bg-accent/10 px-1 text-[10px] text-accent">{t('users.teams.generalBadge', 'General')}</span>
        )}

        {!perm && isCovered ? (
          <span className="shrink-0 text-[10px] italic text-text-muted">{t('users.teams.inherited', 'Inherited')}</span>
        ) : (
          <PermLevelControls
            perm={perm}
            onAdd={(level) => { void addPermission('group', node.id, level); }}
            removePermission={removePermission}
            togglePermissionLevel={togglePermissionLevel}
          />
        )}
      </div>

      {/* Sites of the group, then sub-groups */}
      {expanded && groupSites.map((site) => (
        <PermSiteRow key={`site-${site.id}`} site={site} depth={depth} {...siteRowProps} />
      ))}
      {expanded && node.children.map((child) => (
        <PermTreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          getGroupPerm={getGroupPerm}
          assignedGroupIds={assignedGroupIds}
          coveredGroupIds={coveredGroupIds}
          coveredByGroupId={coveredByGroupId}
          sitesByGroup={sitesByGroup}
          siteRowProps={siteRowProps}
          addPermission={addPermission}
          removePermission={removePermission}
          togglePermissionLevel={togglePermissionLevel}
        />
      ))}
    </div>
  );
}
