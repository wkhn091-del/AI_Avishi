/**
 * Accounts, with Supabase Auth. Every API request (except /api/health and /api/auth/config)
 * carries the signed-in person's access token, and nothing runs before it's verified.
 *
 * Verification follows Supabase's guidance (https://supabase.com/docs/guides/auth/jwts):
 *  - Projects with asymmetric signing keys (the default for new projects): the signature is
 *    checked locally against the project's public keys, /auth/v1/.well-known/jwks.json, which are
 *    kept for at most 10 minutes (Supabase's own cache time, so a revoked key stops working soon).
 *  - Projects still on the shared secret: checked locally with SUPABASE_JWT_SECRET, or without it
 *    by Supabase Auth itself (GET /auth/v1/user), whose answer is kept for a minute.
 * The issuer (<SUPABASE_URL>/auth/v1) and audience ("authenticated") are always checked, so a
 * token made for another project or service is refused, and anonymous sign-ins are refused too.
 *
 * API calls send the token in the Authorization header. Images, videos, downloads and previews
 * load from plain URLs, which can't send headers: for those (GET and HEAD only) the same token is
 * accepted from an httpOnly cookie that the app sets after signing in (POST /api/auth/session).
 * Nothing that changes data accepts the cookie, so another site can't act for the user.
 */
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { config } from '../config.js';
import { HttpError } from '../lib/httpError.js';
import { readResourceToken } from '../lib/resourceTokens.js';

export const SESSION_COOKIE = 'stash_session';
const ASYMMETRIC = ['ES256', 'RS256', 'EdDSA'];
const AUTH_SERVER_CACHE_MS = 60_000;

export const authConfigured = () => Boolean(config.auth.supabaseUrl && config.auth.publishableKey);

let projectKeys = null;
const keys = () =>
  (projectKeys ??= createRemoteJWKSet(new URL(`${config.auth.supabaseUrl}/auth/v1/.well-known/jwks.json`), {
    cacheMaxAge: 10 * 60_000,
    cooldownDuration: 30_000,
  }));

const expired = () => new HttpError(401, 'פג תוקף ההתחברות. התחברו שוב.', 'SESSION_EXPIRED');
const invalid = () => new HttpError(401, 'ההתחברות לא תקינה. התחברו שוב.', 'UNAUTHENTICATED');

// Tokens that Supabase Auth confirmed, by their hash, for projects verified that way.
const confirmed = new Map();

async function askAuthServer(token) {
  const key = createHash('sha256').update(token).digest('hex');
  const hit = confirmed.get(key);
  if (hit && hit.until > Date.now()) return hit.claims;
  let response;
  try {
    response = await fetch(`${config.auth.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: config.auth.publishableKey, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(503, 'אי אפשר לאמת את ההתחברות כרגע. נסו שוב בעוד רגע.', 'AUTH_UNAVAILABLE');
  }
  if (!response.ok) throw response.status >= 500 ? new HttpError(503, 'אי אפשר לאמת את ההתחברות כרגע. נסו שוב בעוד רגע.', 'AUTH_UNAVAILABLE') : invalid();
  const user = await response.json();
  const { exp } = decodeJwt(token);
  const claims = { sub: user.id, email: user.email, user_metadata: user.user_metadata, is_anonymous: user.is_anonymous, exp };
  confirmed.set(key, { claims, until: Math.min(Date.now() + AUTH_SERVER_CACHE_MS, (exp ?? 0) * 1000) });
  if (confirmed.size > 1_000) confirmed.delete(confirmed.keys().next().value);
  return claims;
}

/** The person a token belongs to: `{ id, email, name, avatarUrl, expiresAt }`. Throws a 401 (or 503). */
export async function verifyToken(token) {
  const options = { issuer: `${config.auth.supabaseUrl}/auth/v1`, audience: 'authenticated' };
  let claims;
  try {
    if (config.auth.jwtSecret) {
      ({ payload: claims } = await jwtVerify(token, new TextEncoder().encode(config.auth.jwtSecret), { ...options, algorithms: ['HS256'] }));
    } else if (decodeProtectedHeader(token).alg === 'HS256') {
      claims = await askAuthServer(token);
    } else {
      ({ payload: claims } = await jwtVerify(token, keys(), { ...options, algorithms: ASYMMETRIC }));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof errors.JWTExpired) throw expired();
    if (error instanceof errors.JWKSTimeout || (error?.code === 'ERR_JOSE_GENERIC' && /fetch|network/i.test(error.message))) {
      throw new HttpError(503, 'אי אפשר לאמת את ההתחברות כרגע. נסו שוב בעוד רגע.', 'AUTH_UNAVAILABLE');
    }
    throw invalid();
  }
  if (typeof claims.sub !== 'string' || !claims.sub || claims.is_anonymous) throw invalid();
  const meta = claims.user_metadata ?? {};
  return {
    id: claims.sub,
    email: String(claims.email ?? '').toLowerCase(),
    name: typeof (meta.full_name ?? meta.name) === 'string' ? (meta.full_name ?? meta.name) : null,
    avatarUrl: typeof meta.avatar_url === 'string' ? meta.avatar_url : null,
    expiresAt: (claims.exp ?? 0) * 1000,
  };
}

export function cookieOf(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export const bearerOf = (req) => {
  const header = String(req.get('authorization') ?? '');
  return /^bearer\s+\S/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : null;
};

/**
 * A request's credentials, and where they came from: the Authorization header (for anything), or, for reading
 * (GET, HEAD), the session cookie or a read-only link token (?access=: lib/resourceTokens.js), which is what a
 * browser app on another origin puts in the links the browser loads itself (images, downloads, live updates).
 */
function credentialsOf(req) {
  const bearer = bearerOf(req);
  if (bearer) return { token: bearer, via: 'bearer' };
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const cookie = cookieOf(req, SESSION_COOKIE);
  if (cookie) return { token: cookie, via: 'cookie' };
  const link = typeof req.query?.access === 'string' ? req.query.access : null;
  return link ? { token: link, via: 'link' } : null;
}

/** Verifies the request's credentials and sets req.user (`{ id, email, name, avatarUrl, isAdmin }`) and req.authVia. */
export async function requireAuth(req, res, next) {
  if (!authConfigured()) {
    return next(new HttpError(503, 'ההתחברות לא הוגדרה בשרת: הגדירו SUPABASE_URL ו-SUPABASE_PUBLISHABLE_KEY בקובץ server/.env (או בהגדרות הסביבה של השרת).', 'AUTH_NOT_CONFIGURED'));
  }
  const credentials = credentialsOf(req);
  if (!credentials) return next(new HttpError(401, 'צריך להתחבר.', 'UNAUTHENTICATED'));
  try {
    const user = credentials.via === 'link' ? readResourceToken(credentials.token) : await verifyToken(credentials.token);
    if (!user) throw new HttpError(401, 'הקישור הזה כבר לא בתוקף. רעננו את הדף.', 'LINK_EXPIRED');
    req.user = { ...user, isAdmin: Boolean(user.email) && config.auth.adminEmails.includes(user.email) };
    req.authVia = credentials.via;
    next();
  } catch (error) {
    next(error);
  }
}

/** Only for admins (ADMIN_EMAILS): the tools that keep one shared store. */
export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return next(new HttpError(403, 'האזור הזה פתוח רק למנהלי המערכת.', 'ADMIN_ONLY'));
  next();
}
