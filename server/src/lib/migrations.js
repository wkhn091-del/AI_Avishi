/**
 * Whether the database has Stash's tables: the migrations in prisma/migrations, against the ones Prisma recorded
 * as applied (its _prisma_migrations table). Without them every request that touches the database fails on its
 * own ("The table `public.users` does not exist"), so the server checks at startup and says what to run,
 * /api/health reports it, and a request that hits a missing table gets a 503 saying so (middleware/errorHandler.js).
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { db } from './db.js';
import { databaseProblem } from './dbErrors.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'migrations');
export const MIGRATE_COMMAND = 'npm run db:migrate -w server';

// PostgreSQL's "no such table" (42P01) and "no such column" (42703): P2021 and P2022 from a model query, and the
// PostgreSQL code itself inside a raw query's error (P2010), as the pg driver adapter reports them.
const MISSING = new Set(['42P01', '42703']);
export const isMissingSchema = (error) => ['P2021', 'P2022'].includes(error?.code) || MISSING.has(error?.meta?.driverAdapterError?.cause?.originalCode);

const lastLine = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

/**
 * `{ status, pending, applied, error? }`. status: ready (every migration applied), pending (some aren't, so tables
 * are missing or behind), unreachable (the database didn't answer), or off (no DATABASE_URL).
 */
export async function schemaStatus({ configured = Boolean(config.database.url), query = (sql) => db().$queryRawUnsafe(sql), dir = MIGRATIONS_DIR } = {}) {
  if (!configured) return { status: 'off', pending: [], applied: 0 };
  const expected = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  let applied = [];
  try {
    applied = (await query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).map((row) => row.migration_name);
  } catch (error) {
    // No _prisma_migrations table: no migration was ever applied.
    if (!isMissingSchema(error)) return { status: 'unreachable', pending: expected, applied: 0, error: lastLine(error.message), hint: databaseProblem(error)?.hint ?? '' };
  }
  const done = new Set(applied);
  const pending = expected.filter((name) => !done.has(name));
  return { status: pending.length ? 'pending' : 'ready', pending, applied: expected.length - pending.length };
}

// The last result, for /api/health, which never waits for the database: a status that isn't ready is checked again
// in the background at most every 30 seconds (the migrations may have run since); a ready one stays.
let last = null;
let checking = null;
export function checkSchema() {
  checking ??= schemaStatus()
    .catch((error) => ({ status: 'unreachable', pending: [], applied: 0, error: lastLine(error.message) }))
    .then((status) => {
      last = { at: Date.now(), status };
      checking = null;
      return status;
    });
  return checking;
}
export function schemaState() {
  if (!config.database.url) return 'off';
  if (!last || (last.status.status !== 'ready' && Date.now() - last.at > 30_000)) checkSchema().catch(() => {});
  return last?.status.status ?? 'checking';
}

let warned = null; // { at, skipped }
/** For a request that hit a missing table: one error line, at most a minute apart, with what to run. */
export function warnMissingSchema(where) {
  if (warned && Date.now() - warned.at < 60_000) return void (warned.skipped += 1);
  const skipped = warned?.skipped ?? 0;
  warned = { at: Date.now(), skipped: 0 };
  console.error(`[db] ${where}: the database is missing Stash's tables (its migrations weren't applied). Run ${MIGRATE_COMMAND}; on Render the build runs it (npm run render:build, see README).${skipped ? ` [and ${skipped} more requests since the last line]` : ''}`);
}
