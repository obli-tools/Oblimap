import type { NotificationPlugin, NotificationPayload } from '../types';
import nodemailer from 'nodemailer';
import { statusIcon } from '../statusIcons';
import { escapeHtml, safeHref } from '../../utils/html';

export const smtpPlugin: NotificationPlugin = {
  type: 'smtp',
  name: 'Email (SMTP)',
  description: 'Send email notifications via a global SMTP server',
  configFields: [
    { key: 'smtpServerId', label: 'SMTP Server', type: 'smtp_server_select', required: true },
    { key: 'fromOverride', label: 'From Address Override', type: 'text', required: false, placeholder: 'Leave blank to use server default' },
    { key: 'to', label: 'To Address(es)', type: 'text', required: true, placeholder: 'admin@example.com' },
  ],

  // config here is the RESOLVED config (host/port/etc injected by resolveChannelConfig)
  async send(config, payload) {
    const icon = statusIcon(payload.newStatus);
    const transport = nodemailer.createTransport({
      host: String(config.host),
      port: Number(config.port),
      secure: Boolean(config.secure),
      auth: {
        user: String(config.username),
        pass: String(config.password),
      },
    });

    // Device names, hostnames, vendors, site names and messages come from
    // probes and admins: every value is HTML-escaped in the HTML part, and
    // the link only keeps an absolute http(s) URL (safeHref output is
    // already escaped).
    const siteName = payload.isIpamNotification && payload.siteName ? payload.siteName : '';

    await transport.sendMail({
      from: String(config.from),
      to: String(config.to),
      subject: `${icon} ${payload.monitorName} is ${payload.newStatus.toUpperCase()}`.replace(/[\r\n]+/g, ' '),
      text: [
        `Monitor: ${payload.monitorName}`,
        siteName ? `Site: ${siteName}` : '',
        `Status: ${payload.oldStatus} → ${payload.newStatus}`,
        payload.message ? `Message: ${payload.message}` : '',
        payload.monitorUrl ? `URL: ${payload.monitorUrl}` : '',
        `Time: ${payload.timestamp}`,
      ].filter(Boolean).join('\n'),
      html: [
        `<h2>${escapeHtml(icon)} ${escapeHtml(payload.monitorName)}</h2>`,
        siteName ? `<p><strong>Site:</strong> ${escapeHtml(siteName)}</p>` : '',
        `<p><strong>Status:</strong> ${escapeHtml(payload.oldStatus)} → <strong>${escapeHtml(payload.newStatus.toUpperCase())}</strong></p>`,
        payload.message ? `<p>${escapeHtml(payload.message)}</p>` : '',
        payload.monitorUrl ? `<p><a href="${safeHref(payload.monitorUrl)}">${escapeHtml(payload.monitorUrl)}</a></p>` : '',
        `<p><small>${escapeHtml(payload.timestamp)}</small></p>`,
      ].filter(Boolean).join('\n'),
    });
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
