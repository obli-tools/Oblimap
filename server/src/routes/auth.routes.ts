import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { enrollmentController } from '../controllers/enrollment.controller';
import { passwordResetController } from '../controllers/passwordReset.controller';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { authLimiter, emailSendLimiter, mfaAccountLimiter, passwordChangeLimiter } from '../middleware/rateLimiter';
import { stepUpController } from '../middleware/stepUp';
import { loginSchema, setPasswordSchema } from '../validators/auth.schema';

const router = Router();

// Per address + username here; the per-account bound is applied by the
// controller after the password check (a correct password is never refused).
router.post('/login', authLimiter, validate(loginSchema), authController.login);
// No requireAuth: a sign-in waiting for its 2FA code must be able to sign out.
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);
router.get('/permissions', requireAuth, authController.permissions);

// Enrollment (requires auth — user must be logged in; only while incomplete).
// The limiter bounds e-mail probing through the uniqueness check.
router.post('/enrollment', requireAuth, passwordChangeLimiter, enrollmentController.complete);

// First local password of an account that has none, during enrollment only
// (403 use_profile_password otherwise: PUT /api/profile/password).
router.post('/set-password', requireAuth, passwordChangeLimiter, validate(setPasswordSchema), authController.setPassword);

// 2FA step-up for the actions a tenant marks sensitive (middleware/stepUp.ts):
// proves a TOTP code (anti-replay through users.totp_last_step) or an e-mail
// code mailed by /step-up/email, valid 5 minutes for this session. Wrong codes
// are bounded per account like the sign-in codes (mfaAccountLimiter, keyed on
// the session's user); mails like the other code mails (emailSendLimiter).
router.post('/step-up', requireAuth, mfaAccountLimiter, stepUpController.verify);
router.post('/step-up/email', requireAuth, emailSendLimiter, stepUpController.sendEmail);

// Password reset (public)
router.post('/forgot-password', emailSendLimiter, passwordResetController.forgot);
router.post('/reset-password/validate', passwordResetController.validate);
router.post('/reset-password', passwordResetController.reset);

export default router;
