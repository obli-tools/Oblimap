import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

// Extend express-session types
declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    role: string;
    currentTenantId: number;
    oauthState: string;
    /** Cross-app tenant handoff — slug captured by /auth/sso-redirect, applied
     *  in /auth/callback once the user comes back from Obligate, then cleared
     *  (Obli cross-app tenant handoff). */
    requestedTenantSlug?: string;
  }
}

/**
 * A completed sign-in is required (a session waiting for its 2FA code holds
 * pendingMfaUserId, never userId). The user behind the session is re-read by
 * sessionUserGuard (app.ts) before any route: a disabled or deleted user's
 * session never reaches this point signed in, and session.role follows the DB.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    next(new AppError(401, 'Authentication required'));
    return;
  }
  next();
}
