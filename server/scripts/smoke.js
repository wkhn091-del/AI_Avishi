#!/usr/bin/env node
/**
 * Smoke test of the AI gateway against the real providers, with the keys in
 * server/.env. Every check is cheap: short prompts, capped answers and each
 * provider's cheapest model (a few thousand tokens in all, more with a video).
 *
 *   npm run smoke                                   from the project root
 *   npm run smoke -- --video path/to/clip.mp4       also send a video to Gemini
 *   npm run smoke -- --video clip.mp4 --files-api   through Gemini's Files API even if it's small
 *   npm run smoke -- --team --sandbox               also a project through the team, and one in the sandbox
 *
 *   1. Model ids      every premium model in the catalog is listed by its provider
 *   2. Length limit   each provider reports "stopped at the limit", which is what starts auto-continue
 *   3. Auto-continue  an answer cut off on purpose (at 600 tokens) is continued (on the cheap model when the handoff
 *                     is on), streamed as one text, and its code files come out whole
 *   4. Images         each provider's cheapest vision model names the color of a generated image
 *   5. Router         what the auto-router picks for sample Hebrew requests, and the handoff model
 *   6. Video          with --video: inline, or through Gemini's Files API
 *   7. The team       with --team: one small project through the development team (a few cents)
 *   8. Web research   one Tavily search (1 credit): results, and how many came with the page's text
 *   9. Accounts       Supabase's keys and publishable key, the admins; PostgreSQL, its migrations and row level security
 *  10. Memory         embeddings (related texts must score closer than unrelated ones), and the model that learns
 *  11. The sandbox    with --sandbox: a tiny project installed, tested and started in it, and its internet cut after the install
 *
 * Prints ✓ (passed), ⚠ (worth a look), ✗ (failed) or – (skipped) for each check, and exits
 * with 1 when a check failed. Keys are never printed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { config } from '../src/config.js';
import { isConfigured, liveModelIds, streamChat } from '../src/services/ai/llmClient.js';
import { PREMIUM_MODELS, premiumModel, teamFor } from '../src/services/ai/catalog.js';
import { manifestFiles, validateBlueprint } from '../src/services/ai/swarm/blueprint.js';
import { openSandbox } from '../src/services/ai/swarm/sandbox/index.js';
import { stepsSummary, verifyProject } from '../src/services/ai/swarm/verify.js';
import { costOf } from '../src/services/ai/pricing.js';
import { createMeter } from '../src/services/ai/usageMeter.js';
import { db, closeDb } from '../src/lib/db.js';
import { authConfigured } from '../src/middleware/auth.js';
import { THRESHOLDS, cosine, embed, embedder } from '../src/services/memory/embeddings.js';
import { learnerModel } from '../src/services/memory/learner.js';
import { researchAvailable, searchWeb } from '../src/services/research/webSearch.js';
import { providerById } from '../src/services/ai/providers.js';
import { pickPremium, pickWorkhorse, rateRequest, tierFor } from '../src/services/ai/router.js';
import { BASE_SYSTEM, insideCodeBlock, runTurn } from '../src/services/ai/orchestrator.js';
import { uploadToGemini } from '../src/services/ai/geminiFiles.js';
import { VIDEO_TYPES } from '../src/services/chat/attachments.js';
import { extractCodeFiles } from '../src/services/chat/codeBundles.js';

const USAGE = `Usage: npm run smoke [-- [--team] [--sandbox] [--video <file> [--files-api]]]
  --team           also send one small project through the development team (a few cents)
  --sandbox        also install, test and start a tiny project in the sandbox (SANDBOX=docker or e2b)
  --video <file>   also send this video to Gemini (MP4, WebM, MOV, MPEG, AVI or 3GP)
  --files-api      send it through Gemini's Files API even when it's small enough to go inline`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const videoArg = args.includes('--video') ? args[args.indexOf('--video') + 1] : null;
if (args.includes('--video') && (!videoArg || videoArg.startsWith('--'))) {
  console.log(USAGE);
  process.exit(1);
}
// npm runs the script from server/, so a relative path is taken from where npm was started.
const videoPath = videoArg ? path.resolve(process.env.INIT_CWD ?? process.cwd(), videoArg) : null;
const forceFiles = args.includes('--files-api');

const MB = 1024 * 1024;
const TRUNCATED = /^(length|max_tokens|max_output_tokens)$/i;
const CHEAPEST = { anthropic: 'haiku-4.5', openai: 'gpt-4o-mini', gemini: 'gemini-flash-lite', deepseek: 'deepseek-flash', moonshot: 'kimi-k2.6' };
const VISION = { anthropic: 'haiku-4.5', openai: 'gpt-4o-mini', gemini: 'gemini-flash-lite', deepseek: 'deepseek-flash' };
const SAMPLES = [
  { label: 'quick question', text: 'מה השעה עכשיו בטוקיו?', tiers: ['standard'] },
  { label: 'small code task', text: 'כתוב פונקציית debounce ב-JavaScript עם הסבר קצר', tiers: ['standard', 'advancedCode'] },
  { label: 'full landing page', text: 'בנה דף נחיתה מלא לסטודיו לעיצוב, עם HTML, CSS ו-JavaScript בקבצים נפרדים', tiers: ['massiveCode'] },
  {
    label: 'architecture plan',
    text: 'תכנן ארכיטקטורה מלאה למערכת הזמנות עם תשלומים, התראות, ניהול משתמשים והרשאות, כולל סכמת מסד נתונים ושיקולי סקייל',
    tiers: ['extreme', 'advanced', 'advancedCode', 'advancedMath'],
  },
];

// --- Output -----------------------------------------------------------------------------------

const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
const MARKS = { pass: '✓', warn: '⚠', fail: '✗', skip: '–' };
const COLORS = { pass: 32, warn: 33, fail: 31, skip: 90 };
const paint = (status, text) => (process.stdout.isTTY ? `\x1b[${COLORS[status]}m${text}\x1b[0m` : text);
function report(status, label, detail = '') {
  counts[status] += 1;
  console.log(`  ${paint(status, MARKS[status])} ${label}${detail ? `  ${paint('skip', detail)}` : ''}`);
}
const section = (title) => console.log(`\n${title}`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const problemOf = (error) => error.log ?? error.message;
async function timed(run) {
  const started = Date.now();
  const value = await run();
  return [value, Date.now() - started];
}
const ask = (entry, messages, maxTokens) => timed(() => streamChat({ provider: entry.provider, model: entry.model, messages, params: { maxTokens }, onDelta: () => {} }));

// --- A PNG of one color, without an image library ---------------------------------------------

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function solidPng(width, height, [red, green, blue]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3); // each row starts with filter type 0
  for (let x = 0; x < width; x += 1) row.set([red, green, blue], 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}

// --- The checks -------------------------------------------------------------------------------

const providers = [...new Set(PREMIUM_MODELS.map((entry) => entry.provider))].filter(isConfigured);
if (!providers.length) {
  console.log('No premium keys in server/.env (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY): nothing to check.');
  process.exit(1);
}
console.log(`Stash smoke test against the real APIs. Keys found: ${providers.map((id) => providerById(id).name).join(', ')}.`);
console.log('Short prompts on the cheapest models: a few thousand tokens in all.');

section('1. Model ids (the catalog against each provider\'s own list)');
for (const id of providers) {
  const models = PREMIUM_MODELS.filter((entry) => entry.provider === id);
  try {
    const live = new Set(await liveModelIds(id));
    const missing = models.filter((entry) => !live.has(entry.model));
    if (!missing.length) report('pass', providerById(id).name, models.map((entry) => entry.model).join(', '));
    else report('warn', providerById(id).name, `not listed: ${missing.map((entry) => entry.model).join(', ')} (an alias can still work; the calls below use the ids directly)`);
  } catch (error) {
    report('warn', providerById(id).name, `couldn't list the models (${problemOf(error)})`);
  }
}

section('2. Stopping at the length limit (this starts auto-continue)');
for (const id of providers) {
  const entry = premiumModel(CHEAPEST[id]);
  try {
    const [result, ms] = await ask(entry, [{ role: 'user', content: 'Write the numbers from 1 to 1000, separated by commas. Nothing else.' }], 120);
    if (TRUNCATED.test(result.finishReason ?? '')) report('pass', entry.label, `finish reason "${result.finishReason}" after ${result.text.length} characters (${seconds(ms)})`);
    else report('fail', entry.label, `finish reason "${result.finishReason ?? 'none'}": the stop at the limit isn't recognized, so auto-continue wouldn't start`);
  } catch (error) {
    if (error.code === 'AI_EMPTY_ANSWER') report('warn', entry.label, 'the model used the whole budget thinking and wrote nothing, so there was nothing to continue');
    else report('fail', entry.label, problemOf(error));
  }
}

section('3. Auto-continue, end to end');
const opener = ['haiku-4.5', 'gpt-4o-mini', 'gemini-flash', 'deepseek-flash', 'kimi-k2.6'].map(premiumModel).find((entry) => isConfigured(entry.provider));
if (config.chat.autoContinueMax === 0) {
  report('skip', 'auto-continue is off', 'AUTO_CONTINUE_MAX=0');
} else {
  const seen = { continued: [], text: '' };
  try {
    const [result, ms] = await timed(() =>
      runTurn({
        request: { workspace: 'premium', premiumModel: opener.id, effort: 'low', handoff: config.chat.handoff },
        system: BASE_SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              'Write two files. src/numbers.js exports an array named numbers holding the integers from 1 to 500, written out one per line (no loops or Array.from). src/index.js imports it and logs numbers.length. Put each file in its own fenced code block, with the path after the language on the opening fence.',
          },
        ],
        maxTokens: 600, // cut the first answer off on purpose (the list alone is about 2,000 tokens)
        emit: (event) => {
          if (event.type === 'continue') seen.continued.push(event.label);
          if (event.type === 'text') seen.text += event.text;
        },
      }),
    );
    const by = `${opener.label} → ${seen.continued.length ? [...new Set(seen.continued)].join(', ') : 'no continuation'}`;
    const files = extractCodeFiles(result.text);
    const numbers = files.find((file) => file.path.endsWith('numbers.js'));
    const body = numbers ? numbers.content.slice(numbers.content.indexOf('['), numbers.content.lastIndexOf(']') + 1) : '';
    const values = [...body.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
    const problems = [];
    if (seen.text !== result.text) problems.push('the streamed text differs from the saved answer');
    if (insideCodeBlock(result.text)) problems.push('a code block was left open');
    if (files.length < 2) problems.push(`${files.length} code file(s) found instead of 2`);
    if (values.length >= 20 && values.join(',') !== Array.from({ length: 500 }, (_, index) => index + 1).join(',')) {
      const at = values.findIndex((value, index) => value !== index + 1);
      problems.push(`numbers.js is broken near ${at + 1}: ${values.slice(Math.max(0, at - 2), at + 3).join(', ')} (repeated or missing at the seam)`);
    }
    if (problems.length) report('fail', by, problems.join('; '));
    else if (!result.continuations?.length) report('warn', by, 'the first answer fit in 600 tokens, so nothing had to be continued');
    else if (values.length < 20) report('warn', by, `continued ${result.continuations.length} time(s), but the model didn't write the numbers out, so the seam couldn't be checked`);
    else report('pass', by, `continued ${result.continuations.length} time(s); both files whole, 1 to 500 without gaps or repeats (${seconds(ms)})`);
  } catch (error) {
    report('fail', `${opener.label} with auto-continue`, problemOf(error));
  }
}

section('4. Images (each provider\'s cheapest vision model)');
const red = solidPng(64, 64, [220, 30, 30]).toString('base64');
for (const id of providers) {
  const entry = premiumModel(VISION[id] ?? '');
  if (!entry) {
    report('skip', providerById(id).name, 'no vision model in the catalog (text only)');
    continue;
  }
  try {
    const image = { kind: 'image', mime: 'image/png', name: 'red.png', data: red };
    const [result, ms] = await ask(entry, [{ role: 'user', content: 'What single color fills this image? Answer with one English word.', media: [image] }], 1_024);
    const answer = result.text.trim().replace(/\s+/g, ' ').slice(0, 40);
    report(/red/i.test(answer) ? 'pass' : 'fail', entry.label, `answered "${answer}" (${seconds(ms)})`);
  } catch (error) {
    report('fail', entry.label, problemOf(error));
  }
}

section('5. Router (sample Hebrew requests)');
for (const sample of SAMPLES) {
  const rating = await rateRequest(sample.text, { workspace: 'premium' });
  const pick = pickPremium(rating);
  const tier = tierFor(rating);
  const detail = `${rating.complexity}/10, ${rating.category}, ${rating.kind}, ${rating.output} output (${rating.by}) → ${pick?.entry.label ?? 'no model'}`;
  report(pick && sample.tiers.includes(tier) ? 'pass' : 'warn', sample.label, sample.tiers.includes(tier) ? detail : `${detail}; expected the ${sample.tiers.join(' or ')} tier`);
}
const workhorse = pickWorkhorse();
if (!config.chat.handoff) report('skip', 'handoff', 'off (CHAT_HANDOFF=off)');
else report(workhorse ? 'pass' : 'warn', 'handoff and continuations go to', workhorse?.label ?? 'no cheap model has a key');

section('6. Video (Gemini)');
if (!videoPath) {
  report('skip', 'no video given', 'npm run smoke -- --video path/to/clip.mp4');
} else if (!isConfigured('gemini')) {
  report('skip', 'video', 'needs GEMINI_API_KEY');
} else {
  const extension = path.extname(videoPath).toLowerCase().replace('.mpg', '.mpeg');
  const mime = Object.keys(VIDEO_TYPES).find((type) => VIDEO_TYPES[type] === extension);
  const entry = premiumModel('gemini-flash');
  const question = 'Describe this video in one short sentence.';
  let size = 0;
  try {
    size = (await fs.stat(videoPath)).size;
  } catch {
    report('fail', path.basename(videoPath), 'file not found');
  }
  if (size && !mime) report('fail', path.basename(videoPath), `unsupported type: use ${Object.values(VIDEO_TYPES).join(', ')}`);
  else if (size > config.chat.videoMaxMb * MB) report('fail', path.basename(videoPath), `larger than CHAT_VIDEO_MAX_MB (${config.chat.videoMaxMb} MB), so the app would refuse it`);
  else if (size) {
    const inline = size <= config.chat.geminiInlineMaxMb * MB && !forceFiles;
    try {
      let video;
      if (inline) video = { kind: 'video', mime, name: path.basename(videoPath), data: (await fs.readFile(videoPath)).toString('base64') };
      else video = { kind: 'video', name: path.basename(videoPath), ...(await uploadToGemini({ path: videoPath, mime, name: path.basename(videoPath), size })) };
      const [result, ms] = await ask(entry, [{ role: 'user', content: question, media: [video] }], 1_024);
      const how = inline ? 'inline' : "through Gemini's Files API";
      report(result.text.trim() ? 'pass' : 'fail', `${entry.label}, ${how}`, `"${result.text.trim().replace(/\s+/g, ' ').slice(0, 90)}" (${seconds(ms)})`);
    } catch (error) {
      report('fail', `${entry.label} with the video`, problemOf(error));
    }
  }
}

section('7. The development team');
const team = teamFor();
if (!args.includes('--team')) {
  report('skip', 'not run', 'npm run smoke -- --team sends one small project through it (a few cents)');
} else if (!team) {
  report('skip', 'the team', 'needs keys for at least two different models');
} else {
  const meter = createMeter();
  try {
    const [result, ms] = await timed(() =>
      meter.run(() =>
        runTurn({
          request: { workspace: 'premium', premiumModel: 'auto', effort: 'low', handoff: config.chat.handoff, pipeline: 'force' },
          system: BASE_SYSTEM,
          messages: [
            {
              role: 'user',
              content: 'Build a tiny click counter: index.html with a button that counts clicks, saved through a small Express server (GET and POST /api/count). Keep every file short.',
            },
          ],
          emit: () => {},
        }),
      ),
    );
    // The swarm's steps: the blueprint, the files written in parallel, the QA compiler and its fix rounds.
    // QA "fails" when problems are left after the rounds: the team still worked, and the answer reports them.
    const architect = team.find((role) => role.id === 'architect').models[0].label;
    for (const member of result.team ?? []) {
      const tookOver = member.role === 'architect' && member.model !== architect;
      const status = member.state === 'done' ? (tookOver ? 'warn' : 'pass') : member.role === 'review' && member.state === 'failed' ? 'warn' : 'fail';
      const detail = [tookOver ? `took over from ${architect}` : '', member.note ?? '', member.ms ? seconds(member.ms) : ''].filter(Boolean).join(', ');
      report(status, `${member.role}: ${member.model}`, detail);
    }
    const files = extractCodeFiles(result.text);
    const cost = meter.calls.reduce((sum, call) => sum + (costOf(call) ?? 0), 0);
    report(files.length >= 2 ? 'pass' : 'fail', 'the project', `${files.length} files (${files.map((file) => file.path).join(', ')}), ${seconds(ms)}, about $${cost.toFixed(3)}`);
  } catch (error) {
    report('fail', 'the team', problemOf(error));
  }
}

section('8. Web research');
if (!researchAvailable()) {
  report('skip', 'Tavily', config.research.enabled ? 'add TAVILY_API_KEY (the free plan has 1,000 searches a month)' : 'WEB_RESEARCH=off');
} else {
  try {
    const [found, ms] = await timed(() => searchWeb({ query: 'Node.js latest LTS release' }));
    const withText = found.results.filter((page) => page.text.length > 300).length;
    report(found.results.length ? 'pass' : 'fail', 'Tavily search', `${found.results.length} results, ${withText} with the page's text, ${found.credits} credit, ${seconds(ms)}`);
  } catch (error) {
    report('fail', 'Tavily search', problemOf(error));
  }
}

section('9. Accounts and the database');
if (!authConfigured()) {
  report('fail', 'accounts', 'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are missing: the API refuses every request');
} else {
  const { supabaseUrl, publishableKey, jwtSecret, adminEmails } = config.auth;
  try {
    const [response, ms] = await timed(() => fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(15_000) }));
    const keys = response.ok ? ((await response.json()).keys ?? []) : [];
    if (keys.length) report('pass', 'signing keys', `${keys.length} public key${keys.length === 1 ? '' : 's'} (${[...new Set(keys.map((key) => key.alg))].join(', ')}), ${seconds(ms)}`);
    else if (jwtSecret) report('pass', 'signing keys', 'the legacy shared secret (SUPABASE_JWT_SECRET) checks tokens locally');
    else report('warn', 'signing keys', 'no public keys: tokens are confirmed by Supabase Auth on each new token. Switch the project to asymmetric keys, or add SUPABASE_JWT_SECRET.');
  } catch (error) {
    report('fail', 'signing keys', `${supabaseUrl} can't be reached: ${problemOf(error)}`);
  }
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: publishableKey }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: check SUPABASE_PUBLISHABLE_KEY`);
    const settings = await response.json();
    report('pass', 'publishable key', `sign-up ${settings.disable_signup ? 'closed' : 'open'}, email confirmation ${settings.mailer_autoconfirm ? 'off' : 'on'}`);
  } catch (error) {
    report('fail', 'publishable key', problemOf(error));
  }
  report(adminEmails.length ? 'pass' : 'warn', 'admins', adminEmails.length ? adminEmails.join(', ') : 'ADMIN_EMAILS is empty: nobody can open projects, GitHub, links and files');
}
if (!config.database.url) {
  report('fail', 'database', 'DATABASE_URL is missing: conversations and memories need PostgreSQL');
} else {
  try {
    const prisma = db();
    const [[{ version }], ms] = await timed(() => prisma.$queryRaw`SELECT current_setting('server_version') AS version`);
    const applied = new Set((await prisma.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`.catch(() => [])).map((row) => row.migration_name));
    const folders = (await fs.readdir(new URL('../prisma/migrations/', import.meta.url), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const missing = folders.filter((name) => !applied.has(name));
    if (missing.length) report('fail', 'migrations', `not applied: ${missing.join(', ')}. Run: npm run db:migrate -w server`);
    else {
      const [counts] = await prisma.$queryRaw`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM chat_sessions)::int AS chats, (SELECT count(*) FROM memories)::int AS memories`;
      report('pass', `PostgreSQL ${version}`, `${folders.length} migration${folders.length === 1 ? '' : 's'} applied; ${counts.users} users, ${counts.chats} conversations, ${counts.memories} memories; ${seconds(ms)}`);
      const open = (await prisma.$queryRaw`SELECT relname FROM pg_class WHERE relname IN ('users', 'chat_sessions', 'memories') AND NOT relrowsecurity`).map((row) => row.relname);
      report(open.length ? 'warn' : 'pass', 'row level security', open.length ? `off for ${open.join(', ')}: Supabase's Data API could read them` : 'on for every table');
    }
  } catch (error) {
    report('fail', 'database', problemOf(error));
  }
}

section('10. Long-term memory');
if (!config.longTermMemory.enabled) {
  report('skip', 'memory', 'LONG_TERM_MEMORY=off');
} else {
  const who = embedder();
  if (!who) {
    report('skip', 'embeddings', 'no Gemini or OpenAI key: memories are matched by their words');
  } else {
    try {
      const [vectors, ms] = await timed(() => embed(['Prefers TypeScript with strict mode', 'Writes strictly typed TypeScript code', 'Bakes sourdough bread on weekends'], 'document', who));
      const related = cosine(vectors[0], vectors[1]);
      const unrelated = cosine(vectors[0], vectors[2]);
      // A related request must clear the provider's threshold, and an unrelated one stay below it.
      const good = related > unrelated && related >= THRESHOLDS[who.provider].related;
      report(good ? 'pass' : 'warn', `${who.provider} ${who.model}`, `${vectors[0].length} dimensions; related ${related.toFixed(2)}, unrelated ${unrelated.toFixed(2)} (threshold ${THRESHOLDS[who.provider].related}), ${seconds(ms)}`);
    } catch (error) {
      report('fail', 'embeddings', problemOf(error));
    }
  }
  const learner = learnerModel();
  report(learner ? 'pass' : 'skip', 'learner', learner ? learner.label : 'no key for a cheap model (MEMORY_LEARNER)');
}
await closeDb().catch(() => {});

section('11. The sandbox');
if (!args.includes('--sandbox')) {
  report('skip', 'not run', 'npm run smoke -- --sandbox installs, tests and starts a tiny project in it (SANDBOX=docker or e2b)');
} else if (config.sandbox.provider === 'off') {
  report('skip', 'the sandbox', 'SANDBOX is off: set it to docker or e2b');
} else {
  let box = null;
  try {
    const [opened, openMs] = await timed(() => openSandbox());
    box = opened;
    report('pass', `${box.label}: a sandbox is ready`, seconds(openMs));
    const spec = 'Exactly what this tiny file does: no dependencies, no configuration, nothing beyond the one behavior described here.';
    const { blueprint } = validateBlueprint({
      name: 'stash-smoke',
      summary: 'A tiny server and a test.',
      packages: [{ path: 'package.json', type: 'module', scripts: { test: 'node --test', start: 'node index.js' } }],
      files: [
        { path: 'index.js', purpose: 'An HTTP server on PORT that answers ok', imports: [{ from: 'node:http' }], spec },
        { path: 'sum.js', purpose: 'sum(a, b)', exports: [{ name: 'sum' }], spec },
        { path: 'sum.test.js', purpose: 'A test of sum', imports: [{ from: 'node:test' }, { from: 'node:assert/strict' }, { from: './sum.js', names: ['sum'] }], spec },
      ],
    });
    const files = new Map([
      ...manifestFiles(blueprint).map((item) => [item.path, item.content]),
      ['index.js', "import http from 'node:http';\n\nhttp.createServer((req, res) => res.end('ok')).listen(process.env.PORT ?? 4173);\n"],
      ['sum.js', 'export const sum = (a, b) => a + b;\n'],
      ['sum.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.js';\n\ntest('sum adds', () => assert.equal(sum(2, 3), 5));\n"],
    ]);
    await box.writeFiles(files);
    const [result, ms] = await timed(() => verifyProject({ box, files, blueprint, settings: config.sandbox }));
    report(result.ok ? 'pass' : 'fail', 'install, test and start', `${stepsSummary(result.steps)} (${seconds(ms)})`);
    for (const item of result.ok ? [] : [...result.unfixable, ...[...result.issues.values()].flat()]) report('fail', 'what failed', (item.excerpt ?? item.message).split('\n').slice(0, 3).join(' | '));
    // After the install, the project's code runs offline: it must not reach the internet.
    const reach = await box.run(`node -e "fetch('https://registry.npmjs.org/').then(() => process.exit(0), () => process.exit(1))"`, { timeoutMs: 30_000 });
    if (!result.offline) report('warn', 'network', `${box.label} couldn't switch the internet off (an older e2b package?)`);
    else report(reach.code === 0 ? 'fail' : 'pass', 'network', reach.code === 0 ? 'the project could still reach the internet after the install' : "off after the install: the project can't reach the internet");
  } catch (error) {
    report('fail', 'the sandbox', problemOf(error));
  } finally {
    await box?.close();
  }
}

console.log(`\n${counts.pass} passed, ${counts.warn} to look at, ${counts.fail} failed, ${counts.skip} skipped.`);
process.exit(counts.fail ? 1 : 0);
