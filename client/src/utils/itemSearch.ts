import type { SiteItem } from '@oblimap/shared';

/** The anonymize helper (utils/anonymize.ts) as passed by callers. */
export type AnonymizeFn = (
  text: string | null | undefined,
  kind?: 'ip' | 'mac' | 'hostname' | 'username' | 'path',
) => string;

/** Hex digits of a MAC address or of a query typed as one ("aabb", "AA-BB", "aa:bb:cc"). */
function macHex(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-f]/g, '');
}

/**
 * A query with '.' is compared as a MAC only in the Cisco notation
 * (aabb.ccdd.eeff): hex groups of 1–4 digits with a hex letter or a full
 * 4-digit group. A dotted-decimal IP or IP prefix ("10.0.0.5", "10.1",
 * ".15") is never turned into hex digits matched against MACs.
 */
function macQueryAllowed(q: string): boolean {
  if (!q.includes('.')) return true;
  if (!/^[0-9a-f]{1,4}(\.[0-9a-f]{1,4})+\.?$/.test(q)) return false;
  return /[a-f]/.test(q) || /(^|\.)[0-9a-f]{4}(\.|$)/.test(q);
}

/**
 * Single source of truth for "does this site item match the search query?"
 * (modeled on Obliance utils/deviceSearch.ts). Case-insensitive substring
 * match on the IP, MAC (with or without separators), hostname, custom name,
 * vendor and notes; a number matches an open port exactly.
 *
 * `anonymizeFn`: in anonymous mode the table shows masked values, so the
 * masked strings are matched too (a user copying what is on screen still
 * finds the row).
 */
export function itemMatchesSearch(item: SiteItem, rawQuery: string, anonymizeFn?: AnonymizeFn): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;

  const fields: Array<string | null | undefined> = [
    item.ip,
    item.mac,
    item.hostname,
    item.customName,
    item.vendor,
    item.notes,
  ];
  for (const f of fields) {
    if (f && f.toLowerCase().includes(q)) return true;
  }

  // MAC typed without separators, or with other ones ("aabbcc", "aa-bb-cc").
  if (item.mac) {
    const qHex = macHex(q);
    // At least two hex digits, and only MAC-like characters in the query.
    if (qHex.length >= 2 && /^[0-9a-f:\-.\s]+$/.test(q) && macQueryAllowed(q) && macHex(item.mac).includes(qHex)) return true;
  }

  // Open ports: exact number ("22", "443").
  if (/^\d{1,5}$/.test(q) && (item.openPorts ?? []).some((p) => String(p) === q)) return true;

  if (anonymizeFn) {
    const shown: string[] = [anonymizeFn(item.ip, 'ip')];
    if (item.mac) shown.push(anonymizeFn(item.mac, 'mac'));
    if (item.hostname) shown.push(anonymizeFn(item.hostname, 'hostname'));
    if (item.customName) shown.push(anonymizeFn(item.customName, 'hostname'));
    for (const s of shown) {
      if (s && s.toLowerCase().includes(q)) return true;
    }
  }
  return false;
}
