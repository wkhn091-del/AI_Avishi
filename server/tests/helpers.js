import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

/** A fresh temporary directory, removed by the returned cleanup function. */
export async function tempDir(prefix = 'stash-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * Writes a ZIP with the given entries and returns its path.
 * @param {string} dir
 * @param {string} name file name of the archive
 * @param {Record<string, string|Buffer>} entries path → content
 * @param {{ rename?: Record<string, string> }} [options] raw renames applied to the
 *        finished bytes, for entry names AdmZip would sanitise (e.g. "../evil.txt").
 *        Old and new names must have the same length.
 */
export async function makeZip(dir, name, entries, { rename = {} } = {}) {
  const zip = new AdmZip();
  for (const [entryName, content] of Object.entries(entries)) zip.addFile(entryName, Buffer.from(content));
  let bytes = zip.toBuffer();
  for (const [from, to] of Object.entries(rename)) {
    if (from.length !== to.length) throw new Error('rename must keep the name length');
    bytes = Buffer.from(bytes.toString('latin1').split(from).join(to), 'latin1');
  }
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return file;
}

// --- Accounts and the database, for the API tests ------------------------------------------------
//
// Importing this file signs every request to the app under test (http://127.0.0.1) in as OWNER, an
// admin, unless the request brings its own Authorization header. Tokens are signed like a Supabase
// project on the shared secret, with test values that can't match a real project. DATABASE_URL and
// DIRECT_URL from the environment are removed, so a test can never reach a real database: suites that
// need one start their own with startTestDatabase().

export const TEST_AUTH = Object.freeze({
  supabaseUrl: 'https://stash-test.supabase.co',
  publishableKey: 'sb_publishable_test_key',
  jwtSecret: 'test-only-jwt-secret-with-at-least-32-characters',
});
export const OWNER = Object.freeze({ id: '00000000-0000-4000-8000-000000000001', email: 'owner@stash.test' });
export const MEMBER = Object.freeze({ id: '00000000-0000-4000-8000-000000000002', email: 'member@stash.test' });

process.env.SUPABASE_URL = TEST_AUTH.supabaseUrl;
process.env.SUPABASE_PUBLISHABLE_KEY = TEST_AUTH.publishableKey;
process.env.SUPABASE_JWT_SECRET = TEST_AUTH.jwtSecret;
process.env.ADMIN_EMAILS = OWNER.email;
for (const name of ['DATABASE_URL', 'DIRECT_URL', 'DATABASE_CA_CERT', 'SUPABASE_ANON_KEY']) delete process.env[name];

const base64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** A Supabase-style access token for a user (HS256). Options make broken ones for the auth tests. */
export function tokenFor(user = OWNER, { secret = process.env.SUPABASE_JWT_SECRET || TEST_AUTH.jwtSecret, issuer = `${process.env.SUPABASE_URL}/auth/v1`, audience = 'authenticated', expiresIn = 3_600, claims = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({ sub: user.id, email: user.email, aud: audience, iss: issuer, role: 'authenticated', iat: now, exp: now + expiresIn, ...claims });
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}

/** The Authorization header for a user. */
export const authHeader = (user = OWNER) => ({ authorization: `Bearer ${tokenFor(user)}` });

/** fetch without the automatic sign-in. */
export const rawFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  if (!String(url).startsWith('http://127.0.0.1')) return rawFetch(url, init);
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${tokenFor(OWNER)}`);
  return rawFetch(url, { ...init, headers });
};

/**
 * A PostgreSQL database for one test file: PGlite (Postgres compiled to WebAssembly) with the real
 * migrations applied, served on a local port so the app connects to it exactly as to any Postgres.
 * Sets DATABASE_URL; call it before importing the app, and stop() when done.
 */
export async function startTestDatabase() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const pglite = await PGlite.create();
  const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations');
  const names = (await fs.readdir(migrations, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of names) await pglite.exec(await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'));
  const server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0, maxConnections: 100 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
  // PGlite runs one query at a time: one connection keeps it simple.
  process.env.DATABASE_POOL_SIZE = '1';
  return {
    pglite,
    async stop() {
      const { closeDb } = await import('../src/lib/db.js');
      await closeDb();
      await server.stop();
      await pglite.close();
    },
  };
}
