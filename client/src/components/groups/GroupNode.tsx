import { useState, type DragEvent } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { ChevronRight, Folder, FolderOpen, MapPin } from 'lucide-react';
import type { GroupTreeNode } from '@oblimap/shared';
import { cn } from '@/utils/cn';
import { useGroupStore } from '@/store/groupStore';
import { useAnonymize } from '@/utils/anonymize';
import {
  hasSiteDragData, readSiteDragData, setSiteDragData, useGroupSiteActions,
} from '@/components/devices/GroupSitePanel';

interface GroupNodeProps {
  node: GroupTreeNode;
  depth?: number;
  selectedGroupId?: number | null;
  onSelectGroup?: (groupId: number | null) => void;
  searchQuery?: string;
}

export function GroupNode({ node, depth = 0, selectedGroupId, onSelectGroup, searchQuery = '' }: GroupNodeProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { getGroupStats, isGroupExpanded, toggleGroupExpanded } = useGroupStore();
  const { anonymize } = useAnonymize();
  const expanded = isGroupExpanded(node.id);

  const isSearching = searchQuery.length > 0;

  const hasMatchingInSubtree = (n: GroupTreeNode): boolean => {
    if (n.name.toLowerCase().includes(searchQuery.toLowerCase())) return true;
    if (n.sites?.some(s => s.name.toLowerCase().includes(searchQuery.toLowerCase()))) return true;
    return n.children.some(hasMatchingInSubtree);
  };

  const visibleChildren = isSearching
    ? node.children.filter(hasMatchingInSubtree)
    : node.children;

  const effectiveExpanded = isSearching ? true : expanded;

  const hasContent = node.children.length > 0 || (node.sites && node.sites.length > 0);
  const isSelected = selectedGroupId === node.id;
  const stats = getGroupStats(node.id);

  // A site dragged from the tree (or the group panel) can be dropped on this
  // group: write on the site (checked when the drag starts) and on this group,
  // after a confirmation (the server's PATCH /sites/:id rules).
  const { canMoveSite, canDropSiteOn, moveSite } = useGroupSiteActions();
  const [isOver, setIsOver] = useState(false);
  const acceptsSite = canDropSiteOn(node.id);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!acceptsSite || !hasSiteDragData(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!isOver) setIsOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setIsOver(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasSiteDragData(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);
    const site = readSiteDragData(e);
    if (site && site.groupId !== node.id) void moveSite(site, node.id);
  };

  return (
    <div className="rounded-md">
      {(() => {
        const isActive = location.pathname === `/group/${node.id}`;
        return (
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md text-sm transition-colors',
              isOver && 'ring-1 ring-accent/50',
              isActive
                ? 'bg-bg-active text-text-primary'
                : isSelected
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {/* Left zone: chevron + folder icon — toggles expand/collapse */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (hasContent) toggleGroupExpanded(node.id);
                onSelectGroup?.(isSelected ? null : node.id);
              }}
              className="flex items-center gap-1 shrink-0 py-1.5 pr-0.5"
            >
              {hasContent ? (
                <ChevronRight
                  size={14}
                  className={cn('shrink-0 transition-transform', effectiveExpanded && 'rotate-90')}
                />
              ) : (
                <span className="w-3.5 shrink-0" />
              )}

              {effectiveExpanded && hasContent ? (
                <FolderOpen size={14} className="shrink-0 text-accent" />
              ) : (
                <Folder size={14} className="shrink-0 text-accent" />
              )}
            </button>

            {/* Right zone: name + badges — navigates to group detail page */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/group/${node.id}`);
              }}
              className="flex items-center gap-1.5 flex-1 min-w-0 py-1.5 pr-2"
            >
              <span className="truncate flex-1 text-left">{anonymize(node.name, 'hostname')}</span>

              {stats && stats.total > 0 && (
                <span
                  className={cn(
                    'shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                    stats.uptimePct >= 99
                      ? 'bg-status-up-bg text-status-up'
                      : stats.uptimePct >= 95
                        ? 'bg-yellow-500/10 text-yellow-500'
                        : 'bg-status-down-bg text-status-down',
                  )}
                >
                  {stats.uptimePct}%
                </span>
              )}
            </button>
          </div>
        );
      })()}

      {/* Sites + Children */}
      {effectiveExpanded && (
        <div>
          {node.sites && node.sites.length > 0 && (() => {
            const q = searchQuery.toLowerCase();
            const filteredSites = isSearching
              ? node.sites.filter(s => s.name.toLowerCase().includes(q))
              : node.sites;
            return filteredSites.map((site) => {
              const isActive = location.pathname === `/sites/${site.id}`;
              const total = site.itemCount;
              const online = site.onlineCount;
              const draggable = canMoveSite(site.id, node.id);
              return (
                <Link
                  key={`site-${site.id}`}
                  to={`/sites/${site.id}`}
                  {...(draggable ? {
                    draggable: true,
                    onDragStart: (e: DragEvent<HTMLAnchorElement>) => {
                      setSiteDragData(e, { id: site.id, name: site.name, groupId: node.id });
                    },
                  } : {})}
                  className={cn(
                    'flex items-center gap-2 rounded-md py-1.5 text-sm transition-colors',
                    isActive
                      ? 'bg-bg-active text-text-primary'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                  )}
                  style={{ paddingLeft: `${(depth + 1) * 16 + 8}px`, paddingRight: '8px' }}
                >
                  <MapPin size={13} className="shrink-0 text-accent" />
                  <span className="truncate flex-1">{anonymize(site.name, 'hostname')}</span>
                  {total > 0 && (
                    <span
                      className={cn(
                        'shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                        online === total
                          ? 'bg-status-up-bg text-status-up'
                          : online > total * 0.5
                            ? 'bg-yellow-500/10 text-yellow-500'
                            : 'bg-status-down-bg text-status-down',
                      )}
                    >
                      {online}/{total}
                    </span>
                  )}
                </Link>
              );
            });
          })()}
          {visibleChildren.map((child) => (
            <GroupNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedGroupId={selectedGroupId}
              onSelectGroup={onSelectGroup}
              searchQuery={searchQuery}
            />
          ))}
        </div>
      )}
    </div>
  );
}
