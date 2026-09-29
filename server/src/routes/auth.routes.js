/**
 * Accounts (Supabase Auth). Signing up, in and out happens in the browser with Supabase's client;
 * the server only verifies the tokens it's given.
 *   GET    /api/auth/config    public: the Supabase project URL and publishable key the app signs in with
 *   GET    /api/auth/me        the signed-in person
 *   POST   /api/auth/session   the session cookie that lets images, videos and downloads load (GET only)
 *   DELETE /api/auth/session   removes the cookie (signing out)
 */
import { Router } from 'express';
import { config } from '../config.js';
import { SESSION_COOKIE, authConfigured, bearerOf, requireAuth } from '../middleware/auth.js';
import { profileOf } from '../services/users.js';
import { HttpError } from '../lib/httpError.js';
import { issueResourceToken } from '../lib/resourceTokens.js';
import { creditsOf } from '../services/credits.js';

const secure = (req) => req.secure || req.get('x-forwarded-proto') === 'https';
const cookieOptions = (req) => ({ httpOnly: true, sameSite: 'lax', secure: secure(req), path: '/api' });

export function authRouter() {
  const router = Router();

  router.get('/config', (req, res) => {
    res.json({ configured: authConfigured(), supabaseUrl: config.auth.supabaseUrl || null, publishableKey: config.auth.publishableKey || null });
  });

  router.get('/me', requireAuth, async (req, res) => {
    res.json({ user: { ...(await profileOf(req.user)), credits: await creditsOf(req.user) } });
  });

  // Called after signing in and after every token refresh, with the token in the Authorization header.
  router.post('/session', requireAuth, (req, res) => {
    const maxAge = Math.max(0, req.user.expiresAt - Date.now());
    res.cookie(SESSION_COOKIE, bearerOf(req), { ...cookieOptions(req), maxAge });
    res.status(204).end();
  });

  // A read-only link token, for a browser app on another origin (CORS_ORIGINS): its images, downloads and live updates
  // carry it as ?access= (lib/resourceTokens.js). Only the session itself gets one: not a cookie, not another token.
  router.get('/resource-token', requireAuth, (req, res) => {
    if (req.authVia !== 'bearer') throw new HttpError(403, 'צריך להתחבר כדי לקבל קישורים.', 'BEARER_REQUIRED');
    res.set('Cache-Control', 'no-store').json(issueResourceToken(req.user));
  });

  router.delete('/session', (req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    res.status(204).end();
  });

  return router;
}
