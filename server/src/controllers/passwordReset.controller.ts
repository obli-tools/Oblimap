import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { passwordResetService } from '../services/passwordReset.service';
import { auditService } from '../services/audit.service';
import { killSessionsForUser } from '../services/userSessions.service';
import { AppError } from '../middleware/errorHandler';
import { invalidateAccountPolicyCache } from '../middleware/accountPolicy';
import { emailSchema } from '../validators/auth.schema';
import { passwordSchema } from '../validators/password';
import { logger } from '../utils/logger';

const forgotSchema = z.object({ email: emailSchema });
const validateSchema = z.object({ token: z.string().min(1).max(256) });
const resetSchema = z.object({
  token: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const passwordResetController = {
  async forgot(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = forgotSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, 'Invalid email address');

      // Always 200, answered BEFORE the lookup: neither the answer nor its
      // timing (DB writes, SMTP) tells whether the address has an account.
      res.json({ success: true, message: 'If an account with that email exists, a reset link has been sent.' });
      void passwordResetService.requestReset(parsed.data.email).catch((err) => {
        logger.warn({ err: (err as Error)?.message }, 'Password reset request failed');
      });
    } catch (err) {
      next(err);
    }
  },

  async validate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = validateSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, 'Invalid token');

      const userId = await passwordResetService.validateToken(parsed.data.token);
      res.json({ success: true, data: { valid: userId !== null } });
    } catch (err) {
      next(err);
    }
  },

  async reset(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = resetSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid input');

      const userId = await passwordResetService.resetPassword(parsed.data.token, parsed.data.newPassword);
      if (userId === null) throw new AppError(400, 'Invalid or expired reset token');

      invalidateAccountPolicyCache(userId);
      // Every existing session of the account ends (e.g. an attacker's).
      await killSessionsForUser(userId, 'password_reset');
      await auditService.logReq(req, {
        tenantId: null,
        userId,
        action: 'user.password_reset',
        resourceType: 'user',
        resourceId: userId,
      });

      res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
      next(err);
    }
  },
};
