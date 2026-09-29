/**
 * The database: PostgreSQL through Prisma, with the pg driver adapter.
 *
 * DATABASE_URL is the connection the running server uses. On Supabase that's the session pooler
 * (port 5432) for a long-running server, or the transaction pooler (port 6543) for serverless
 * hosting. Migrations use DIRECT_URL instead (prisma.config.mjs).
 *
 * Connections to a database on another machine are encrypted. With DATABASE_CA_CERT (for Supabase,
 * the certificate from Database Settings > SSL Configuration) the server's certificate is verified
 * too. The URL's sslmode is honored the way libpq reads it (see poolConfig).
 *
 * The client is created on first use, so routes that don't need the database (and their tests)
 * run without one.
 */
import fs from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { config } from '../config.js';
import { HttpError } from './httpError.js';

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/** A URL without one query parameter, the rest byte for byte (a password stays exactly as it was written). */
export const withoutParam = (url, name) => url.replace(new RegExp(`([?&])${name}=[^&#]*(&?)`, 'i'), (match, lead, tail) => (tail ? lead : '')).replace(/[?&]$/, '');

/**
 * The pg settings for a connection string: pool size, and TLS. A database on another machine is encrypted, and
 * verified when DATABASE_CA_CERT is set. The URL's sslmode keeps its libpq meaning: disable turns TLS off, and
 * verify-ca or verify-full without DATABASE_CA_CERT keep node-postgres's strict check against the system's
 * authorities. require, prefer and allow mean encrypted: node-postgres alone would read them as verify-full and
 * refuse a certificate the system doesn't trust (Supabase's), so they leave the URL and the settings below apply
 * (settings from the URL would override them).
 */
export function poolConfig(url, { poolSize = config.database.poolSize, caCert = config.database.caCert } = {}) {
  const settings = { connectionString: url, max: poolSize };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return settings;
  }
  const mode = (parsed.searchParams.get('sslmode') ?? '').toLowerCase();
  const verify = mode === 'verify-ca' || mode === 'verify-full';
  if (mode === 'disable' || (!mode && LOCAL.test(parsed.hostname)) || (verify && !caCert)) return settings;
  if (mode) settings.connectionString = withoutParam(url, 'sslmode');
  settings.ssl = caCert ? { ca: fs.readFileSync(caCert, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false };
  return settings;
}

let client = null;

/** The Prisma client (created on first use). Throws a 503 when DATABASE_URL isn't set. */
export function db() {
  if (!client) {
    if (!config.database.url) throw new HttpError(503, 'מסד הנתונים לא מוגדר: הגדירו DATABASE_URL בקובץ server/.env.', 'DATABASE_NOT_CONFIGURED');
    client = new PrismaClient({ adapter: new PrismaPg(poolConfig(config.database.url)) });
  }
  return client;
}

/** For the tests: use another client (for example one connected to PGlite). */
export function useDb(prisma) {
  client = prisma;
}

export async function closeDb() {
  const current = client;
  client = null;
  await current?.$disconnect();
}
