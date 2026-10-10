import { z } from 'zod';
import { toDbId } from '../utils/dbId';

// Dotted-quad IPv4 without leading zeros (never a hostname, never IPv6).
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** RFC 1918 private IPv4 address (10/8, 172.16/12, 192.168/16). */
export function isRfc1918(ip: unknown): boolean {
  if (typeof ip !== 'string' || !IPV4_RE.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Positive integer id (number or digit string), normalised with toDbId. */
function dbIdField(label: string) {
  return z.union([z.number(), z.string()]).transform((value, ctx) => {
    const id = toDbId(value);
    if (id == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid ${label}` });
      return z.NEVER;
    }
    return id;
  });
}

export const openTunnelSchema = z.object({
  siteId: dbIdField('siteId'),
  targetIp: z.string()
    .trim()
    .max(15)
    .refine((v) => IPV4_RE.test(v), 'targetIp must be an IPv4 address')
    .refine((v) => isRfc1918(v), 'targetIp must be a private (RFC 1918) address'),
  targetPort: z.number().int().min(1).max(65535),
  probeId: dbIdField('probeId').nullable().optional(),
});

export type OpenTunnelInput = z.infer<typeof openTunnelSchema>;
