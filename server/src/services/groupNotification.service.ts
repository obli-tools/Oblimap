import { groupService } from './group.service';

/**
 * Tracks which monitors are down in groups with groupNotifications enabled.
 * Used to consolidate notifications: one "group down" when the first monitor
 * goes down, and one "group recovered" when all monitors are back up.
 */

interface GroupNotifState {
  downMonitorIds: Set<number>;
  downMonitorNames: Map<number, string>; // id → name for messages
  notifiedDown: boolean; // true once the "group is down" notification has been sent
}

const groupStates = new Map<number, GroupNotifState>();

function getOrCreateState(groupId: number): GroupNotifState {
  let state = groupStates.get(groupId);
  if (!state) {
    state = {
      downMonitorIds: new Set(),
      downMonitorNames: new Map(),
      notifiedDown: false,
    };
    groupStates.set(groupId, state);
  }
  return state;
}

export const groupNotificationService = {
  // (The Obliview start-up initialize(), which rebuilt this state from the
  // `monitors` table, is gone: Oblimap has no monitors and never called it.)

  /**
   * Check if a monitor is covered by a group with groupNotifications enabled.
   * Returns the groupNotification ancestor group ID, or null if not covered.
   */
  async shouldSuppressIndividual(
    _monitorId: number,
    groupId: number | null,
  ): Promise<number | null> {
    if (groupId === null) return null;

    const ancestor = await groupService.findGroupNotificationAncestor(groupId);
    return ancestor ? ancestor.id : null;
  },

  /**
   * Record a monitor going DOWN in a grouped-notification group.
   * Returns 'first_down' if this is the first monitor to go down (send notification),
   * or 'already_down' if other monitors were already down (suppress notification).
   */
  handleMonitorDown(
    monitorId: number,
    monitorName: string,
    groupNotifGroupId: number,
  ): 'first_down' | 'already_down' {
    const state = getOrCreateState(groupNotifGroupId);
    state.downMonitorIds.add(monitorId);
    state.downMonitorNames.set(monitorId, monitorName);

    if (!state.notifiedDown) {
      state.notifiedDown = true;
      return 'first_down';
    }
    return 'already_down';
  },

  /**
   * Record a monitor going UP in a grouped-notification group.
   * Returns 'all_recovered' if all monitors are now up (send recovery notification),
   * or 'still_down' if some monitors are still down (suppress notification).
   */
  handleMonitorUp(
    monitorId: number,
    groupNotifGroupId: number,
  ): 'all_recovered' | 'still_down' {
    const state = groupStates.get(groupNotifGroupId);
    if (!state) return 'still_down';

    state.downMonitorIds.delete(monitorId);
    state.downMonitorNames.delete(monitorId);

    if (state.downMonitorIds.size === 0 && state.notifiedDown) {
      state.notifiedDown = false;
      return 'all_recovered';
    }
    return 'still_down';
  },

  /**
   * Get the names of monitors currently down in a group.
   */
  getDownMonitorNames(groupNotifGroupId: number): string[] {
    const state = groupStates.get(groupNotifGroupId);
    if (!state) return [];
    return Array.from(state.downMonitorNames.values());
  },

  /**
   * Remove a monitor from all group states.
   * Called when a monitor is deleted or moved to a different group.
   */
  removeMonitor(monitorId: number): void {
    for (const [, state] of groupStates) {
      state.downMonitorIds.delete(monitorId);
      state.downMonitorNames.delete(monitorId);
    }
  },

  /**
   * Remove a group's state entirely.
   * Called when a group is deleted or its groupNotifications flag is toggled.
   */
  removeGroup(groupId: number): void {
    groupStates.delete(groupId);
  },
};
