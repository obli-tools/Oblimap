import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SOCKET_EVENTS } from '@oblimap/shared';
import { getSocket } from '@/socket/socketClient';
import { useGroupStore } from '@/store/groupStore';
import { GroupNode } from './GroupNode';

interface GroupTreeProps {
  selectedGroupId?: number | null;
  onSelectGroup?: (groupId: number | null) => void;
  searchQuery?: string;
}

export function GroupTree({ selectedGroupId, onSelectGroup, searchQuery = '' }: GroupTreeProps) {
  const { t } = useTranslation();
  const { tree, treeError, fetchTree, fetchGroupStats, expandAncestors } = useGroupStore();
  const location = useLocation();

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchTree();
    fetchGroupStats();
    const interval = setInterval(() => {
      fetchGroupStats();
    }, 60000);
    return () => clearInterval(interval);
  }, [fetchTree, fetchGroupStats]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const scheduleRefresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        fetchTree();
        fetchGroupStats();
      }, 1500);
    };

    // Groups / sites added, moved, renamed or deleted (payload-free, every
    // member): useSocket refetches the tree on TREE_CHANGED (the server sends
    // it after SITE_DELETED too), only the stats are refreshed here.
    const scheduleStatsRefresh = () => {
      if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
      statsTimerRef.current = setTimeout(() => {
        fetchGroupStats();
      }, 1500);
    };

    socket.on(SOCKET_EVENTS.SITE_UPDATED, scheduleRefresh);
    socket.on(SOCKET_EVENTS.ITEM_STATUS_CHANGED, scheduleRefresh);
    socket.on(SOCKET_EVENTS.NEW_DEVICE_DISCOVERED, scheduleRefresh);
    socket.on(SOCKET_EVENTS.TREE_CHANGED, scheduleStatsRefresh);
    socket.on(SOCKET_EVENTS.SITE_DELETED, scheduleStatsRefresh);

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
      socket.off(SOCKET_EVENTS.SITE_UPDATED, scheduleRefresh);
      socket.off(SOCKET_EVENTS.ITEM_STATUS_CHANGED, scheduleRefresh);
      socket.off(SOCKET_EVENTS.NEW_DEVICE_DISCOVERED, scheduleRefresh);
      socket.off(SOCKET_EVENTS.TREE_CHANGED, scheduleStatsRefresh);
      socket.off(SOCKET_EVENTS.SITE_DELETED, scheduleStatsRefresh);
    };
  }, [fetchTree, fetchGroupStats]);

  // Auto-expand ancestors when navigating to a group detail page
  useEffect(() => {
    const match = location.pathname.match(/^\/group\/(\d+)$/);
    if (match) {
      const groupId = Number(match[1]);
      expandAncestors(groupId);
    }
  }, [location.pathname, expandAncestors]);

  const visibleTree = searchQuery
    ? tree.filter(n => {
        const q = searchQuery.toLowerCase();
        const hasMatch = (node: typeof n): boolean => {
          if (node.name.toLowerCase().includes(q)) return true;
          if (node.sites?.some(s => s.name.toLowerCase().includes(q))) return true;
          return node.children.some(hasMatch);
        };
        return hasMatch(n);
      })
    : tree;

  if (treeError && tree.length === 0) {
    return (
      <div className="py-2 px-2 flex items-center gap-1.5 text-[11px] text-text-muted">
        <span className="truncate">{t('groups.treeLoadFailed', 'Groups unavailable')}</span>
        <button type="button" onClick={() => { void fetchTree(); }} className="shrink-0 text-accent hover:underline">
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  if (visibleTree.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-text-muted">
        {searchQuery ? t('groups.noMatching', 'No matching groups') : t('groups.noGroups', 'No groups yet')}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {visibleTree.map((node) => (
        <GroupNode
          key={node.id}
          node={node}
          selectedGroupId={selectedGroupId}
          onSelectGroup={onSelectGroup}
          searchQuery={searchQuery}
        />
      ))}
    </div>
  );
}
