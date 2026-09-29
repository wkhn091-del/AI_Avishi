import { config } from '../config.js';
import { redactUrl } from '../lib/resourceTokens.js';

/** Minimal access log for API requests: method, path, status, duration. Off with LOG_REQUESTS=false. */
export function requestLogger(req, res, next) {
  if (!config.logRequests || !req.originalUrl.startsWith('/api')) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${redactUrl(req.originalUrl)} → ${res.statusCode} (${ms.toFixed(0)} ms)`);
  });
  next();
}
