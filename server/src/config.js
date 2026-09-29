/**
 * Centralised runtime configuration.
 *
 * Values come from environment variables, optionally loaded from `server/.env`
 * (Node's built-in loader — no dotenv dependency). Every other module imports
 * from here instead of reading `process.env`, so all knobs live in one place.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(SERVER_ROOT, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const MB = 1024 * 1024;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number.parseInt(value ?? '', 10);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function flag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

/** Every AI provider Stash can call; the ids are used in AI_PROVIDER, AI_ENSEMBLE and AI_SYNTHESIZER. */
export const AI_PROVIDER_IDS = Object.freeze(['gemini', 'groq', 'openrouter', 'cohere', 'huggingface', 'anthropic', 'openai', 'deepseek', 'moonshot', 'pollinations']);
const env = (name) => process.env[name]?.trim() || '';

// Values copied from .env.example ("your_groq_key", "<key>", "changeme") are not keys:
// they are treated as unset, and the server warns about them at startup.
const PLACEHOLDER = /^(your[_-].*|<.*>|changeme|change[_-]me|xxx+|\.\.\.|todo)$/i;
export const PLACEHOLDER_SETTINGS = [];
const secret = (name) => {
  const value = env(name);
  if (value && PLACEHOLDER.test(value)) {
    PLACEHOLDER_SETTINGS.push(name);
    return '';
  }
  return value;
};

// AI_PROVIDERS: which providers may be used at all (default: every provider with a key).
const enabledProviders = env('AI_PROVIDERS')
  ? env('AI_PROVIDERS').toLowerCase().split(',').map((id) => id.trim()).filter(Boolean)
  : null;
const unknownProviders = (enabledProviders ?? []).filter((id) => !AI_PROVIDER_IDS.includes(id));
if (unknownProviders.length) {
  throw new Error(`AI_PROVIDERS contains unknown providers: ${unknownProviders.join(', ')}. Valid ids: ${AI_PROVIDER_IDS.join(', ')}.`);
}
// AI_PROVIDER picks the primary provider (empty or "auto": the first configured one); "none" turns AI off.
const aiProvider = env('AI_PROVIDER').toLowerCase() || 'auto';
if (!['auto', 'none', ...AI_PROVIDER_IDS].includes(aiProvider)) {
  throw new Error(`AI_PROVIDER must be one of auto, none, ${AI_PROVIDER_IDS.join(', ')} (got "${aiProvider}").`);
}
// AI_API_KEY and AI_MODEL, the original single-provider settings, still apply to the AI_PROVIDER provider.
const aiKey = (id, name) => secret(name) || (aiProvider === id ? secret('AI_API_KEY') : '');
const aiModel = (id, name) => env(name) || (aiProvider === id ? env('AI_MODEL') : '');

const storageRoot = path.resolve(SERVER_ROOT, process.env.STORAGE_DIR || 'storage');

/**
 * CORS_ORIGINS, comma-separated: origins (scheme, host, optional port, no path), each exact or with * standing for
 * part of one host label. A * that is a whole label, or in a two-label host, is refused: it would take in every site
 * of a shared domain (anyone can deploy to vercel.app).
 */
function parseOrigins(value = '') {
  const origins = [];
  const rejected = [];
  for (const origin of String(value).split(',').map((item) => item.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean)) {
    const match = /^(https?):\/\/([a-z0-9*.-]+)(:\d{1,5})?$/.exec(origin);
    const labels = match?.[2].split('.') ?? [];
    if (!match || labels.some((label) => label === '' || label === '*') || (origin.includes('*') && labels.length < 3)) rejected.push(origin);
    else origins.push(origin);
  }
  return { origins, rejected };
}
const ORIGINS = parseOrigins(process.env.CORS_ORIGINS);

export const config = Object.freeze({
  logRequests: process.env.LOG_REQUESTS === undefined || flag(process.env.LOG_REQUESTS),
  github: Object.freeze({ token: secret('GITHUB_TOKEN') }),
  environment: env('NODE_ENV') || 'development',
  // Bound to loopback by default: the API has no authentication, so it must
  // not be reachable from the LAN unless you explicitly opt in (HOST=0.0.0.0).
  host: process.env.HOST || '127.0.0.1',
  port: positiveInt(process.env.PORT, 4000),

  // Extra hostnames allowed in the Host header (localhost and IP addresses are
  // always allowed). Blocks DNS-rebinding attacks from malicious websites.
  allowedHosts: Object.freeze(
    (process.env.ALLOWED_HOSTS || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ),

  // The browser app's origins when it's served from elsewhere (the app on Vercel, this API on Render): CORS for them,
  // and the cross-site guard lets their requests through (lib/origins.js). Exact origins, or * inside one host label
  // for preview deployments (https://stash-*-me.vercel.app); a whole-label * (https://*.vercel.app) is refused.
  corsOrigins: Object.freeze(ORIGINS.origins),
  corsRejected: Object.freeze(ORIGINS.rejected),

  // `npm start` passes --serve-client so Express also serves the built SPA.
  serveClient: process.argv.includes('--serve-client') || env('NODE_ENV') === 'production',

  paths: Object.freeze({
    storage: storageRoot,
    database: path.join(storageRoot, 'db.json'),
    archives: path.join(storageRoot, 'archives'),
    files: path.join(storageRoot, 'files'),
    media: path.join(storageRoot, 'media'),
    bundles: path.join(storageRoot, 'bundles'),
    attachments: path.join(storageRoot, 'attachments'),
    clientDist: path.resolve(SERVER_ROOT, '..', 'client', 'dist'),
  }),

  limits: Object.freeze({
    archiveBytes: positiveInt(process.env.MAX_ZIP_MB, 250) * MB,
    fileBytes: positiveInt(process.env.MAX_FILE_MB, 500) * MB,
    filesPerUpload: 20,
  }),

  ai: Object.freeze({
    provider: aiProvider,
    keys: Object.freeze({
      gemini: aiKey('gemini', 'GEMINI_API_KEY'),
      groq: aiKey('groq', 'GROQ_API_KEY'),
      openrouter: aiKey('openrouter', 'OPENROUTER_API_KEY'),
      cohere: aiKey('cohere', 'COHERE_API_KEY'),
      huggingface: aiKey('huggingface', 'HF_API_KEY') || secret('HF_TOKEN'),
      anthropic: aiKey('anthropic', 'ANTHROPIC_API_KEY'),
      openai: aiKey('openai', 'OPENAI_API_KEY'),
      deepseek: aiKey('deepseek', 'DEEPSEEK_API_KEY'),
      moonshot: aiKey('moonshot', 'MOONSHOT_API_KEY'),
      pollinations: aiKey('pollinations', 'POLLINATIONS_API_KEY'),
    }),
    enabled: enabledProviders ? Object.freeze(enabledProviders) : null,
    models: Object.freeze({
      gemini: aiModel('gemini', 'GEMINI_MODEL'),
      groq: aiModel('groq', 'GROQ_MODEL'),
      openrouter: aiModel('openrouter', 'OPENROUTER_MODEL'),
      cohere: aiModel('cohere', 'COHERE_MODEL'),
      huggingface: aiModel('huggingface', 'HF_MODEL'),
      anthropic: aiModel('anthropic', 'ANTHROPIC_MODEL'),
      openai: aiModel('openai', 'OPENAI_MODEL'),
      deepseek: aiModel('deepseek', 'DEEPSEEK_MODEL'),
      moonshot: aiModel('moonshot', 'MOONSHOT_MODEL'),
      pollinations: aiModel('pollinations', 'POLLINATIONS_TEXT_MODEL'),
    }),
    // Project summaries: "free" asks every configured free provider at once, "all" every configured
    // provider, "off" only the primary one; or list provider ids, e.g. "gemini,groq,cohere".
    ensemble: env('AI_ENSEMBLE').toLowerCase() || 'free',
    // The provider that merges the ensemble's answers (default: the primary provider).
    synthesizer: env('AI_SYNTHESIZER').toLowerCase(),
    timeoutMs: positiveInt(process.env.AI_TIMEOUT_MS, 30_000),
    // Retries for temporary failures (429, 5xx, dropped connections): waits of base, 2×base, 4×base…
    maxRetries: Math.min(nonNegativeInt(process.env.AI_MAX_RETRIES, 3), 8),
    retryBaseMs: positiveInt(process.env.AI_RETRY_BASE_MS, 2_000),
  }),

  pricing: Object.freeze({
    // {"model-id": {"input": 4, "output": 20, "cached": 0.2}} in USD per 1M tokens, added to or replacing the built-in prices.
    overrides: (() => {
      const raw = env('MODEL_PRICES');
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        return Object.fromEntries(
          Object.entries(parsed).filter(([, rate]) => rate && Number.isFinite(rate.input) && Number.isFinite(rate.output)),
        );
      } catch {
        console.warn('[config] MODEL_PRICES is not valid JSON; using the built-in prices.');
        return {};
      }
    })(),
    // Providers whose usage costs nothing here (for example a Gemini key on the free tier).
    freeProviders: env('COST_FREE_PROVIDERS').split(',').map((id) => id.trim().toLowerCase()).filter(Boolean),
  }),
  chat: Object.freeze({
    // The model that rates each premium request's complexity for the auto-router.
    routerModel: env('ROUTER_MODEL') || 'gemini-flash-latest',
    // Every N turns the conversation is compacted into project_state.md; the last K messages stay.
    compactEvery: positiveInt(process.env.CHAT_COMPACT_EVERY, 10),
    keepRecent: positiveInt(process.env.CHAT_KEEP_RECENT, 3),
    // A cut-off answer (length limit) is continued automatically this many times; 0 turns it off.
    autoContinueMax: /^\d+$/.test(env('AUTO_CONTINUE_MAX')) ? Number(env('AUTO_CONTINUE_MAX')) : 4,
    // After the first answer, standard follow-ups and continuations move to a cheaper model.
    handoff: env('CHAT_HANDOFF').toLowerCase() !== 'off',
    // Code ZIPs are temporary files; an expired one is rebuilt from the answer when downloaded.
    bundleTtlHours: positiveInt(process.env.BUNDLE_TTL_HOURS, 24),
    imageMaxMb: positiveInt(process.env.CHAT_IMAGE_MAX_MB, 5),
    videoMaxMb: positiveInt(process.env.CHAT_VIDEO_MAX_MB, 100),
    // Videos up to this size are sent inline to Gemini; larger ones go through its Files API.
    geminiInlineMaxMb: Number(env('GEMINI_INLINE_MAX_MB')) > 0 ? Number(env('GEMINI_INLINE_MAX_MB')) : 14,
    // The development team for complex coding requests (the swarm: blueprint, parallel file agents, QA compiler); PIPELINE=off turns it off.
    pipeline: Object.freeze({
      enabled: env('PIPELINE').toLowerCase() !== 'off',
      // Coding requests the router rates at least this complex go to the team.
      minComplexity: Math.min(10, positiveInt(process.env.PIPELINE_MIN_COMPLEXITY, 7)),
      // The model that takes each role first (catalog ids); a role falls back to the next model with a key.
      architect: env('PIPELINE_ARCHITECT') || 'gpt-6-sol',
      architectFallback: env('PIPELINE_ARCHITECT_FALLBACK') || 'opus-5.5',
      builder: env('PIPELINE_BUILDER') || env('PIPELINE_BACKEND') || 'deepseek-flash',
      reviewer: env('PIPELINE_REVIEWER') || 'sonnet-5',
      // Files written at the same time, the most files a plan may have, each file's output limit, and QA fix rounds.
      concurrency: Math.min(32, positiveInt(process.env.PIPELINE_CONCURRENCY, 8)),
      maxFiles: Math.min(200, positiveInt(process.env.PIPELINE_MAX_FILES, 60)),
      fileTokens: Math.min(65_536, Math.max(1_024, positiveInt(process.env.PIPELINE_FILE_TOKENS, 8_192))),
      qaRounds: /^\d+$/.test(env('PIPELINE_QA_ROUNDS')) ? Math.min(5, Number(env('PIPELINE_QA_ROUNDS'))) : 3,
    }),
  }),

  // The sandbox the development team builds and runs its projects in (services/ai/swarm/sandbox): off,
  // docker (self-hosted, through the docker CLI) or e2b (hosted microVMs, E2B_API_KEY). Admins only by default.
  sandbox: Object.freeze({
    provider: ['docker', 'e2b'].includes(env('SANDBOX').toLowerCase()) ? env('SANDBOX').toLowerCase() : 'off',
    access: env('SANDBOX_ACCESS').toLowerCase() === 'everyone' ? 'everyone' : 'admins',
    // Fix rounds driven by the sandbox's errors, projects in the sandbox at once, and the time limits.
    rounds: /^\d+$/.test(env('SANDBOX_ROUNDS')) ? Math.min(3, Number(env('SANDBOX_ROUNDS'))) : 2,
    maxRuns: Math.min(16, positiveInt(process.env.SANDBOX_MAX_RUNS, 2)),
    stepSeconds: Math.min(1_800, positiveInt(process.env.SANDBOX_STEP_SECONDS, 300)),
    startSeconds: Math.min(60, positiveInt(process.env.SANDBOX_START_SECONDS, 8)),
    lifetimeSeconds: 1_800,
    // Live previews (services/ai/swarm/preview.js): after a run, the sandbox keeps the project's dev server up for
    // the artifact's Preview tab: SANDBOX_PREVIEW_MINUTES after it was made, edited or last used, at most
    // SANDBOX_PREVIEW_MAX_MINUTES in all, SANDBOX_MAX_PREVIEWS at once. SANDBOX_PREVIEW=off turns them off.
    preview: Object.freeze({
      enabled: env('SANDBOX_PREVIEW').toLowerCase() !== 'off',
      minutes: Math.min(120, positiveInt(process.env.SANDBOX_PREVIEW_MINUTES, 15)),
      maxMinutes: Math.min(480, positiveInt(process.env.SANDBOX_PREVIEW_MAX_MINUTES, 60)),
      max: Math.min(32, positiveInt(process.env.SANDBOX_MAX_PREVIEWS, 4)),
      port: Math.min(65_535, positiveInt(process.env.SANDBOX_PREVIEW_PORT, 5173)),
      readySeconds: Math.min(300, positiveInt(process.env.SANDBOX_PREVIEW_READY_SECONDS, 90)),
    }),
    docker: Object.freeze({
      cli: env('SANDBOX_DOCKER_CLI') || 'docker',
      image: env('SANDBOX_DOCKER_IMAGE') || 'node:22-bookworm',
      memoryMb: positiveInt(process.env.SANDBOX_MEMORY_MB, 2_048),
      cpus: Number(env('SANDBOX_CPUS')) > 0 ? Number(env('SANDBOX_CPUS')) : 2,
      network: env('SANDBOX_DOCKER_NETWORK') || 'bridge',
      runtime: env('SANDBOX_DOCKER_RUNTIME'),
    }),
    e2b: Object.freeze({ apiKey: env('E2B_API_KEY'), template: env('SANDBOX_E2B_TEMPLATE') }),
  }),

  // Credits: what each person may spend on AI (services/credits.js). New accounts start with 50 (the users
  // table's default), admins aren't charged, and CREDITS=off turns credits off.
  credits: Object.freeze({
    enabled: env('CREDITS').toLowerCase() !== 'off',
    // A premium answer; the free workspace costs nothing (but needs a balance above zero, like everything).
    perAnswer: /^\d+$/.test(env('CREDITS_PER_ANSWER')) ? Number(env('CREDITS_PER_ANSWER')) : 1,
    // The development team: each file of the architect's blueprint, instead of the answer's price.
    perFile: /^\d+$/.test(env('CREDITS_PER_FILE')) ? Number(env('CREDITS_PER_FILE')) : 1,
    // Each image, speech, music or video from the media studio.
    perMedia: /^\d+$/.test(env('CREDITS_PER_MEDIA')) ? Number(env('CREDITS_PER_MEDIA')) : 1,
    // Where the upgrade dialog's button leads (a pricing or checkout page); without it, the dialog says to ask the admin.
    upgradeUrl: /^https?:\/\//.test(env('CREDITS_UPGRADE_URL')) ? env('CREDITS_UPGRADE_URL') : '',
  }),

  // The database: PostgreSQL through Prisma. DATABASE_URL is the server's connection (on Supabase the session
  // pooler, or the transaction pooler for serverless hosting); DIRECT_URL is for migrations (prisma.config.mjs).
  database: Object.freeze({
    url: env('DATABASE_URL'),
    directUrl: env('DIRECT_URL'),
    poolSize: Math.min(50, positiveInt(process.env.DATABASE_POOL_SIZE, 5)),
    // A CA certificate to verify the database server with (for Supabase: Database Settings > SSL Configuration).
    caCert: env('DATABASE_CA_CERT') ? path.resolve(SERVER_ROOT, env('DATABASE_CA_CERT')) : '',
  }),

  // Accounts: Supabase Auth. The project URL and publishable key (Project Settings > API Keys) are public;
  // the legacy JWT secret is only for projects that still sign tokens with a shared secret.
  auth: Object.freeze({
    supabaseUrl: env('SUPABASE_URL').replace(/\/+$/, ''),
    publishableKey: secret('SUPABASE_PUBLISHABLE_KEY') || secret('SUPABASE_ANON_KEY'),
    jwtSecret: secret('SUPABASE_JWT_SECRET'),
    // Signs the read-only links a browser app on another origin uses for images, downloads and live updates
    // (lib/resourceTokens.js). Without it, a random key per run of the server: links end with a restart.
    resourceSecret: secret('RESOURCE_TOKEN_SECRET'),
    // People who may use the single-person tools too (projects, GitHub, files, links).
    adminEmails: env('ADMIN_EMAILS')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  }),

  // Live web research before the answer, when the router finds that the request needs current information.
  research: Object.freeze({
    enabled: env('WEB_RESEARCH').toLowerCase() !== 'off',
    tavilyKey: secret('TAVILY_API_KEY'),
    // basic costs 1 Tavily credit per search, advanced 2 (fast and ultra-fast 1).
    depth: ['basic', 'advanced', 'fast', 'ultra-fast'].includes(env('WEB_RESEARCH_DEPTH')) ? env('WEB_RESEARCH_DEPTH') : 'basic',
    maxResults: Math.min(10, positiveInt(process.env.WEB_RESEARCH_RESULTS, 5)),
    // The same search within this many minutes reuses its results; 0 turns the cache off.
    cacheMinutes: nonNegativeInt(process.env.WEB_RESEARCH_CACHE_MINUTES, 60),
  }),

  // Long-term memory: what the chat learns about the person, kept across conversations.
  longTermMemory: Object.freeze({
    enabled: env('LONG_TERM_MEMORY').toLowerCase() !== 'off',
    // Vectors for semantic search: auto (Gemini, then OpenAI), gemini, openai, or off (matching words instead).
    embeddings: ['gemini', 'openai', 'off'].includes(env('MEMORY_EMBEDDINGS').toLowerCase()) ? env('MEMORY_EMBEDDINGS').toLowerCase() : 'auto',
    geminiEmbeddingModel: env('GEMINI_EMBEDDING_MODEL') || 'gemini-embedding-001',
    openaiEmbeddingModel: env('OPENAI_EMBEDDING_MODEL') || 'text-embedding-3-small',
    // The cheap model that writes down what an exchange taught (a catalog id); falls back to other cheap models.
    learner: env('MEMORY_LEARNER') || 'gpt-4o-mini',
  }),

  media: Object.freeze({
    // Pollinations secret key (sk_…) for the media studio: images, speech, music and video.
    pollinationsKey: secret('POLLINATIONS_API_KEY'),
    // Video can take minutes to render.
    timeoutMs: positiveInt(process.env.MEDIA_TIMEOUT_MS, 300_000),
  }),

  links: Object.freeze({
    // Private/loopback addresses are never fetched unless explicitly allowed
    // (the link is still saved; only the metadata request is skipped).
    allowPrivateNetwork: flag(process.env.ALLOW_PRIVATE_NETWORK_URLS),
    timeoutMs: positiveInt(process.env.LINK_FETCH_TIMEOUT_MS, 8_000),
  }),
});
