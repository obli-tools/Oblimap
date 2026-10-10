import type { NotificationPlugin, NotificationPayload } from '../types';
import { statusIcon, STATUS_COLORS_HEX } from '../statusIcons';
import { neutralizeMentions } from '../../utils/html';
import { fetchNotificationTarget } from './webhook';

export const discordPlugin: NotificationPlugin = {
  type: 'discord',
  name: 'Discord',
  description: 'Send to a Discord channel via webhook',
  configFields: [
    { key: 'webhookUrl', label: 'Discord Webhook URL', type: 'url', required: true, placeholder: 'https://discord.com/api/webhooks/...' },
    { key: 'username', label: 'Bot Username (optional)', type: 'text', placeholder: 'Oblimap' },
  ],

  async send(config, payload) {
    // Device / site names and messages come from probes and admins: mass
    // mentions are defused in the text, and allowed_mentions forbids pings.
    const monitorName = neutralizeMentions(payload.monitorName);
    const embed = {
      title: `${statusIcon(payload.newStatus)} ${monitorName}`,
      description: payload.message
        ? neutralizeMentions(payload.message)
        : `Status changed: **${neutralizeMentions(payload.oldStatus)}** → **${neutralizeMentions(payload.newStatus)}**`,
      color: STATUS_COLORS_HEX[payload.newStatus] ?? 0x95a5a6,
      fields: [
        { name: 'Status', value: neutralizeMentions(payload.newStatus.toUpperCase()), inline: true },
        ...(payload.monitorUrl ? [{ name: 'URL', value: payload.monitorUrl, inline: true }] : []),
      ],
      timestamp: payload.timestamp,
    };

    const body: Record<string, unknown> = { embeds: [embed], allowed_mentions: { parse: [] } };
    if (config.username) body.username = config.username;

    const res = await fetchNotificationTarget(String(config.webhookUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Discord returned ${res.status}: ${await res.text()}`);
  },

  async sendTest(config) {
    await this.send(config, {
      monitorName: 'Test Monitor',
      oldStatus: 'up',
      newStatus: 'down',
      message: 'This is a test notification from Oblimap',
      timestamp: new Date().toISOString(),
    });
  },
};
