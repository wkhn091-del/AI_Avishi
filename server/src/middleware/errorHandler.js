/**
 * The last middleware. Every failure leaves the API as `{ error: { message, code, details?, requestId? } }`: one
 * shape for the client, in Hebrew, never with a stack trace or internals. What went wrong goes to the server's log
 * with console.error, so a host like Render shows it as an error: for an unexpected error, the request (its id, the
 * method and path, the route that matched, who asked and from which origin) and the whole error with its stack; for
 * a database that can't be used or has no tables, one line saying what to fix (lib/dbErrors.js, lib/migrations.js).
 * The request id is in the answer too (X-Request-Id, and requestId for a 5xx), so an error on screen can be found in
 * the log.
 */
import { randomUUID } from 'node:crypto';
import { isolate } from '../lib/bidi.js';
import { HttpError } from '../lib/httpError.js';
import { isMissingSchema, warnMissingSchema } from '../lib/migrations.js';
import { databaseProblem, warnDatabase } from '../lib/dbErrors.js';
import { redactUrl } from '../lib/resourceTokens.js';

/** 404 for unknown /api routes (registered after all API routers). */
export function apiNotFound(req, res) {
  res.status(404).json({ error: { message: `אין נתיב API עבור ${isolate(`${req.method} ${redactUrl(req.originalUrl)}`)}.`, code: 'NOT_FOUND' } });
}

/** 404 for any other path when this server doesn't serve the browser app (API only): JSON, not Express's "Cannot GET". */
export function notFound(req, res) {
  res.status(404).json({ error: { message: 'אין כאן דף: זה השרת של Stash (ה-API), והאפליקציה עצמה נמצאת בכתובת שלה.', code: 'NOT_FOUND' } });
}

// The host's request id when it sends one (a proxy's X-Request-Id), or a short one of our own.
const requestIdOf = (req) =>
  String(req.get?.('x-request-id') ?? '')
    .replace(/[^\w.:-]/g, '')
    .slice(0, 64) || randomUUID().slice(0, 8);

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const requestId = requestIdOf(req);
  const where = `${requestId} ${req.method} ${redactUrl(req.originalUrl)}`;
  let status = 500;
  let code = 'INTERNAL';
  let message = `אירעה שגיאה לא צפויה בשרת. הפרטים ביומן של השרת, תחת המזהה ${requestId}.`;
  let details;
  let problem = null;

  if (error instanceof HttpError) {
    ({ status, code, message, details } = error);
  } else if (error?.type === 'entity.parse.failed') {
    [status, code, message] = [400, 'INVALID_JSON', 'גוף הבקשה אינו JSON תקין.'];
  } else if (error?.type === 'entity.too.large') {
    [status, code, message] = [413, 'BODY_TOO_LARGE', 'גוף הבקשה גדול מדי.'];
  } else if (isMissingSchema(error)) {
    // The database has no tables yet (its migrations weren't applied): say what to do, not a stack trace per request.
    [status, code, message] = [503, 'DATABASE_NOT_MIGRATED', 'מסד הנתונים עוד לא הוכן: חסרות בו הטבלאות של Stash. צריך להריץ את המיגרציות (npm run db:migrate -w server) ולנסות שוב.'];
    warnMissingSchema(where);
  } else if ((problem = databaseProblem(error))) {
    // The database can't be used (credentials, certificate, unreachable…): say which, and what to fix in the log.
    [status, code, message] = [503, problem.code, problem.message];
    warnDatabase(problem, where);
  }

  // Expected 5xx conditions (AI off, provider errors, the database) are logged where they happen, or above.
  if (status >= 500 && !(error instanceof HttpError) && code !== 'DATABASE_NOT_MIGRATED' && !problem) {
    const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'none matched';
    console.error(`[error] ${where} → ${status} (route: ${route}; user: ${req.user?.id ?? 'not signed in'}; origin: ${req.get?.('origin') ?? 'none'})\n`, error);
  }
  res.set?.('X-Request-Id', requestId);
  res.status(status).json({ error: { message, code, ...(details && { details }), ...(status >= 500 && { requestId }) } });
}
