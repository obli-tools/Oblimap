import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { passwordChangeLimiter } from '../middleware/rateLimiter';
import { profileController } from '../controllers/profile.controller';
import { updateProfileSchema, changePasswordSchema } from '../validators/profile.schema';

const router = Router();

// All routes require authentication (any role)
router.use(requireAuth);

// A profile update carrying a proof (e-mail change: current password or
// authenticator code) shares the per-user budget of the password change, so a
// session cannot use it as an unlimited current-password oracle.
function limitProofAttempts(req: Request, res: Response, next: NextFunction): void {
  const body = (req.body ?? {}) as { currentPassword?: unknown; currentCode?: unknown };
  if (body.currentPassword !== undefined || body.currentCode !== undefined) {
    passwordChangeLimiter(req, res, next);
    return;
  }
  next();
}

router.get('/', profileController.get);
router.put('/', limitProofAttempts, validate(updateProfileSchema), profileController.update);
router.put('/password', passwordChangeLimiter, validate(changePasswordSchema), profileController.changePassword);
router.post('/sessions/revoke-others', profileController.revokeOtherSessions);

export default router;
