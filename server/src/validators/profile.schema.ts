import { z } from 'zod';
import { passwordSchema } from './password';
import { emailSchema } from './auth.schema';

/** Every theme the client can render (shared AppTheme). */
export const appThemeSchema = z.enum(['obli-operator', 'obli-daylight', 'obli-dim', 'modern', 'neon']);

// The preference keys a user may set (shared UserPreferences). Other keys are
// stripped. A save is MERGED into the stored preferences (profile.controller):
// saving some keys never erases the others (the theme, keys synced from Obligate).
const userPreferencesSchema = z.object({
  toastEnabled: z.boolean().optional(),
  toastPosition: z.enum(['top-center', 'bottom-right']).optional(),
  preferredTheme: appThemeSchema.optional(),
  multiTenantNotificationsEnabled: z.boolean().optional(),
  anonymousMode: z.boolean().optional(),
}).nullable().optional();

export const updateProfileSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  preferences: userPreferencesSchema,
  email: emailSchema.nullable().optional(),
  preferredLanguage: z.string().max(10).optional(),
  // Proof required to change the e-mail address (the password-reset
  // channel): the current password, or — account without a local password —
  // a current code of its authenticator app.
  currentPassword: z.string().max(1024).optional(),
  currentCode: z.string().max(16).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
