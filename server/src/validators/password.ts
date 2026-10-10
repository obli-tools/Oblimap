import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';

// One password policy for every place a password is chosen: self-service
// change, set-password, reset, admin create/reset, enrollment.
//  - at least 10 characters;
//  - at most 72 UTF-8 bytes (bcrypt silently ignores anything beyond);
//  - not one of the most common passwords (case-insensitive).

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

// Common / default passwords. Entries shorter than PASSWORD_MIN_LENGTH are
// already refused by the length rule; they are kept so the list stays useful
// if the minimum is ever lowered.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'password12345',
  'passw0rd', 'passw0rd123', 'p@ssw0rd', 'p@ssw0rd123', 'p@ssword123', 'password1!',
  'admin123', 'admin1234', 'admin12345', 'administrator', 'administrator1', 'adminadmin',
  'changeme', 'changeme123', 'changethis', 'change-this-in-production', 'dev-secret-change-me',
  '123456789', '1234567890', '12345678910', '0123456789', '9876543210', '123123123123',
  '1111111111', '0000000000', 'abcdefghij', 'abc1234567', '123456789a',
  'qwertyuiop', 'qwerty1234', 'qwerty12345', 'qwerty123456', 'azertyuiop', 'azerty123', 'azerty1234',
  '1q2w3e4r5t', '1qaz2wsx3edc', 'q1w2e3r4t5', 'qazwsxedc123', 'zaq12wsx',
  'letmein123', 'welcome123', 'iloveyou123', 'football123', 'baseball123', 'princess123',
  'sunshine123', 'superman123', 'dragon1234', 'monkey1234', 'master1234', 'trustno1234',
  'motdepasse', 'motdepasse1', 'motdepasse123', 'bonjour123', 'soleil123',
  'oblimap123', 'oblimap1234', 'oblimap12345', 'obliview123', 'obliance123', 'obligate123',
]);

/** True when the password is on the built-in common-password list (case-insensitive). */
export function isCommonPassword(pw: string): boolean {
  return COMMON_PASSWORDS.has(pw.trim().toLowerCase());
}

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((s) => Buffer.byteLength(s, 'utf8') <= PASSWORD_MAX_BYTES, 'Password too long')
  .refine((s) => !isCommonPassword(s), 'Password is too common');

/**
 * Throws AppError(400) when the password equals the username (ignoring case,
 * surrounding spaces and the "og_" prefix of Obligate-provisioned accounts).
 */
export function assertPasswordNotUsername(pw: string, username: string | null | undefined): void {
  if (!username) return;
  const p = pw.trim().toLowerCase();
  const u = username.trim().toLowerCase();
  if (!u) return;
  if (p === u || (u.startsWith('og_') && p === u.slice(3))) {
    throw new AppError(400, 'Password must not be the username');
  }
}
