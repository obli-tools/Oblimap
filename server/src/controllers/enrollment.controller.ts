import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { invalidateAccountPolicyCache } from '../middleware/accountPolicy';
import { authService, normalizeEmail, isUniqueViolation, mergedPreferencesSql } from '../services/auth.service';
import { auditService } from '../services/audit.service';
import { twoFactorService } from '../services/twoFactor.service';
import { emailSchema } from '../validators/auth.schema';
import { appThemeSchema } from '../validators/profile.schema';
import { z } from 'zod';

export const REQUIRED_ENROLLMENT_VERSION = 2;

const enrollmentSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  email: emailSchema,
  preferredLanguage: z.string().max(10).default('en'),
  toastEnabled: z.boolean().default(true),
  toastPosition: z.enum(['top-center', 'bottom-right']).default('bottom-right'),
  preferredTheme: appThemeSchema.default('obli-operator'),
});

// Same message whatever the reason (taken by a local or an SSO account, race
// on the unique index): the answer must not tell which addresses exist.
const EMAIL_UNAVAILABLE = 'Email unavailable';

export const enrollmentController = {
  // Callable only while the enrollment is incomplete: afterwards the profile
  // (PUT /api/profile, which asks for the current password to change the
  // e-mail address) is the only way to change these fields.
  async complete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const parsed = enrollmentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid input');
      }

      const { displayName, email, preferredLanguage, toastEnabled, toastPosition, preferredTheme } = parsed.data;

      const current = await db('users').where({ id: userId }).first('email', 'enrollment_version', 'foreign_source') as
        { email: string | null; enrollment_version: number | null; foreign_source: string | null } | undefined;
      if (!current) throw new AppError(404, 'User not found');
      if ((current.enrollment_version ?? 0) >= REQUIRED_ENROLLMENT_VERSION) {
        throw new AppError(409, 'Enrollment already completed');
      }

      // An Obligate SSO account's address comes from Obligate (updated at each
      // SSO sign-in): enrollment never changes it. Its enrollment is never
      // completed on its own (ProtectedRoute skips it), so this route stays
      // callable, and PUT /api/profile asks a proof such an account may not have.
      // The uniqueness check runs for every other change of address. An
      // unchanged address is not re-checked: an SSO account may legitimately
      // share it with an older local account.
      const previousEmail = current.email ? String(current.email) : null;
      const emailChanged = current.foreign_source !== 'obligate' && normalizeEmail(previousEmail) !== email;
      if (emailChanged && await authService.isEmailTaken(email, userId)) {
        throw new AppError(409, EMAIL_UNAVAILABLE);
      }

      // Merged into the stored preferences (keys synced from Obligate are kept).
      const preferences = { toastEnabled, toastPosition, preferredTheme };
      const update: Record<string, unknown> = {
        display_name: displayName !== undefined ? displayName : db.raw('display_name'),
        preferred_language: preferredLanguage,
        preferences: mergedPreferencesSql(preferences),
        enrollment_version: REQUIRED_ENROLLMENT_VERSION,
        updated_at: new Date(),
      };
      if (emailChanged) {
        update.email = email;
        // Codes by e-mail were bound to the old address.
        update.email_otp_enabled = false;
      }

      let row: Record<string, unknown> | undefined;
      try {
        [row] = await db('users')
          .where({ id: userId })
          .where((q) => q.whereNull('enrollment_version').orWhere('enrollment_version', '<', REQUIRED_ENROLLMENT_VERSION))
          .update(update)
          .returning(['id', 'username', 'display_name', 'role', 'is_active', 'created_at', 'updated_at', 'preferences', 'email', 'preferred_language', 'enrollment_version']);
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, EMAIL_UNAVAILABLE);
        throw err;
      }

      if (!row) throw new AppError(409, 'Enrollment already completed');

      if (emailChanged) {
        invalidateAccountPolicyCache(userId);
        await auditService.logReq(req, {
          action: 'user.email_changed',
          resourceType: 'user',
          resourceId: userId,
          details: { from: previousEmail, to: email, via: 'enrollment' },
        });
        twoFactorService.notifyInBackground(previousEmail, 'E-mail address changed', [
          `The e-mail address of your account was changed to ${email}.`,
          'If this was not you, contact an administrator.',
        ]);
      }

      res.json({
        success: true,
        data: {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          role: row.role,
          isActive: row.is_active,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          preferences: row.preferences ?? null,
          email: row.email,
          preferredLanguage: row.preferred_language,
          enrollmentVersion: row.enrollment_version,
        },
      });
    } catch (err) {
      next(err);
    }
  },
};
