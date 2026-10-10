import type { NotificationPlugin, NotificationPayload } from '../types';
import { assertPublicHttpUrl } from '../../utils/ssrfGuard';

const MAX_REDIRECTS = 3;
const UPGRADE_REDIRECTS = new Set([301, 302, 303]);

/**
 * fetch() for a user-configured notification target (webhook, Slack,
 * Discord, Teams, Gotify, ntfy). The URL — and the target of every redirect —
 * must pass the SSRF guard: no loopback / private / link-local / metadata
 * address unless listed in SSRF_ALLOWLIST (internal Gotify / ntfy servers).
 * Followed, at most 3 hops: method-preserving redirects (307 / 308), and a
 * 301 / 302 / 303 only when it upgrades http to https on the same host (sent
 * again with the same method and body: a GET would drop the notification).
 * Any other 3xx is returned as-is (and reported as a failed delivery).
 * A refused target throws TargetNotAllowedError (reason for the server log).
 */
export async function fetchNotificationTarget(rawUrl: string, init: RequestInit): Promise<Response> {
  let url = await assertPublicHttpUrl(rawUrl, { allowPrivate: false });
  for (let hop = 0; ; hop++) {
    const res = await fetch(url.toString(), { ...init, redirect: 'manual' });
    const preserving = res.status === 307 || res.status === 308;
    if (!preserving && !UPGRADE_REDIRECTS.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location || hop >= MAX_REDIRECTS) return res;
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return res;
    }
    if (!preserving && !(url.protocol === 'http:' && next.protocol === 'https:' && next.hostname === url.hostname)) {
      return res;
    }
    await res.body?.cancel().catch(() => undefined);
    url = await assertPublicHttpUrl(next.toString(), { allowPrivate: false });
  }
}

export const webhookPlugin: NotificationPlugin = {
  type: 'webhook',
  name: 'Webhook',
  description: 'Send JSON POST to a URL',
  configFields: [
    { key: 'url', label: 'Webhook URL', type: 'url', required: true, placeholder: 'https://...' },
    { key: 'secret', label: 'Secret Header (optional)', type: 'password', placeholder: 'Bearer token or secret' },
  ],

  async send(config, payload) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.secret) headers['Authorization'] = String(config.secret);

    const res = await fetchNotificationTarget(String(config.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
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
