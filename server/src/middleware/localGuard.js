/**
 * Protects the unauthenticated local API from other websites open in the
 * same browser.
 *
 * 1. Host allowlist (DNS rebinding). A malicious domain that re-resolves to
 *    127.0.0.1 would otherwise count as "same-origin" with this server and
 *    could read your stored files. Only localhost, IP addresses and the names
 *    in ALLOWED_HOSTS are accepted — the same rule Vite's dev server uses.
 * 2. Cross-site writes (CSRF). Browsers label every request with
 *    Sec-Fetch-Site; state-changing requests from any other site are refused,
 *    so a page elsewhere can't silently upload or delete things.
 *    Non-browser clients such as curl don't send the header and are allowed.
 */
import { isolate } from '../lib/bidi.js';
import net from 'node:net';
import { config } from '../config.js';
import { HttpError } from '../lib/httpError.js';
import { trustedOrigin } from '../lib/origins.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function localGuard(req, res, next) {
  const hostname = hostnameOf(req.headers.host);
  if (!isAllowedHost(hostname)) {
    return next(
      new HttpError(
        403,
        `בקשות לשם המארח ${isolate(hostname || '(ללא)')} חסומות. כדי לאפשר אותו, הוסיפו אותו ל-ALLOWED_HOSTS בקובץ server/.env.`,
        'HOST_NOT_ALLOWED',
      ),
    );
  }

  const site = req.headers['sec-fetch-site'];
  // The browser app's own origins (CORS_ORIGINS, when it's served from elsewhere) are not "another site".
  if (site && !SAFE_METHODS.has(req.method) && site !== 'same-origin' && site !== 'none' && !trustedOrigin(req.headers.origin)) {
    return next(new HttpError(403, 'בקשות מאתרים אחרים אינן מורשות.', 'CROSS_SITE'));
  }
  next();
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isAllowedHost(hostname) {
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) return true;
  return config.allowedHosts.includes(hostname);
}
