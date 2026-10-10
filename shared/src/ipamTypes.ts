// IPAM-specific enums and constants

import type { DeviceType } from './types';

export type UserRole = 'admin' | 'user';

/** Every DeviceType value, in display order (selects, filters, validators). */
export const DEVICE_TYPES = [
  'router', 'switch', 'server', 'printer', 'iot', 'camera', 'counter', 'workstation',
  'phone', 'gsm', 'laptop', 'vm', 'ap', 'firewall', 'nas', 'unknown',
] as const satisfies readonly DeviceType[];

// Compile-time guard: a DeviceType added to the union must be added above.
type MissingDeviceType = Exclude<DeviceType, (typeof DEVICE_TYPES)[number]>;
const allDeviceTypesListed: [MissingDeviceType] extends [never] ? true : never = true;
void allDeviceTypesListed;

export const DEVICE_TYPE_LABELS: Record<string, string> = {
  router: 'Router',
  switch: 'Switch',
  server: 'Server',
  printer: 'Printer',
  iot: 'IoT Device',
  camera: 'IP Camera',
  counter: 'People Counter',
  workstation: 'Workstation',
  phone: 'VoIP Phone',
  gsm: 'GSM / Mobile',
  laptop: 'Laptop',
  vm: 'Virtual Machine',
  ap: 'Access Point',
  firewall: 'Firewall',
  nas: 'NAS / Storage',
  unknown: 'Unknown',
};

export const DEVICE_TYPE_ICONS: Record<string, string> = {
  router: 'router',
  switch: 'network',
  server: 'server',
  printer: 'printer',
  iot: 'cpu',
  camera: 'camera',
  counter: 'users',
  workstation: 'monitor',
  phone: 'phone',
  gsm: 'smartphone',
  laptop: 'laptop',
  vm: 'box',
  ap: 'wifi',
  firewall: 'shield',
  nas: 'hard-drive',
  unknown: 'help-circle',
};
