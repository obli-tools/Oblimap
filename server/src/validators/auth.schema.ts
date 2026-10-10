import { z } from 'zod';
import { passwordSchema } from './password';

// Sign-in: existing passwords may predate the password policy, so only the
// length is bounded here (passwordSchema applies when a password is chosen).
export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required').max(64),
  password: z.string().min(1, 'Password is required').max(255),
});

/** One e-mail address (never a list), trimmed and lower-cased. */
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

// First local password of an account that has none (enrollment only).
export const setPasswordSchema = z.object({
  password: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
