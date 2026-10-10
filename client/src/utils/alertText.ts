import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { LiveAlertData, LiveAlertParams } from '@oblimap/shared';
import { anonymize as defaultAnonymize, useAnonymize } from './anonymize';
import { deviceTypeLabel } from './deviceTypes';

/**
 * Client-side text of a live alert (bell panel, toasts).
 *
 * Alerts written since migration 052 carry a machine `kind` and `params`
 * (LIVE_ALERT_KINDS): their title / message are rendered from
 * liveAlerts.kinds.<kind>.title / .message — translated — with every IP,
 * MAC and name anonymized in anonymous mode. The stored English title /
 * message stay the source for older rows, alerts without a kind (custom
 * device-check templates, uninstall warnings…) and kinds this client does
 * not know: in anonymous mode their IPv4 and MAC addresses are masked.
 */

export type AnonymizeFn = typeof defaultAnonymize;

export interface AlertText {
  title: string;
  message: string;
}

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const MAC_RE = /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g;
const IPV4_ONLY_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Masks the IPv4 and MAC addresses found in free text. `anonymizeFn`
 * returns its input unchanged outside anonymous mode, so this is a no-op
 * then.
 */
export function maskAddressesInText(text: string, anonymizeFn: AnonymizeFn = defaultAnonymize): string {
  if (!text) return text;
  return text
    .replace(IPV4_RE, (ip) => anonymizeFn(ip, 'ip'))
    .replace(MAC_RE, (mac) => anonymizeFn(mac.replace(/-/g, ':'), 'mac'));
}

/** How each param is anonymized (keys of LiveAlertParams by kind). */
const IP_PARAMS = new Set(['ip', 'oldIp', 'newIp']);
const MAC_PARAMS = new Set(['mac', 'oldMac', 'newMac']);
const NAME_PARAMS = new Set(['name', 'oldName', 'deviceName', 'hostname', 'siteName']);
/** Free text that may hold raw addresses (device_check_open). */
const FREE_TEXT_PARAMS = new Set(['detail']);

function anonymizeParam(key: string, value: string, anonymizeFn: AnonymizeFn): string {
  if (IP_PARAMS.has(key)) return anonymizeFn(value, 'ip');
  if (MAC_PARAMS.has(key)) return anonymizeFn(value, 'mac');
  // A device without a name is labelled by its IP.
  if (NAME_PARAMS.has(key)) return anonymizeFn(value, IPV4_ONLY_RE.test(value) ? 'ip' : 'hostname');
  if (FREE_TEXT_PARAMS.has(key)) return maskAddressesInText(value, anonymizeFn);
  return value;
}

/**
 * English fallbacks of liveAlerts.kinds.<kind>.title / .message (the server's
 * wording) and the params each needs: an alert missing one of them is shown
 * from its stored text instead.
 */
const KIND_TEXTS: Record<string, { title: string; message: string; required: string[] }> = {
  device_offline: {
    title: 'Device offline: {{name}}',
    message: 'Device "{{name}}" ({{ip}}) on site "{{siteName}}" has gone offline.',
    required: ['name', 'ip', 'siteName'],
  },
  device_online: {
    title: 'Device back online: {{name}}',
    message: 'Device "{{name}}" ({{ip}}) on site "{{siteName}}" is back online.',
    required: ['name', 'ip', 'siteName'],
  },
  ip_takeover: {
    title: 'IP takeover: {{ip}}',
    message: '{{ip}} was used by "{{oldName}}" ({{oldMac}}) and is now claimed by a new device ({{newMac}}).',
    required: ['ip', 'oldName', 'oldMac', 'newMac'],
  },
  ip_instability: {
    title: 'IP instability: {{ip}}',
    message: '{{macCount}} different MAC addresses claimed {{ip}} across the last scans.',
    required: ['ip', 'macCount'],
  },
  probe_offline: {
    title: 'Probe offline: {{name}}',
    message: 'Probe "{{name}}" has not contacted the server for {{minutes}} min. Devices of its subnets are no longer scanned.',
    required: ['name', 'minutes'],
  },
  channel_target_blocked: {
    title: 'Notification channel blocked: {{channelName}}',
    message: 'Notification channel "{{channelName}}" points to a local network address, which the server refuses (SSRF protection): its notifications are not delivered. If this target is intended, the server administrator must add its host to SSRF_ALLOWLIST and restart the server.',
    required: ['channelName'],
  },
  device_check_open: {
    title: '{{ruleName}}: {{deviceName}} ({{siteName}})',
    message: 'The check of {{deviceName}} ({{ip}}) is failing.',
    required: ['ruleName', 'deviceName', 'siteName'],
  },
  device_check_recovered: {
    title: 'Recovered: {{ruleName}}: {{deviceName}} ({{siteName}})',
    message: '{{deviceName}} ({{ip}}): the check passes again.',
    required: ['ruleName', 'deviceName', 'ip', 'siteName'],
  },
};

/** The alert's params as display strings (anonymized), or null when unusable. */
function displayParams(params: LiveAlertParams | null | undefined, anonymizeFn: AnonymizeFn): Record<string, string> | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(params)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    out[key] = anonymizeParam(key, String(raw), anonymizeFn);
  }
  return out;
}

/** The stored (English) text, addresses masked in anonymous mode. */
function legacyText(alert: Pick<LiveAlertData, 'title' | 'message'>, anonymizeFn: AnonymizeFn): AlertText {
  return {
    title: maskAddressesInText(alert.title ?? '', anonymizeFn),
    message: maskAddressesInText(alert.message ?? '', anonymizeFn),
  };
}

/** The server's English fallback detail of device_check_open (ingest.service.ts). */
const DEVICE_CHECK_GENERIC_DETAIL = 'The device check is failing.';

/**
 * Title and message of a live alert as the user should see them: translated
 * from its kind and params when it has them, else its stored text — in both
 * cases anonymized in anonymous mode (`anonymizeFn` is a no-op otherwise).
 */
export function renderAlert(
  alert: Pick<LiveAlertData, 'title' | 'message' | 'kind' | 'params'>,
  t: TFunction,
  anonymizeFn: AnonymizeFn = defaultAnonymize,
): AlertText {
  const kind = typeof alert.kind === 'string' ? alert.kind : null;
  // Own keys only: a kind such as 'constructor' must not reach Object.prototype.
  const texts = kind && Object.prototype.hasOwnProperty.call(KIND_TEXTS, kind) ? KIND_TEXTS[kind] : undefined;
  const params = texts ? displayParams(alert.params, anonymizeFn) : null;
  if (!kind || !texts || !params || texts.required.some((key) => !(key in params))) {
    return legacyText(alert, anonymizeFn);
  }

  let title = t(`liveAlerts.kinds.${kind}.title`, { ...params, defaultValue: texts.title });
  if (kind === 'device_offline' || kind === 'device_online') {
    // Type / vendor of the device when the server knew them (alerts since
    // they were added; never 'unknown').
    const what = [
      params.deviceType ? deviceTypeLabel(t, params.deviceType) : '',
      params.vendor ?? '',
    ].filter(Boolean).join(' · ');
    if (what) title = `${title} (${what})`;
  }

  let message: string;
  if (kind === 'device_check_open') {
    // The translated message, followed by the failing assertion / error text
    // (free text, already masked) when the server gave a specific one. Without
    // a detail, the stored message is a custom template (the rule author's
    // text), shown as is.
    const translated = t(`liveAlerts.kinds.${kind}.message`, { ...params, ip: params.ip ?? '—', defaultValue: texts.message });
    const detail = typeof params.detail === 'string' ? params.detail.trim() : '';
    if (detail && detail !== DEVICE_CHECK_GENERIC_DETAIL) {
      message = `${translated} ${detail}`;
    } else if (detail) {
      message = translated;
    } else {
      message = maskAddressesInText(alert.message ?? '', anonymizeFn) || translated;
    }
  } else {
    message = t(`liveAlerts.kinds.${kind}.message`, { ...params, defaultValue: texts.message });
  }
  return { title, message };
}

/**
 * Hook form of renderAlert: re-renders when the language or anonymous mode
 * changes.
 */
export function useAlertText(): (alert: Pick<LiveAlertData, 'title' | 'message' | 'kind' | 'params'>) => AlertText {
  const { t } = useTranslation();
  const { anonymize, isAnonymous } = useAnonymize();
  return useCallback(
    (alert) => renderAlert(alert, t, anonymize),
    // isAnonymous: anonymize reads the store, the callback must change with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, anonymize, isAnonymous],
  );
}
