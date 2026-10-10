import { Router } from 'express';
import { twoFactorController } from '../controllers/twoFactor.controller';
import { requireAuth } from '../middleware/auth';
import { mfaLimiter, mfaAccountLimiter, emailSendLimiter, passwordChangeLimiter } from '../middleware/rateLimiter';

const router = Router();

// Profile 2FA routes (requires auth). Factor management checks a proof
// (current code / password): its failures are bounded per user.
router.get('/status', requireAuth, twoFactorController.status);
router.post('/totp/setup', requireAuth, passwordChangeLimiter, twoFactorController.totpSetup);
router.post('/totp/enable', requireAuth, passwordChangeLimiter, twoFactorController.totpEnable);
router.delete('/totp', requireAuth, passwordChangeLimiter, twoFactorController.totpDisable);
router.post('/email/setup', requireAuth, passwordChangeLimiter, emailSendLimiter, twoFactorController.emailSetup);
router.post('/email/enable', requireAuth, passwordChangeLimiter, twoFactorController.emailEnable);
router.delete('/email', requireAuth, passwordChangeLimiter, twoFactorController.emailDisable);

// Auth 2FA routes (rate-limited, no requireAuth — session has pendingMfaUserId)
router.post('/verify', mfaLimiter, mfaAccountLimiter, twoFactorController.verify);
router.post('/resend-email', emailSendLimiter, twoFactorController.resendEmail);

export default router;
