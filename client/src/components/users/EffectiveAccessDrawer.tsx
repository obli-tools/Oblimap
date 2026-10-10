import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, FolderOpen, KeyRound, MapPin, Pencil, Shield, Users } from 'lucide-react';
import { CAPABILITY_GROUPS, type GroupTreeNode, type Site } from '@oblimap/shared';
import { Drawer } from '@/components/common/Drawer';
import { LoadError } from '@/components/common/LoadError';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { usersApi, type EffectiveAccess, type EffectiveAccessTeam } from '@/api/users.api';
import { groupsApi } from '@/api/groups.api';
import { siteApi } from '@/api/site.api';
import { permissionSetsApi, permissionSetSlugForRole, type PermissionSet } from '@/api/permissionSets.api';
import { useTenantStore } from '@/store/tenantStore';
import { useAnonymize } from '@/utils/anonymize';
import { apiErrorMessage } from '@/utils/apiError';

// "What can this user do and see here?": the tenant role and its
// capabilities, the teams, and the groups / sites the user may read or edit,
// each with the grant it comes from. Built on GET /users/:id/effective-access
// (the server computes the readable / writable ids); the names come from the
// caller's own tree, so a node the caller cannot see is only counted.

type Level = 'ro' | 'rw';

/** English short names of the capabilities (translated: permissionSets.capName.*). */
const CAP_SHORT_NAMES: Record<string, string> = {
  monitoring: 'Monitoring',
  'groups.manage': 'Manage groups',
  'sites.manage': 'Manage sites',
  'probes.read': 'View probes',
  'probes.approve': 'Approve probes',
  'probes.manage': 'Manage probes',
  'tunnels.use': 'Use tunnels',
  'deviceChecks.manage': 'Manage device checks',
  'notifications.manage': 'Manage notifications',
  settings: 'Settings',
  'users.manage': 'Manage users and teams',
  'audit.read': 'Read the audit log',
};

const capKey = (cap: string) => cap.replace(/\./g, '_');

interface Grant {
  team: string;
  level: Level;
  /** Group the grant is set on, when inherited from an ancestor / the site's group. */
  viaGroupId: number | null;
}

export interface EffectiveAccessDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The user to inspect (null: closed). */
  userId: number | null;
  /** Shown in the title (anonymised by the drawer). */
  username: string;
}

export function EffectiveAccessDrawer({ open, onClose, userId, username }: EffectiveAccessDrawerProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [access, setAccess] = useState<EffectiveAccess | null>(null);
  const [tree, setTree] = useState<GroupTreeNode[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [sets, setSets] = useState<PermissionSet[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (userId === null) return;
    setLoading(true);
    setError(null);
    try {
      const [acc, tr, s, ps] = await Promise.all([
        usersApi.effectiveAccess(userId, currentTenantId),
        groupsApi.tree().catch(() => [] as GroupTreeNode[]),
        siteApi.list().then((r) => r.sites).catch(() => [] as Site[]),
        permissionSetsApi.list().catch(() => [] as PermissionSet[]),
      ]);
      setAccess(acc);
      setTree(tr);
      setSites(s);
      setSets(ps);
    } catch (err) {
      setAccess(null);
      // A refusal (403 {error:'forbidden', reason:<code>, message:<sentence>})
      // shows its sentence, never the code.
      setError(apiErrorMessage(err, t('users.access.failedLoad', 'Failed to load the effective access')));
    } finally {
      setLoading(false);
    }
  }, [userId, currentTenantId, t]);

  useEffect(() => {
    if (open && userId !== null) void load();
    if (!open) { setAccess(null); setError(null); }
  }, [open, userId, load]);

  return (
    <Drawer
      open={open && userId !== null}
      onClose={onClose}
      size="lg"
      icon={<KeyRound size={16} className="text-accent shrink-0" />}
      title={t('users.access.title', 'Effective access of {{username}}', { username: anonymize(username, 'username') })}
    >
      {loading && !access ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : error ? (
        <LoadError message={error} onRetry={() => { void load(); }} />
      ) : access ? (
        <AccessBody access={access} tree={tree} sites={sites} sets={sets} />
      ) : null}
    </Drawer>
  );
}

function AccessBody({
  access,
  tree,
  sites,
  sets,
}: {
  access: EffectiveAccess;
  tree: GroupTreeNode[];
  sites: Site[];
  sets: PermissionSet[];
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const role = access.role ? permissionSetSlugForRole(access.role) : null;
  // The server's verdict (false for a disabled account).
  const fullAccess = access.fullAccess;

  const roleName = (() => {
    if (access.platformAdmin) return t('users.rolePlatformAdmin', 'Platform administrator (every workspace)');
    if (role === null) return t('users.access.noMembership', 'Not a member of this workspace');
    if (role === 'admin') return t('users.tenants.roleWorkspaceAdmin', 'Workspace admin');
    const set = sets.find((s) => s.slug === role);
    return set ? set.name : t('users.tenants.roleUnknown', '{{role}} (unknown role)', { role });
  })();

  // ── Capabilities, by category ──
  const held = new Set(access.capabilities);
  const known = new Set<string>(CAPABILITY_GROUPS.flatMap((g) => g.keys));
  const categories = [
    ...CAPABILITY_GROUPS.map((g) => ({
      key: g.id,
      label: t(`permissionSets.groups.${g.id}`, g.label),
      caps: g.keys.filter((c) => held.has(c)) as string[],
    })),
    { key: 'other', label: t('permissionSets.groups.other', 'Other'), caps: access.capabilities.filter((c) => !known.has(c)) },
  ].filter((g) => g.caps.length > 0);
  const capName = (cap: string) => t(`permissionSets.capName.${capKey(cap)}`, CAP_SHORT_NAMES[cap] ?? cap);
  const capDescription = (cap: string) => t(`permissionSets.cap.${capKey(cap)}`, cap);

  // ── Groups / sites with the origin of each grant ──
  const index = useMemo(() => {
    const parent = new Map<number, number | null>();
    const name = new Map<number, string>();
    const general = new Set<number>();
    const walk = (nodes: GroupTreeNode[]) => {
      for (const n of nodes) {
        parent.set(n.id, n.parentId ?? null);
        name.set(n.id, n.name);
        if (n.isGeneral) general.add(n.id);
        walk(n.children);
      }
    };
    walk(tree);
    return { parent, name, general };
  }, [tree]);

  const chainOf = (groupId: number | null): number[] => {
    const chain: number[] = [];
    const seen = new Set<number>();
    let g = groupId;
    while (g !== null && g !== undefined && !seen.has(g)) {
      seen.add(g);
      chain.push(g);
      g = index.parent.get(g) ?? null;
    }
    return chain;
  };

  const grantsFor = (teams: EffectiveAccessTeam[], scope: 'group' | 'site', id: number, groupChain: number[]): Grant[] => {
    const out: Grant[] = [];
    // A disabled account's team grants are not effective.
    if (!access.isActive) return out;
    for (const team of teams) {
      for (const p of team.permissions) {
        if (scope === 'site' && p.scope === 'site' && p.scopeId === id) {
          out.push({ team: team.name, level: p.level, viaGroupId: null });
        } else if (p.scope === 'group' && groupChain.includes(p.scopeId)) {
          const direct = scope === 'group' && p.scopeId === id;
          out.push({ team: team.name, level: p.level, viaGroupId: direct ? null : p.scopeId });
        }
      }
    }
    return out;
  };

  const readableGroups = new Set(access.readable.groups);
  const writableGroups = new Set(access.writable.groups);
  const readableSites = new Set(access.readable.sites);
  const writableSites = new Set(access.writable.sites);

  const levelOf = (readable: boolean, writable: boolean, grants: Grant[]): Level | null => {
    if (writable || grants.some((g) => g.level === 'rw')) return 'rw';
    if (readable || grants.length > 0) return 'ro';
    return null;
  };

  const sitesByGroup = new Map<number | null, Site[]>();
  for (const s of sites) {
    const list = sitesByGroup.get(s.groupId) ?? [];
    list.push(s);
    sitesByGroup.set(s.groupId, list);
  }

  const originText = (grants: Grant[], fallback: string): string => {
    if (grants.length === 0) return fallback;
    return grants.map((g) => {
      const lvl = g.level === 'rw' ? t('users.teams.rwLabel', 'RW') : t('users.teams.roLabel', 'RO');
      if (g.viaGroupId === null) {
        return t('users.access.originTeam', 'Team {{team}} ({{level}})', { team: g.team, level: lvl });
      }
      return t('users.access.originTeamVia', 'Team {{team}} ({{level}}, via group {{group}})', {
        team: g.team,
        level: lvl,
        group: anonymize(index.name.get(g.viaGroupId) ?? `#${g.viaGroupId}`, 'hostname'),
      });
    }).join(' · ');
  };

  interface Row { kind: 'group' | 'site'; id: number; name: string; depth: number; level: Level | null; origin: string }
  const rows: Row[] = [];
  const seenGroups = new Set<number>();
  const seenSites = new Set<number>();

  const siteRows = (groupId: number | null, depth: number): Row[] => {
    const out: Row[] = [];
    for (const s of sitesByGroup.get(groupId) ?? []) {
      const grants = grantsFor(access.teams, 'site', s.id, chainOf(s.groupId));
      const level = levelOf(readableSites.has(s.id), writableSites.has(s.id), grants);
      if (!level) continue;
      seenSites.add(s.id);
      out.push({
        kind: 'site',
        id: s.id,
        name: s.name,
        depth,
        level,
        origin: originText(grants, t('users.access.originUnknown', 'Granted by the server')),
      });
    }
    return out;
  };

  const walkGroups = (nodes: GroupTreeNode[], depth: number): Row[] => {
    const out: Row[] = [];
    for (const n of nodes) {
      const grants = grantsFor(access.teams, 'group', n.id, chainOf(n.id));
      const own = siteRows(n.id, depth + 1);
      const children = walkGroups(n.children, depth + 1);
      const readable = readableGroups.has(n.id);
      const level = levelOf(readable, writableGroups.has(n.id), grants);
      if (!level && own.length === 0 && children.length === 0) continue;
      seenGroups.add(n.id);
      out.push({
        kind: 'group',
        id: n.id,
        name: n.name,
        depth,
        level,
        origin: grants.length > 0
          ? originText(grants, '')
          : n.isGeneral
            ? t('users.access.originGeneral', 'General group: visible to every member')
            : t('users.access.originPath', 'Path only (no permission on the group)'),
      });
      out.push(...own, ...children);
    }
    return out;
  };

  if (!fullAccess) {
    rows.push(...walkGroups(tree, 0));
    rows.push(...siteRows(null, 0));
  }
  const hiddenCount = fullAccess ? 0
    : access.readable.groups.filter((id) => !seenGroups.has(id)).length
      + access.readable.sites.filter((id) => !seenSites.has(id)).length;

  return (
    <div className="space-y-5">
      {/* Role */}
      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
          {t('users.access.role', 'Workspace role')}
        </h3>
        <div className="flex items-center gap-2 rounded-lg bg-bg-tertiary px-3 py-2">
          {fullAccess && <Shield size={14} className="shrink-0 text-accent" />}
          <span className="text-sm font-medium text-text-primary">{roleName}</span>
        </div>
        {access.isActive && access.platformAdmin && (
          <p className="mt-1.5 text-xs text-text-muted">
            {t('users.access.platformAdminHint', 'A platform administrator has every capability and full access in every workspace.')}
          </p>
        )}
        {!access.isActive && (
          <p className="mt-1.5 text-xs text-status-down">
            {t('users.access.inactive', 'Account disabled: no access at all until it is enabled again.')}
          </p>
        )}
        {access.isActive && !access.platformAdmin && role === 'admin' && (
          <p className="mt-1.5 text-xs text-text-muted">
            {t('users.access.workspaceAdminHint', 'A workspace admin has every capability and full access to every group and site of this workspace.')}
          </p>
        )}
      </section>

      {/* Capabilities */}
      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
          {t('users.access.capabilities', 'What the role allows')}
        </h3>
        {categories.length === 0 ? (
          <p className="text-sm text-text-muted">{t('users.access.noCapabilities', 'No capability: the user can only read what the teams grant.')}</p>
        ) : (
          <div className="space-y-2">
            {categories.map((cat) => (
              <div key={cat.key}>
                <div className="text-[11px] text-text-muted">{cat.label}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {cat.caps.map((cap) => (
                    <span key={cap} title={capDescription(cap)} className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                      {capName(cap)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Teams */}
      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
          {t('users.access.teams', 'Teams')}
        </h3>
        {access.teams.length === 0 ? (
          <p className="text-sm text-text-muted">{t('users.access.noTeams', 'Member of no team of this workspace.')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg bg-bg-tertiary">
            {access.teams.map((team) => (
              <li key={team.id} className="flex items-center gap-2 px-3 py-2">
                <Users size={13} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{team.name}</span>
                <span className="shrink-0 text-[11px] text-text-muted">
                  {t('users.access.grantCount', '{{count}} grants', { count: team.permissions.length })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Groups and sites */}
      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
          {t('users.access.scope', 'Groups and sites')}
        </h3>
        {fullAccess ? (
          <p className="text-sm text-text-muted">
            {t('users.access.scopeFull', 'Every group and site of the workspace, read and edit.')}
          </p>
        ) : rows.length === 0 && hiddenCount === 0 ? (
          <p className="text-sm text-text-muted">
            {t('users.access.scopeNone', 'No group or site: without a team permission a member reads no site.')}
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs text-text-muted">
              {t('users.access.scopeHint', 'Editing comes from team RW, whatever the role.')}
            </p>
            <div className="divide-y divide-border/50 rounded-lg bg-bg-tertiary py-1">
              {rows.map((row) => (
                <div
                  key={`${row.kind}-${row.id}`}
                  className="flex items-start gap-1.5 px-2 py-1.5"
                  style={{ paddingLeft: `${row.depth * 16 + 8}px` }}
                >
                  {row.kind === 'group'
                    ? <FolderOpen size={13} className="mt-0.5 shrink-0 text-text-muted" />
                    : <MapPin size={12} className="mt-0.5 shrink-0 text-text-muted" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-text-primary">{anonymize(row.name, 'hostname')}</div>
                    <div className="truncate text-[11px] text-text-muted" title={row.origin}>{row.origin}</div>
                  </div>
                  {row.level && (
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      row.level === 'rw' ? 'bg-accent/10 text-accent' : 'bg-bg-secondary text-text-muted'
                    }`}>
                      {row.level === 'rw'
                        ? <><Pencil size={9} className="mr-0.5 inline" />{t('users.teams.rwLabel', 'RW')}</>
                        : <><Eye size={9} className="mr-0.5 inline" />{t('users.teams.roLabel', 'RO')}</>}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {hiddenCount > 0 && (
              <p className="mt-2 text-xs text-text-muted">
                {t('users.access.hiddenCount', '{{count}} more groups or sites outside your own view.', { count: hiddenCount })}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
