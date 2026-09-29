/**
 * CORS for the browser app when it's served from another origin (CORS_ORIGINS: the app on Vercel and this API on
 * Render, say). Only those origins get the headers, so any other site's pages can't read a response, and the
 * cross-site guard (localGuard.js) refuses their requests that change anything. No credentials mode: requests carry
 * the session in the Authorization header, and the links for images, downloads and live updates a read-only token
 * (lib/resourceTokens.js), so nothing depends on a third-party cookie (Brave and Safari block them).
 */
import { config } from '../config.js';
import { trustedOrigin } from '../lib/origins.js';

export function cors(req, res, next) {
  if (!config.corsOrigins.length || !req.originalUrl.startsWith('/api')) return next();
  // The answer depends on the Origin header, for any cache on the way.
  res.vary('Origin');
  const origin = req.get('origin');
  if (!trustedOrigin(origin)) return next();
  res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Content-Disposition, X-Request-Id' });
  // A preflight: which methods and headers the app's requests may use, cached by the browser for ten minutes.
  if (req.method !== 'OPTIONS' || !req.get('access-control-request-method')) return next();
  res.set({
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
    'Access-Control-Allow-Headers': req.get('access-control-request-headers') || 'authorization, content-type',
    'Access-Control-Max-Age': '600',
  });
  res.status(204).end();
}
