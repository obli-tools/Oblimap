import type { NotificationConfigField } from '@oblimap/shared';

export interface NotificationPayload {
  monitorName: string;
  monitorUrl?: string;
  oldStatus: string;
  newStatus: string;
  message?: string;
  timestamp: string;
  appName?: string;
  // Group notification fields
  groupName?: string;
  groupId?: number;
  downMonitors?: string[];
  isGroupNotification?: boolean;
  // IPAM notification fields
  isIpamNotification?: boolean;
  siteName?: string;
  siteId?: number;
  deviceIp?: string;
  deviceMac?: string | null;
  deviceName?: string | null;
  // Device Checks fields (services/deviceChecks): set on check alerts only
  eventType?: 'device_check';
  ruleName?: string;
  /** Latest values of the check, non-sensitive fields only, as short plain strings. */
  checkValues?: Record<string, string>;
}

export interface NotificationPlugin {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];

  send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void>;
  sendTest(config: Record<string, unknown>): Promise<void>;
}
