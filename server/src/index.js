/**
 * Server entry point: prepares storage, opens the database and starts HTTP.
 *
 *   npm run dev -w server   API only, restarts on changes (Vite serves the UI)
 *   npm start               builds the client and serves UI + API on one port
 */
import fs from 'node:fs/promises';
import { createApp } from './app.js';
import { PLACEHOLDER_SETTINGS, config } from './config.js';
import { JsonStore } from './lib/jsonStore.js';
import { getAiStatus } from './services/ai/llmClient.js';
import { closeDb } from './lib/db.js';
import { closeAllPreviews, upgradePreview } from './services/ai/swarm/preview.js';
import { authConfigured } from './middleware/auth.js';
import { MIGRATE_COMMAND, checkSchema } from './lib/migrations.js';

await Promise.all([config.paths.archives, config.paths.files].map((dir) => fs.mkdir(dir, { recursive: true })));

const store = new JsonStore(config.paths.database);
await store.init();

const app = createApp({ store });
const hostLabel = config.host.includes(':') ? `[${config.host}]` : config.host;

const server = app.listen(config.port, config.host, (error) => {
  if (error) {
    const hint = error.code === 'EADDRINUSE' ? ` Port ${config.port} is in use — set PORT in server/.env.` : '';
    console.error(`Could not start the server: ${error.message}.${hint}`);
    process.exit(1);
  }

  console.log(`Stash ${config.serveClient ? 'app' : 'API'} → http://${hostLabel}:${config.port}`);
  console.log(`Storage → ${config.paths.storage}`);
  console.log(`Live previews → http://p-<project id>.localhost:${config.port}`);

  const ai = getAiStatus();
  const configured = ai.providers.filter((provider) => provider.configured);
  const nameOf = (id) => ai.providers.find((provider) => provider.id === id)?.name ?? id;
  if (ai.missingKey) console.warn(`AI_PROVIDER is "${config.ai.provider}" but that provider has no API key.`);
  if (!ai.enabled) {
    console.log(ai.off ? 'AI → off (AI_PROVIDER=none).' : 'AI → off (built-in summaries). Add a provider key, e.g. GEMINI_API_KEY or GROQ_API_KEY, in server/.env.');
  } else if (ai.ensemble.length > 1) {
    console.log(`AI summaries → ensemble of ${ai.ensemble.length}: ${ai.ensemble.map(nameOf).join(', ')} (merged by ${nameOf(ai.synthesizer)})`);
  } else {
    console.log(`AI summaries → ${ai.providerName} (${ai.model})`);
  }
  const workspace = (name) => configured.filter((provider) => provider.workspace === name).map((provider) => provider.name).join(', ') || 'none';
  if (ai.enabled) console.log(`AI chat → free workspace: ${workspace('free')}; premium workspace: ${workspace('premium')}`);
  if (PLACEHOLDER_SETTINGS.length) console.warn(`Ignoring example values in server/.env: ${PLACEHOLDER_SETTINGS.join(', ')}.`);
  console.log(config.media.pollinationsKey ? 'Media studio → Pollinations' : 'Media studio → off. Add POLLINATIONS_API_KEY in server/.env.');

  // Settings a deployed server can't do without: each one missing is named, and the server still runs, answering
  // what needs them with a JSON 503 that the app shows as a notice (AUTH_NOT_CONFIGURED, DATABASE_NOT_CONFIGURED).
  const missingAuth = [!config.auth.supabaseUrl && 'SUPABASE_URL', !config.auth.publishableKey && 'SUPABASE_PUBLISHABLE_KEY'].filter(Boolean);
  if (!missingAuth.length) console.log(`Accounts → Supabase Auth (${config.auth.supabaseUrl})`);
  else console.warn(`Accounts → not set up: ${missingAuth.join(' and ')} ${missingAuth.length > 1 ? 'are' : 'is'} missing (in server/.env, or the host's environment settings). The server runs, but every API request is answered 503 AUTH_NOT_CONFIGURED, and the app shows a setup notice.`);
  if (config.auth.supabaseUrl && !/^https:\/\/[^/\s]+$/.test(config.auth.supabaseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.auth.supabaseUrl)) {
    console.warn(`SUPABASE_URL should be the project's address, https://<project-ref>.supabase.co, not "${config.auth.supabaseUrl}".`);
  }
  if (config.database.url) reportSchema();
  else console.warn('Database → not set up: DATABASE_URL is missing. Chats, memories and credits answer 503 DATABASE_NOT_CONFIGURED until it is set.');
  if (config.corsOrigins.length) console.log(`CORS → the browser app may call this API from ${config.corsOrigins.join(', ')}`);
  if (config.corsRejected.length) console.warn(`CORS_ORIGINS: ignoring ${config.corsRejected.join(', ')} (an origin is https://host or https://host:port, with * only inside one part of the host name).`);
  if (config.corsOrigins.length && !config.auth.resourceSecret) {
    console.warn('RESOURCE_TOKEN_SECRET is not set: the links the app on another origin uses for images, downloads and live updates stop working at every restart, until the page reloads. Set it to a long random string.');
  }
});

// Errors nothing caught, logged whole (Render shows them as errors). A rejected promise leaves the server running; an
// exception that reached the top may have left it in a bad state, so it shuts down with a failure code and the host
// starts it again.
process.on('unhandledRejection', (reason) => console.error('[fatal] A promise was rejected and nothing handled it:', reason));
process.on('uncaughtException', (error) => {
  console.error('[fatal] Uncaught exception, shutting down:', error);
  process.exitCode = 1;
  shutdown('uncaughtException');
});

/** The startup line about the database, once it answered: its tables up to date (every migration applied), or what to run. */
async function reportSchema() {
  const schema = await checkSchema();
  if (schema.status === 'ready') return console.log(`Database → PostgreSQL (Prisma), tables up to date (${schema.applied} migrations applied)`);
  if (schema.status === 'pending') {
    const count = schema.pending.length === 1 ? '1 migration is' : `${schema.pending.length} migrations are`;
    return console.warn(`Database → PostgreSQL (Prisma), but ${count} not applied (${schema.pending.join(', ')}): its tables are missing or behind, and requests that need them answer 503 until you run ${MIGRATE_COMMAND}.`);
  }
  console.warn(`Database → PostgreSQL (Prisma), but it can't be used: ${schema.error}${schema.hint ? `. ${schema.hint}` : ''}`);
}

// WebSockets are only for live previews (the generated app's hot reload); anything else is closed.
server.on('upgrade', (req, socket, head) => {
  if (!upgradePreview(req, socket, head)) socket.destroy();
});

/** Finish in-flight requests and pending database writes before exiting. */
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  setTimeout(() => process.exit(1), 5_000).unref();
  // Live previews first, not once the server has closed: an open preview WebSocket (hot reload) would keep
  // server.close() waiting past the 5 seconds, and their sandboxes would outlive the server.
  const previews = closeAllPreviews().catch(() => {});
  server.close(async () => {
    await previews;
    await store.flush();
    await closeDb().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
