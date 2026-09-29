/**
 * Read-only link tokens, for a browser app served from another origin (CORS_ORIGINS). Its API requests carry the
 * session in the Authorization header, but images, videos, downloads and the team dashboard's live updates are
 * loaded by the browser itself, which can't add headers; and a cookie from this API's domain would be a
 * third-party cookie there, which browsers like Brave and Safari block. So those URLs carry ?access=<token>.
 *
 * A token names its user and when it expires (12 hours), signed with RESOURCE_TOKEN_SECRET (HMAC-SHA256). It is
 * good only for reading (GET, HEAD: middleware/auth.js), and only the session itself, not a token, gets a new one
 * (GET /api/auth/resource-token), so a copied link can't be used to change anything or to last longer. Tokens are
 * kept out of the logs (redactUrl).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export const RESOURCE_TOKEN_HOURS = 12;
// Without RESOURCE_TOKEN_SECRET, a random key for this run of the server: links end with a restart.
const KEY = config.auth.resourceSecret || randomBytes(32).toString('hex');
const sign = (body) => createHmac('sha256', KEY).update(body).digest('base64url');

/** `{ token, expiresAt }` for a signed-in user (`{ id, email, name, avatarUrl }`). */
export function issueResourceToken(user, now = Date.now()) {
  const expiresAt = now + RESOURCE_TOKEN_HOURS * 3_600_000;
  const body = Buffer.from(JSON.stringify({ i: user.id, e: user.email ?? null, n: user.name ?? null, a: user.avatarUrl ?? null, x: expiresAt })).toString('base64url');
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(expiresAt).toISOString() };
}

/** The user a token names, or null when it's forged, damaged or expired. */
export function readResourceToken(token, now = Date.now()) {
  const [body, mac, extra] = String(token ?? '').split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload?.i !== 'string' || !(payload.x > now)) return null;
  return { id: payload.i, email: payload.e, name: payload.n, avatarUrl: payload.a };
}

/** A URL for the logs: a link token replaced by an ellipsis. */
export const redactUrl = (url) => String(url ?? '').replace(/([?&]access=)[^&#]*/g, '$1…');
