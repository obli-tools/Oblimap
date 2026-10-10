import type { NotificationPlugin, NotificationPayload } from '../types';
import { statusIcon } from '../statusIcons';
import { fetchNotificationTarget } from './webhook';

export const gotifyPlugin: NotificationPlugin = {
  type: 'gotify',
  name: 'Gotify',
  description: 'Send via Gotify push notification server',
  configFields: [
    { key: 'serverUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'https://gotify.example.com' },
    { key: 'appToken', label: 'Application Token', type: 'password', required: true },
    { key: 'priority', label: 'Priority (0-10)', type: 'number', placeholder: '5' },
  ],

  async send(config, payload) {
    const icon = statusIcon(payload.newStatus);
    const prefix = payload.appName || 'Oblimap';
    const url = `${String(config.serverUrl).replace(/\/$/, '')}/message`;

    // The token goes in the X-Gotify-Key header, not the query string (which
    // ends up in proxy and server access logs). A server on the LAN must be
    // listed in SSRF_ALLOWLIST.
    const res = await fetchNotificationTarget(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gotify-Key': String(config.appToken ?? ''),
      },
      body: JSON.stringify({
        title: `[${prefix}] ${icon} ${payload.monitorName}`,
        message: `${payload.oldStatus} → ${payload.newStatus}${payload.message ? `\n${payload.message}` : ''}`,
        priority: Number(config.priority) || 5,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Gotify returned ${res.status}`);
  },

  async sendTest(config) {
    await this.send(config, {
      monitorName: 'Test Monitor',
      oldStatus: 'up',
      newStatus: 'down',
      message: 'Test from Oblimap',
      timestamp: new Date().toISOString(),
    });
  },
};
