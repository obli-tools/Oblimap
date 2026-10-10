import type { NotificationPlugin, NotificationPayload } from '../types';
import { statusIcon } from '../statusIcons';
import { escapeTelegramHtml, neutralizeMentions } from '../../utils/html';

/** Text for a parse_mode "HTML" message: mass mentions defused, then entity-escaped. */
function tg(value: unknown): string {
  return escapeTelegramHtml(neutralizeMentions(value));
}

export const telegramPlugin: NotificationPlugin = {
  type: 'telegram',
  name: 'Telegram',
  description: 'Send to a Telegram chat via bot',
  configFields: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: '123456:ABC-DEF...' },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true, placeholder: '-1001234567890' },
  ],

  async send(config, payload) {
    // The token becomes part of the API path: accept only the bot token shape.
    const botToken = String(config.botToken ?? '').trim();
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error('Invalid Telegram bot token format');

    // parse_mode HTML: every interpolated value is escaped (a '<' or '&' in a
    // device or site name would otherwise make Telegram reject the message).
    const icon = statusIcon(payload.newStatus);
    const text = [
      `${tg(icon)} <b>${tg(payload.monitorName)}</b>`,
      `Status: <b>${tg(payload.oldStatus.toUpperCase())}</b> → <b>${tg(payload.newStatus.toUpperCase())}</b>`,
      payload.message ? `\n${tg(payload.message)}` : '',
      payload.monitorUrl ? `\n🔗 ${escapeTelegramHtml(payload.monitorUrl)}` : '',
    ].filter(Boolean).join('\n');

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Telegram returned ${res.status}: ${await res.text()}`);
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
