// A database that can't be used: which problem it is (from the errors Prisma 7 and the pg adapter really throw), the
// 503 that names it, and the TLS settings that keep sslmode=require from rejecting Supabase's certificate.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

const { databaseProblem } = await import('../src/lib/dbErrors.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { poolConfig, withoutParam } = await import('../src/lib/db.js');

// As thrown (the probes behind these: a wrong password, a closed port, a missing database, sslmode=require against a
// self-signed certificate, an unencoded # in the password).
const prismaError = (code, message, cause) => Object.assign(new Error(`Invalid \`prisma.user.findFirst()\` invocation:\n\n${message}`), { name: 'PrismaClientKnownRequestError', code, meta: cause && { driverAdapterError: { name: 'DriverAdapterError', cause } } });
const ERRORS = {
  auth: prismaError('P1000', 'Authentication failed against the database server, the provided database credentials for `stash` are not valid', { kind: 'AuthenticationFailed', originalCode: '28P01' }),
  unreachable: prismaError('P1001', "Can't reach database server at db.example.supabase.co", { kind: 'DatabaseNotReachable' }),
  missing: prismaError('P1003', 'Database `nope` does not exist on the database server', { kind: 'DatabaseDoesNotExist', originalCode: '3D000' }),
  tls: prismaError('P1011', 'Error opening a TLS connection: self-signed certificate in certificate chain', { kind: 'TlsConnectionError' }),
  url: Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }),
  tenant: prismaError(undefined, 'FATAL: Tenant or user not found', { kind: 'postgres', originalCode: 'XX000', originalMessage: 'Tenant or user not found' }),
  // As Render logged it: Prisma 7.10's generic database error (P2039), with Supavisor's newer wording.
  supavisor: prismaError('P2039', 'Database error. Code: `XX000`. Message: `(ENOTFOUND) tenant/user postgres.abcdefghijklmnopqrst not found`', { kind: 'postgres', originalCode: 'XX000', originalMessage: '(ENOTFOUND) tenant/user postgres.abcdefghijklmnopqrst not found' }),
  busy: prismaError(undefined, '(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15'),
  // As Render logged it (Prisma 7.10, Supabase's shared pooler, a host that isn't the project's).
  pooler: prismaError('P2039', 'Database error. Code: `XX000`. Message: `(ENOTFOUND) tenant/user postgres.pjqgejhjysnnzdaraymx not found`', {
    kind: 'postgres',
    originalCode: 'XX000',
    originalMessage: '(ENOTFOUND) tenant/user postgres.pjqgejhjysnnzdaraymx not found',
  }),
};

describe('A database that can’t be used', () => {
  test('each cause is named, with what to fix', () => {
    const codeOf = (name) => databaseProblem(ERRORS[name])?.code;
    assert.deepEqual(
      Object.keys(ERRORS).map((name) => [name, codeOf(name)]),
      [
        ['auth', 'DATABASE_AUTH_FAILED'],
        ['unreachable', 'DATABASE_UNREACHABLE'],
        ['missing', 'DATABASE_NOT_FOUND'],
        ['tls', 'DATABASE_TLS_FAILED'],
        ['url', 'DATABASE_URL_INVALID'],
        ['tenant', 'DATABASE_AUTH_FAILED'],
        ['supavisor', 'DATABASE_AUTH_FAILED'],
        ['busy', 'DATABASE_BUSY'],
        ['pooler', 'DATABASE_AUTH_FAILED'],
      ],
    );
    assert.match(databaseProblem(ERRORS.pooler).hint, /Connect dialog .*aws-0\/aws-1 is a pooler cluster/);
    assert.match(databaseProblem(ERRORS.pooler).message, /לא מצא את הפרויקט/);
    assert.match(databaseProblem(ERRORS.tenant).hint, /postgres\.<project-ref>/);
    assert.match(databaseProblem(ERRORS.supavisor).hint, /Copy the Session pooler string from the dashboard's Connect dialog as it is/);
    assert.match(databaseProblem(ERRORS.supavisor).message, /^אין גישה למסד הנתונים: שרת החיבורים של Supabase לא מצא את הפרויקט/);
    assert.match(databaseProblem(ERRORS.unreachable).hint, /session pooler.*IPv6/);
    assert.equal(databaseProblem(ERRORS.tls).detail, 'Error opening a TLS connection: self-signed certificate in certificate chain');
    // Not the database's fault: a missing table (that's migrations.js), a unique violation, a bug.
    for (const other of [prismaError('P2021', 'The table `public.users` does not exist in the current database.'), prismaError('P2002', 'Unique constraint failed'), new TypeError('x is undefined'), null]) assert.equal(databaseProblem(other), null);
  });

  test('a request that meets it: 503 with the cause in Hebrew, one error line a minute with the fix, no stack trace', () => {
    const error = console.error;
    const lines = [];
    console.error = (...args) => lines.push(String(args[0]));
    try {
      const answer = (thrown) => {
        const res = { headersSent: false, statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        errorHandler(thrown, { method: 'GET', originalUrl: '/api/auth/me' }, res, () => {});
        return res;
      };
      const first = answer(ERRORS.auth);
      answer(ERRORS.auth);
      answer(ERRORS.tls);
      assert.deepEqual([first.statusCode, first.body.error.code], [503, 'DATABASE_AUTH_FAILED']);
      assert.match(first.body.error.message, /^אין גישה למסד הנתונים: שם המשתמש או הסיסמה/);
      assert.equal(lines.length, 2, 'one line per kind of problem, not per request');
      assert.match(lines[0], /^\[db\] \S+ GET \/api\/auth\/me: The database rejected the user or password .*\(Authentication failed against the database server/);
      assert.ok(lines.every((line) => line.startsWith('[db]')), 'no stack trace');
      // Anything else is still the generic 500: its stack trace in the log, and the request id on both sides.
      const other = answer(new TypeError('x is undefined'));
      assert.deepEqual([other.statusCode, other.body.error.code, lines.length], [500, 'INTERNAL', 3]);
      assert.ok(lines[2].startsWith(`[error] ${other.body.error.requestId} GET /api/auth/me → 500`));
    } finally {
      console.error = error;
    }
  });

  test('TLS: sslmode=require means encrypted (as in libpq), verify-full stays strict, disable and local stay plain', async () => {
    const ca = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'stash-ca-')), 'ca.pem');
    await fs.writeFile(ca, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
    const remote = 'postgresql://postgres.abcd:p%23ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';
    const config = (url, caCert = '') => {
      const settings = poolConfig(url, { poolSize: 5, caCert });
      return { url: settings.connectionString, ssl: settings.ssl ?? null };
    };
    assert.deepEqual(config(remote), { url: remote, ssl: { rejectUnauthorized: false } });
    assert.deepEqual(config(`${remote}?sslmode=require`), { url: remote, ssl: { rejectUnauthorized: false } });
    assert.deepEqual(config(`${remote}?pgbouncer=true&sslmode=require`), { url: `${remote}?pgbouncer=true`, ssl: { rejectUnauthorized: false } });
    assert.deepEqual(config(`${remote}?sslmode=prefer&connect_timeout=10`), { url: `${remote}?connect_timeout=10`, ssl: { rejectUnauthorized: false } });
    assert.deepEqual(config(`${remote}?sslmode=verify-full`), { url: `${remote}?sslmode=verify-full`, ssl: null });
    assert.deepEqual(config(`${remote}?sslmode=verify-full`, ca), { url: remote, ssl: { ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n', rejectUnauthorized: true } });
    assert.deepEqual(config(`${remote}?sslmode=disable`), { url: `${remote}?sslmode=disable`, ssl: null });
    assert.deepEqual(config('postgresql://stash:stash@127.0.0.1:5432/stash'), { url: 'postgresql://stash:stash@127.0.0.1:5432/stash', ssl: null });
    assert.deepEqual(config('postgresql://stash:stash@127.0.0.1:5432/stash?sslmode=require'), { url: 'postgresql://stash:stash@127.0.0.1:5432/stash', ssl: { rejectUnauthorized: false } });
    assert.deepEqual(config('postgresql://u:pa#ss@host/db'), { url: 'postgresql://u:pa#ss@host/db', ssl: null }, 'an invalid URL is left to fail, and be named');
    assert.equal(withoutParam('postgres://h/db?a=1&SSLMODE=require&b=2', 'sslmode'), 'postgres://h/db?a=1&b=2');
  });
});
