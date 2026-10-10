import type { TFunction } from 'i18next';
import {
  Box, Camera, Cpu, GitBranch, Hash, HardDrive, HelpCircle, Laptop, Monitor, Network,
  Phone, Printer, Server, Shield, Smartphone, Wifi, type LucideIcon,
} from 'lucide-react';
import { DEVICE_TYPES, type DeviceType } from '@oblimap/shared';

/**
 * One client-side source for device types: the ordered list (the shared,
 * exhaustive DEVICE_TYPES), icons, badge colours and translated labels.
 */
export const DEVICE_TYPE_OPTIONS: readonly DeviceType[] = DEVICE_TYPES;

/** English labels, used as the t() fallback of `deviceTypes.<type>`. */
export const DEVICE_TYPE_FALLBACK_LABELS: Record<DeviceType, string> = {
  router: 'Router',
  switch: 'Switch',
  server: 'Server',
  printer: 'Printer',
  iot: 'IoT',
  camera: 'Camera',
  counter: 'Counter',
  workstation: 'Workstation',
  phone: 'Phone',
  gsm: 'GSM / Mobile',
  laptop: 'Laptop',
  vm: 'Virtual Machine',
  ap: 'Access Point',
  firewall: 'Firewall',
  nas: 'NAS',
  unknown: 'Unknown',
};

export const DEVICE_TYPE_ICONS: Record<DeviceType, LucideIcon> = {
  router: Network,
  switch: GitBranch,
  server: Server,
  printer: Printer,
  iot: Cpu,
  camera: Camera,
  counter: Hash,
  workstation: Monitor,
  phone: Phone,
  gsm: Smartphone,
  laptop: Laptop,
  vm: Box,
  ap: Wifi,
  firewall: Shield,
  nas: HardDrive,
  unknown: HelpCircle,
};

/** Borderless badge colours (text + tinted background) per device type. */
export const DEVICE_TYPE_COLORS: Record<DeviceType, string> = {
  router: 'text-blue-400 bg-blue-500/10',
  switch: 'text-sky-400 bg-sky-500/10',
  server: 'text-violet-400 bg-violet-500/10',
  printer: 'text-orange-400 bg-orange-500/10',
  iot: 'text-emerald-400 bg-emerald-500/10',
  camera: 'text-yellow-400 bg-yellow-500/10',
  counter: 'text-teal-400 bg-teal-500/10',
  workstation: 'text-indigo-400 bg-indigo-500/10',
  phone: 'text-pink-400 bg-pink-500/10',
  gsm: 'text-rose-400 bg-rose-500/10',
  laptop: 'text-blue-300 bg-blue-400/10',
  vm: 'text-purple-400 bg-purple-500/10',
  ap: 'text-cyan-400 bg-cyan-500/10',
  firewall: 'text-red-400 bg-red-500/10',
  nas: 'text-amber-400 bg-amber-500/10',
  unknown: 'text-zinc-400 bg-zinc-500/10',
};

function isDeviceType(type: string): type is DeviceType {
  return Object.prototype.hasOwnProperty.call(DEVICE_TYPE_FALLBACK_LABELS, type);
}

/** Translated label of a device type (`deviceTypes.<type>`); unknown values are shown as-is. */
export function deviceTypeLabel(t: TFunction, type: string): string {
  return t(`deviceTypes.${type}`, isDeviceType(type) ? DEVICE_TYPE_FALLBACK_LABELS[type] : type);
}

/** Icon of a device type (HelpCircle for unknown values). */
export function deviceTypeIcon(type: string): LucideIcon {
  return isDeviceType(type) ? DEVICE_TYPE_ICONS[type] : HelpCircle;
}

/** Badge colour classes of a device type ('unknown' colours for unknown values). */
export function deviceTypeColor(type: string): string {
  return isDeviceType(type) ? DEVICE_TYPE_COLORS[type] : DEVICE_TYPE_COLORS.unknown;
}
