import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Building2, Plus, Pencil, Trash2, Users, X, Check } from 'lucide-react';
import type { Tenant } from '@oblimap/shared';
import apiClient from '@/api/client';
import { tenantMembersApi, type TenantMember } from '@/api/tenantMembers.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { PageContainer } from '@/components/common/PageContainer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useAnonymize } from '@/utils/anonymize';
import { apiErrorMessage, toastApiError } from '@/utils/apiError';

interface TenantWithMemberCount extends Tenant {
  memberCount?: number;
}

/** A permission set, as a tenant role choice (GET /api/permission-sets). */
interface RoleOption {
  id: number;
  name: string;
  slug: string;
  isDefault: boolean;
}

// Tenant role 'member': every non-admin membership before permission sets
// were assignable; the server reads it as the 'viewer' set. New members get
// the Viewer set itself.
const LEGACY_MEMBER_ROLE = 'member';
const TENANT_ADMIN_ROLE = 'admin';
const DEFAULT_NEW_MEMBER_ROLE = 'viewer';
const OBLIGATE = 'obligate';

/** Label of a tenant role: 'admin' is the workspace admin, a set its name, else a readable fallback. */
function roleLabel(role: string, roles: RoleOption[], t: TFunction): string {
  if (role === TENANT_ADMIN_ROLE) return t('users.tenants.roleWorkspaceAdmin', 'Workspace admin');
  const set = roles.find((r) => r.slug === role);
  if (set) return set.name;
  if (role === LEGACY_MEMBER_ROLE) return t('tenant.roleLegacyMember', 'Member (as Viewer)');
  return t('tenant.roleUnknown', '{{role}} (unknown role)', { role });
}

/** Display name of an account: the og_ prefix of SSO accounts is dropped. */
function shownUsername(username: string): string {
  return username.startsWith('og_') ? username.slice(3) : username;
}

// ── Inline form for creating / editing a tenant ────────────────────────────
function TenantForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: { name: string; slug: string };
  onSave: (name: string, slug: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const autoSlug = (n: string) =>
    n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const handleNameChange = (v: string) => {
    setName(v);
    if (!initial) setSlug(autoSlug(v));
  };

  const handleSubmit = async () => {
    if (!name.trim() || !slug.trim()) { setError(t('common.requiredField')); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(name.trim(), slug.trim());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[10rem] flex-1">
        <label className="mb-1 block text-xs text-text-muted">{t('tenant.name')}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          className="w-full rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder={t('tenant.namePlaceholder')}
        />
      </div>
      <div className="w-40">
        <label className="mb-1 block text-xs text-text-muted">{t('tenant.slug')}</label>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="w-full rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder="my-org"
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <Button size="sm" onClick={handleSubmit} disabled={saving} aria-label={t('common.save', 'Save')}>
        <Check size={14} />
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving} aria-label={t('common.cancel', 'Cancel')}>
        <X size={14} />
      </Button>
    </div>
  );
}

// ── Members dialog ──────────────────────────────────────────────────────────
function MembersDialog({ tenant, onClose }: { tenant: TenantWithMemberCount | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const confirm = useConfirm();
  const tenantId = tenant?.id ?? null;
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [allUsers, setAllUsers] = useState<{ id: number; username: string }[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingId, setAddingId] = useState<number | ''>('');
  const [addingRole, setAddingRole] = useState(DEFAULT_NEW_MEMBER_ROLE);
  const [busy, setBusy] = useState(false);

  const ssoTitle = t('users.ssoManagedRole', 'Managed in Obligate: role reset at next sign-in');

  const fetchMembers = async (id: number) => {
    try {
      setMembers(await tenantMembersApi.listForTenant(id));
    } catch (err) {
      toastApiError(err, t('tenant.failedLoadMembers', 'Failed to load members'));
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await apiClient.get<{ data?: { id: number; username: string }[] }>('/users');
      setAllUsers(res.data.data ?? []);
    } catch (err) {
      toastApiError(err, t('tenant.failedLoadUsers', 'Failed to load users'));
    }
  };

  const fetchRoles = async () => {
    try {
      const res = await apiClient.get<{ data?: RoleOption[] }>('/permission-sets');
      setRoles(res.data.data ?? []);
    } catch (err) {
      toastApiError(err, t('tenant.failedLoadRoles', 'Failed to load roles'));
    }
  };

  useEffect(() => {
    if (tenantId === null) return;
    setLoading(true);
    setMembers([]);
    setAddingId('');
    setAddingRole(DEFAULT_NEW_MEMBER_ROLE);
    void fetchMembers(tenantId);
    void fetchUsers();
    void fetchRoles();
  }, [tenantId]);

  const addMember = async () => {
    if (tenantId === null || !addingId || busy) return;
    setBusy(true);
    try {
      await tenantMembersApi.addToTenant(tenantId, addingId, addingRole);
      setAddingId('');
      await fetchMembers(tenantId);
    } catch (err) {
      toastApiError(err, t('tenant.failedAddMember', 'Failed to add the member'));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: TenantMember, role: string) => {
    // SSO members: the server refuses (role managed in Obligate), the select is disabled.
    if (tenantId === null || busy || member.foreignSource === OBLIGATE) return;
    setBusy(true);
    try {
      await tenantMembersApi.setRoleInTenant(tenantId, member.id, role);
      await fetchMembers(tenantId);
    } catch (err) {
      toastApiError(err, t('tenant.failedChangeRole', 'Failed to change the role'));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (member: TenantMember) => {
    if (tenantId === null) return;
    const username = anonymize(shownUsername(member.username), 'username');
    const message = member.foreignSource === OBLIGATE
      ? t('users.ssoConfirmRemove', '{{username}} is managed in Obligate: the membership comes back at the next sign-in while Obligate grants this workspace. Remove anyway?', { username })
      : t('tenant.confirmRemoveMember', 'Remove {{username}} from this workspace? The account itself is kept.', { username });
    if (!(await confirm({ message, danger: true, confirmLabel: t('tenant.removeMember', 'Remove member') }))) return;
    try {
      await tenantMembersApi.removeFromTenant(tenantId, member.id);
      await fetchMembers(tenantId);
    } catch (err) {
      toastApiError(err, t('tenant.failedRemoveMember', 'Failed to remove the member'));
    }
  };

  /** Choices for a member: every permission set, and the member's current role when it is none of them. */
  const roleChoices = (current?: string): { value: string; label: string }[] => {
    const choices = roles.map((r) => ({ value: r.slug, label: roleLabel(r.slug, roles, t) }));
    if (current && !choices.some((c) => c.value === current)) {
      choices.push({ value: current, label: roleLabel(current, roles, t) });
    }
    return choices;
  };

  const nonMembers = allUsers.filter((u) => !members.some((m) => m.id === u.id));
  const selectClass = 'rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

  return (
    <Modal
      open={tenant !== null}
      onClose={onClose}
      size="lg"
      icon={<Users size={15} className="text-accent" />}
      title={tenant ? `${t('tenant.members', 'Members')} · ${tenant.name}` : t('tenant.members', 'Members')}
      footer={nonMembers.length > 0 ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          <select
            value={addingId}
            onChange={(e) => setAddingId(e.target.value ? Number(e.target.value) : '')}
            className="min-w-[10rem] flex-1 rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            aria-label={t('tenant.selectUser', 'Select a user')}
          >
            <option value="">{t('tenant.selectUser', 'Select a user')}</option>
            {nonMembers.map((u) => (
              <option key={u.id} value={u.id}>{anonymize(shownUsername(u.username), 'username')}</option>
            ))}
          </select>
          <select
            value={addingRole}
            onChange={(e) => setAddingRole(e.target.value)}
            className={selectClass}
            title={t('tenant.role', 'Role')}
            aria-label={t('tenant.role', 'Role')}
          >
            {roleChoices(addingRole).map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <Button size="sm" onClick={addMember} disabled={!addingId || busy}>
            {t('tenant.addMember', 'Add member')}
          </Button>
        </div>
      ) : undefined}
    >
      <p className="mb-3 text-xs text-text-muted">
        {t('tenant.roleHint', 'The role decides what a member may do in this workspace (permission sets); teams decide which groups and sites.')}
      </p>

      {loading ? (
        <div className="flex justify-center py-6"><LoadingSpinner /></div>
      ) : members.length === 0 ? (
        <p className="py-4 text-center text-sm text-text-muted">{t('tenant.noMembers', 'No members')}</p>
      ) : (
        <div className="space-y-2">
          {members.map((m) => {
            const sso = m.foreignSource === OBLIGATE;
            return (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-text-primary">{anonymize(shownUsername(m.username), 'username')}</span>
                  {m.displayName && (
                    <span className="text-xs text-text-muted">({anonymize(m.displayName, 'username')})</span>
                  )}
                  {sso && (
                    <span
                      title={ssoTitle}
                      className="inline-flex items-center gap-1 rounded-full border border-[#4338ca]/40 bg-[#1e1b4b]/60 px-1.5 py-0.5 text-[10px] font-medium text-[#a5b4fc]"
                    >
                      SSO
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <select
                    value={m.tenantRole}
                    onChange={(e) => { void changeRole(m, e.target.value); }}
                    disabled={busy || roles.length === 0 || sso}
                    className={`${selectClass} ${m.tenantRole === TENANT_ADMIN_ROLE ? 'text-accent' : ''}`}
                    title={sso ? ssoTitle : t('tenant.role', 'Role')}
                    aria-label={t('tenant.role', 'Role')}
                  >
                    {roleChoices(m.tenantRole).map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                  <IconButton
                    label={t('tenant.removeMember', 'Remove member')}
                    icon={<X size={13} />}
                    size="sm"
                    variant="danger"
                    onClick={() => { void removeMember(m); }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export function AdminTenantsPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [tenants, setTenants] = useState<TenantWithMemberCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [membersFor, setMembersFor] = useState<TenantWithMemberCount | null>(null);

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data?: TenantWithMemberCount[] }>('/tenants');
      setTenants(res.data.data ?? []);
    } catch (err) {
      toastApiError(err, t('tenant.failedLoad', 'Failed to load workspaces'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchTenants(); }, []);

  const handleCreate = async (name: string, slug: string) => {
    try {
      await apiClient.post('/tenants', { name, slug });
    } catch (err) {
      throw new Error(apiErrorMessage(err, t('common.error')));
    }
    setCreating(false);
    void fetchTenants();
  };

  const handleUpdate = async (id: number, name: string, slug: string) => {
    try {
      await apiClient.put(`/tenants/${id}`, { name, slug });
    } catch (err) {
      throw new Error(apiErrorMessage(err, t('common.error')));
    }
    setEditingId(null);
    void fetchTenants();
  };

  const handleDelete = async (tenant: TenantWithMemberCount) => {
    if (!(await confirm({ message: t('tenant.confirmDelete'), danger: true }))) return;
    try {
      await apiClient.delete(`/tenants/${tenant.id}`);
    } catch (err) {
      toastApiError(err, t('common.error'));
    }
    void fetchTenants();
  };

  return (
    <PageContainer
      title={t('tenant.pageTitle')}
      subtitle={t('tenant.pageDesc')}
      icon={<Building2 size={18} />}
      actions={!creating ? (
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} />
          {t('tenant.create')}
        </Button>
      ) : undefined}
    >
      {creating && (
        <div className="mb-4 rounded-xl bg-bg-secondary p-4 shadow-[var(--shadow-card)]">
          <TenantForm onSave={handleCreate} onCancel={() => setCreating(false)} />
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : tenants.length === 0 ? (
        <p className="text-sm text-text-muted">{t('tenant.noTenants')}</p>
      ) : (
        <div className="space-y-2">
          {tenants.map((tenant) => (
            <div
              key={tenant.id}
              className="rounded-xl bg-bg-secondary px-4 py-3 shadow-[var(--shadow-card)]"
            >
              {editingId === tenant.id ? (
                <TenantForm
                  initial={{ name: tenant.name, slug: tenant.slug }}
                  onSave={(name, slug) => handleUpdate(tenant.id, name, slug)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Building2 size={14} className="shrink-0 text-accent" />
                      <span className="text-sm font-semibold text-text-primary">{tenant.name}</span>
                      {tenant.id === 1 && (
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                          {t('tenant.default')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-text-muted">
                      /{tenant.slug} · {t('tenant.createdAt')} {new Date(tenant.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setMembersFor(tenant)}
                      title={t('tenant.manageMembers')}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <Users size={13} />
                      {t('tenant.members')}
                    </button>
                    <IconButton
                      label={t('common.edit', 'Edit')}
                      icon={<Pencil size={13} />}
                      onClick={() => setEditingId(tenant.id)}
                    />
                    {tenant.id !== 1 && (
                      <IconButton
                        label={t('common.delete', 'Delete')}
                        icon={<Trash2 size={13} />}
                        variant="danger"
                        onClick={() => { void handleDelete(tenant); }}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <MembersDialog tenant={membersFor} onClose={() => setMembersFor(null)} />
    </PageContainer>
  );
}
