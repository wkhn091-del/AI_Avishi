// The database's tables: whether the migrations are applied (the startup line and /api/health), and the 503 a
// request gets when a table is missing, instead of a stack trace per request.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

const { MIGRATIONS_DIR, isMissingSchema, schemaStatus } = await import('../src/lib/migrations.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

// What Prisma 7 (with the pg driver adapter) throws when a table is missing.
const missing = (code, originalCode) =>
  Object.assign(new Error('Invalid `prisma.user.upsert()` invocation:\n\nThe table `public.users` does not exist in the current database.'), {
    name: 'PrismaClientKnownRequestError',
    code,
    meta: originalCode ? { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode } } } : undefined,
  });

describe('The database schema', () => {
  test('a missing table or column is recognized, from a model query (P2021, P2022) or a raw one (PostgreSQL 42P01, 42703)', () => {
    assert.equal(isMissingSchema(missing('P2021')), true);
    assert.equal(isMissingSchema(missing('P2022')), true);
    assert.equal(isMissingSchema(missing('P2010', '42P01')), true);
    assert.equal(isMissingSchema(missing('P2010', '42703')), true);
    assert.equal(isMissingSchema(missing('P2002')), false);
    assert.equal(isMissingSchema(new Error('connect ECONNREFUSED 127.0.0.1:5432')), false);
    assert.equal(isMissingSchema(null), false);
  });

  test('the migrations against the ones Prisma recorded: ready, behind, never migrated, unreachable, off', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stash-migrations-'));
    for (const name of ['20260101000000_init', '20260102000000_more']) await fs.mkdir(path.join(dir, name));
    await fs.writeFile(path.join(dir, 'migration_lock.toml'), 'provider = "postgresql"\n');
    const recorded =
      (...names) =>
      async () =>
        names.map((migration_name) => ({ migration_name }));
    assert.deepEqual(await schemaStatus({ configured: true, dir, query: recorded('20260101000000_init', '20260102000000_more') }), { status: 'ready', pending: [], applied: 2 });
    assert.deepEqual(await schemaStatus({ configured: true, dir, query: recorded('20260101000000_init') }), { status: 'pending', pending: ['20260102000000_more'], applied: 1 });
    const never = async () => {
      throw missing('P2010', '42P01');
    };
    assert.deepEqual(await schemaStatus({ configured: true, dir, query: never }), { status: 'pending', pending: ['20260101000000_init', '20260102000000_more'], applied: 0 });
    // Unreachable, as Prisma reports it (P1001): the error's own words, and what to change.
    const down = async () => {
      throw Object.assign(new Error("Invalid `prisma.$queryRawUnsafe()` invocation:\n\nCan't reach database server at `db.example.supabase.co:5432`"), {
        code: 'P1001',
        meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable' } } },
      });
    };
    const unreachable = await schemaStatus({ configured: true, dir, query: down });
    assert.deepEqual({ ...unreachable, hint: undefined }, {
      status: 'unreachable',
      pending: ['20260101000000_init', '20260102000000_more'],
      applied: 0,
      error: "Can't reach database server at `db.example.supabase.co:5432`",
      hint: undefined,
    });
    assert.match(unreachable.hint, /session pooler.*IPv6/);
    assert.deepEqual(await schemaStatus({ configured: false }), { status: 'off', pending: [], applied: 0 });
    // The server looks at the project's own migrations.
    assert.ok((await fs.readdir(MIGRATIONS_DIR)).includes('20260927010000_init'));
  });

  test('a request that hits a missing table: 503 with what to run, and one error line a minute instead of a stack trace', () => {
    const error = console.error;
    const lines = [];
    console.error = (...args) => lines.push(String(args[0]));
    try {
      const answer = () => {
        const res = {
          headersSent: false,
          statusCode: 0,
          body: null,
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(body) {
            this.body = body;
            return this;
          },
        };
        errorHandler(missing('P2021'), { method: 'GET', originalUrl: '/api/auth/me' }, res, () => {});
        return res;
      };
      const first = answer();
      answer();
      assert.equal(first.statusCode, 503);
      assert.equal(first.body.error.code, 'DATABASE_NOT_MIGRATED');
      assert.match(first.body.error.message, /^מסד הנתונים עוד לא הוכן: .*\(npm run db:migrate -w server\)/);
      assert.equal(lines.length, 1, 'one line, not one per request');
      assert.match(lines[0], /^\[db\] \S+ GET \/api\/auth\/me: the database is missing Stash's tables .*Run npm run db:migrate -w server/);
    } finally {
      console.error = error;
    }
  });
});
