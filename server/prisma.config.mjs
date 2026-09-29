// The Prisma CLI's settings (migrations, generating the client): where the schema and migrations are,
// and which database migrations run against.
//
// Supabase: use the direct connection or the session pooler (port 5432) for DIRECT_URL. Migrations
// can't run through the transaction pooler (port 6543). The server itself connects with DATABASE_URL
// (src/lib/db.js), which may be the pooler.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  // Prisma 7 doesn't read .env by itself: use the server's. Variables already set are kept.
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // no .env: the environment has the values
}

export default defineConfig({
  schema: path.join(root, 'prisma', 'schema.prisma'),
  migrations: { path: path.join(root, 'prisma', 'migrations') },
  datasource: { url: process.env.DIRECT_URL || process.env.DATABASE_URL || '' },
});
