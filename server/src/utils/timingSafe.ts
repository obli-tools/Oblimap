import crypto from 'crypto';
import { safeEqualSecret } from './safeCompare';

/**
 * Constant-time comparison of two secrets (tokens, codes, keys).
 * Thin alias of safeEqualSecret (utils/safeCompare.ts): both values are
 * SHA-256 hashed and compared with crypto.timingSafeEqual, so neither the
 * content nor the length leaks through timing. Empty or missing values never
 * match (fail closed).
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  return safeEqualSecret(a, b);
}

/** Lower-case hex SHA-256 of a UTF-8 string (token hashes, cache keys). */
export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
