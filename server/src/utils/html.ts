// Output encoding for notification bodies (SMTP HTML, Telegram HTML, chat
// webhooks). Device names, hostnames, vendors and messages come from probes
// and admins: any of them can contain markup, attribute-breaking quotes or
// mass-mention tokens.

/** HTML-escapes & < > " ' — safe for element content and quoted attributes. */
export function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Value for an href attribute: the URL when it is an absolute http(s) URL,
 * '#' otherwise (javascript:, data:, relative, unparseable…). The result is
 * ALREADY HTML-escaped: use it as-is inside a quoted attribute
 * (`<a href="${safeHref(url)}">`), do not escape it again.
 */
export function safeHref(url: unknown): string {
  if (typeof url !== 'string') return '#';
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return '#';
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '#';
    return escapeHtml(parsed.href);
  } catch {
    return '#';
  }
}

/** Telegram's parse_mode "HTML" accepts the same entities (&lt; &gt; &amp; &quot; and numeric ones). */
export const escapeTelegramHtml = escapeHtml;

/**
 * Defuses mass mentions in text sent to chat platforms: "@everyone",
 * "@here", "@channel" (Discord, Teams, Mattermost…) and the Slack / Discord
 * `<!here>` `<!channel>` `<!everyone>` `<@id>` `<@&role>` forms get a
 * zero-width space after the trigger character, so they render as text.
 */
export function neutralizeMentions(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/@(everyone|here|channel)\b/gi, '@​$1')
    .replace(/<([!@])/g, '<​$1');
}
