/**
 * What went wrong with the database, when it isn't a query's fault: the credentials, the TLS certificate, a server
 * that doesn't answer, a database that doesn't exist, a malformed DATABASE_URL, or a pool with no connection left.
 * Each gets a 503 with a short Hebrew message (middleware/errorHandler.js) and one log line, at most a minute apart,
 * saying what to fix; the startup line says the same (lib/migrations.js). The shapes are Prisma 7's with the pg
 * driver adapter (P1000 and the rest, and the adapter's error kinds).
 */
const lastLine = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

const SEE_LOG = 'הפרטים ביומן של השרת.';
const PROBLEMS = {
  pooler_user: {
    code: 'DATABASE_AUTH_FAILED',
    message: `אין גישה למסד הנתונים: שרת החיבורים של Supabase לא מצא את הפרויקט לפי הכתובת ושם המשתמש שב-DATABASE_URL. ${SEE_LOG}`,
    hint: "Supabase's pooler couldn't match the host and user to a project. Copy the Session pooler string from the dashboard's Connect dialog as it is and replace only the password: the host's aws-0/aws-1 is a pooler cluster, not part of the region, and the user is postgres.<project-ref>.",
  },
  busy: {
    code: 'DATABASE_BUSY',
    message: 'מסד הנתונים עמוס: כל החיבורים אליו תפוסים. נסו שוב בעוד רגע.',
    hint: "The database refused another connection (Supabase's session pooler allows as many clients as its pool size): lower DATABASE_POOL_SIZE, or use the transaction pooler (port 6543).",
  },
  auth: {
    code: 'DATABASE_AUTH_FAILED',
    message: `אין גישה למסד הנתונים: שם המשתמש או הסיסמה שב-DATABASE_URL נדחו. ${SEE_LOG}`,
    hint: "The database rejected the user or password in DATABASE_URL. On Supabase's pooler the user is postgres.<project-ref>, and the password is the database password (Database Settings), URL-encoded.",
  },
  tls: {
    code: 'DATABASE_TLS_FAILED',
    message: `אין גישה למסד הנתונים: החיבור המוצפן אליו נכשל, כי אישור ה-SSL שלו לא אומת. ${SEE_LOG}`,
    hint: "The database's TLS certificate wasn't accepted. sslmode=verify-full, or DATABASE_CA_CERT, needs Supabase's certificate (Database Settings > SSL Configuration); sslmode=require, or none, encrypts without verifying.",
  },
  unreachable: {
    code: 'DATABASE_UNREACHABLE',
    message: `אין גישה למסד הנתונים: השרת שלו לא ענה. ${SEE_LOG}`,
    hint: "The database server didn't answer. On Render, use Supabase's session pooler (aws-…pooler.supabase.com:5432): db.<project-ref>.supabase.co is IPv6-only, and Render has no IPv6. A free Supabase project may also be paused.",
  },
  missing_database: {
    code: 'DATABASE_NOT_FOUND',
    message: `אין גישה למסד הנתונים: מסד הנתונים שב-DATABASE_URL לא קיים. ${SEE_LOG}`,
    hint: "The database named in DATABASE_URL doesn't exist (on Supabase it's postgres).",
  },
  bad_url: {
    code: 'DATABASE_URL_INVALID',
    message: `הכתובת ב-DATABASE_URL אינה תקינה: תווים כמו @ או # בסיסמה צריכים קידוד. ${SEE_LOG}`,
    hint: 'DATABASE_URL is not a valid URL: URL-encode characters like @ # / ? : in the password (# is %23, @ is %40).',
  },
};

/** `{ code, message, hint, detail }` for a database that can't be used, or null for any other error. */
export function databaseProblem(error) {
  if (!error || typeof error !== 'object') return null;
  const cause = error.meta?.driverAdapterError?.cause ?? {};
  const text = `${error.message ?? ''} ${cause.originalMessage ?? ''}`;
  // Supabase's pooler says it as "Tenant or user not found" or "(ENOTFOUND) tenant/user postgres.<ref> not found".
  const found = /tenant or user not found|tenant\/user \S* ?not found/i.test(text)
    ? 'pooler_user'
    : cause.kind === 'TooManyConnections' || /max clients|EMAXCONN|too many (clients|connections)|remaining connection slots/i.test(text)
      ? 'busy'
      : error.code === 'P1000' || cause.kind === 'AuthenticationFailed'
        ? 'auth'
        : error.code === 'P1011' || cause.kind === 'TlsConnectionError'
          ? 'tls'
          : error.code === 'P1001' || error.code === 'P1002' || cause.kind === 'DatabaseNotReachable' || cause.kind === 'SocketTimeout'
            ? 'unreachable'
            : error.code === 'P1003' || cause.kind === 'DatabaseDoesNotExist'
              ? 'missing_database'
              : error.code === 'ERR_INVALID_URL'
                ? 'bad_url'
                : null;
  return found && { ...PROBLEMS[found], detail: lastLine(error.message) };
}

const recent = new Map(); // problem code → { at, skipped }
/**
 * One error line per kind of problem, at most a minute apart (a flood of identical stack traces hides more than it
 * shows): where, what to fix, the error's own words, and how many requests met it since the last line.
 */
export function warnDatabase(problem, where) {
  const seen = recent.get(problem.code);
  if (seen && Date.now() - seen.at < 60_000) return void (seen.skipped += 1);
  recent.set(problem.code, { at: Date.now(), skipped: 0 });
  console.error(`[db] ${where}: ${problem.hint} (${problem.detail})${seen?.skipped ? ` [and ${seen.skipped} more requests since the last line]` : ''}`);
}
