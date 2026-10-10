/**
 * Shared status icon/color helpers used across notification plugins.
 */

/** Emoji icon for each device/probe status */
export function statusIcon(status: string): string {
  switch (status) {
    case 'online':        return '✅';
    case 'offline':       return '🔴';
    case 'alert':         return '🟠';
    case 'new_device':    return '🆕';
    case 'ip_changed':    return '🔄';
    case 'conflict':      return '⚠️';
    case 'probe_down':    return '🔴';
    case 'probe_up':      return '✅';
    case 'pending':       return '🔵';
    case 'inactive':      return '⚫';
    default:              return '❓';
  }
}

/** Hex colour for Discord embeds */
export const STATUS_COLORS_HEX: Record<string, number> = {
  online:       0x2ecc71,
  offline:      0xe74c3c,
  alert:        0xe67e22,
  new_device:   0x3498db,
  ip_changed:   0x3498db,
  conflict:     0xf39c12,
  probe_down:   0xe74c3c,
  probe_up:     0x2ecc71,
  pending:      0xf39c12,
  inactive:     0x95a5a6,
};

/** CSS hex colour string for Slack attachments */
export const STATUS_COLORS_CSS: Record<string, string> = {
  online:       '#2ecc71',
  offline:      '#e74c3c',
  alert:        '#e67e22',
  new_device:   '#3498db',
  ip_changed:   '#3498db',
  conflict:     '#f39c12',
  probe_down:   '#e74c3c',
  probe_up:     '#2ecc71',
  pending:      '#f39c12',
  inactive:     '#95a5a6',
};
