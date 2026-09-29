// Credits: the balance on each account, the 402 before any model is called, what costs what (a premium
// answer, the development team's files, a media item), refunds for failed work, and no double spending.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { MEMBER, OWNER, authHeader, startTestDatabase, tempDir } from './helpers.js';

const storage = await tempDir('stash-credits-');
process.env.STORAGE_DIR = storage.dir;
process.env.LOG_REQUESTS = 'false';
process.env.LONG_TERM_MEMORY = 'off';
process.env.ANTHROPIC_API_KEY = 'anthropic-key';
process.env.OPENAI_API_KEY = 'openai-key';
process.env.GEMINI_API_KEY = 'gemini-key';
process.env.DEEPSEEK_API_KEY = 'deepseek-key';
process.env.GROQ_API_KEY = 'groq-key';
process.env.POLLINATIONS_API_KEY = 'sk_test_key';
process.env.AI_RETRY_BASE_MS = '5';
process.env.CREDITS_UPGRADE_URL = 'https://stash.example/upgrade';
for (const name of ['AI_PROVIDER', 'AI_PROVIDERS', 'CHAT_HANDOFF', 'PIPELINE', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'CREDITS', 'CREDITS_PER_ANSWER', 'CREDITS_PER_FILE', 'CREDITS_PER_MEDIA', 'AUTO_CONTINUE_MAX']) delete process.env[name];

const QUICK = { complexity: 3, category: 'quick', kind: 'question', output: 'short', reason: 'שאלה קצרה' };
const PLANNING = { complexity: 8, category: 'code', kind: 'planning', output: 'massive', reason: 'אפליקציה' };
const S = (text) => `${text} Every function handles its errors and edge cases, exactly as the contracts say.`;
// The swarm's project: three files, and a reviewer with nothing to fix.
const BLUEPRINT = {
  name: 'counter',
  title: 'מונה',
  summary: 'מונה לחיצות קטן.',
  stack: ['HTML', 'JavaScript'],
  contracts: 'No API: everything runs in the page.',
  files: [
    { path: 'index.html', purpose: 'The page', imports: [{ from: './main.js' }], spec: S('A button, an output, and ./main.js as a module script.') },
    { path: 'main.js', purpose: 'The counter', imports: [{ from: './format.js', names: ['format'] }], spec: S('Counts the clicks and shows them with format().') },
    { path: 'format.js', purpose: 'Formatting', exports: [{ name: 'format', kind: 'function', signature: 'format(count: number): string' }], spec: S('The count in Hebrew words.') },
  ],
};
const CODE = {
  'index.html': '<!doctype html>\n<html lang="he" dir="rtl">\n  <body>\n    <button id="add">הוספה</button>\n    <output id="count"></output>\n    <script type="module" src="./main.js"></script>\n  </body>\n</html>\n',
  'main.js': "import { format } from './format.js';\n\nlet count = 0;\nconst output = document.getElementById('count');\ndocument.getElementById('add').addEventListener('click', () => {\n  count += 1;\n  output.textContent = format(count);\n});\noutput.textContent = format(count);\n",
  'format.js': "export function format(count) {\n  return count === 1 ? 'לחיצה אחת' : `${count} לחיצות`;\n}\n",
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const realFetch = globalThis.fetch;
const calls = [];
let rating = QUICK;
let failAnswers = false;
let mediaFails = false;
const sse = (events) =>
  new Response(events.map((event) => (typeof event === 'string' ? `${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`)).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const claude = (text) =>
  sse([
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 900, output_tokens: 400 } })}`,
  ]);
const openai = (text) => sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 500 } }, 'data: [DONE]']);
const gemini = (text) => sse([{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 300 } }]);
const systemOf = (body) => (typeof body?.system === 'string' ? body.system : (body?.messages?.find((message) => message.role === 'system')?.content ?? body?.systemInstruction?.parts?.[0]?.text ?? ''));
const partsText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '');
const textOf = (body) => (body?.contents ?? body?.messages ?? []).map((message) => (message.parts ? message.parts.map((part) => part.text ?? '').join('') : partsText(message.content))).join('\n');
const roleOf = (system) =>
  system.includes('You route chat requests')
    ? 'router'
    : system.includes('You are the Master Architect')
      ? 'architect'
      : system.includes('You are an expert compiler')
        ? 'builder'
        : system.includes('You are the QA compiler')
          ? 'review'
          : 'answer';

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const target = new URL(href);
  if (target.hostname === 'gen.pollinations.ai') {
    calls.push({ url: href, role: 'media' });
    return mediaFails ? json({ error: 'The model is overloaded' }, 500) : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
  const role = body ? roleOf(systemOf(body)) : 'list';
  calls.push({ url: href, role, body });
  if (href === 'https://api.groq.com/openai/v1/models') return json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-3.1-8b-instant' }] });
  if (role === 'router') return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(rating) }] } }] });
  if (role === 'answer' && failAnswers) return json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }, 401);
  const reply = (text) => (target.hostname.includes('generativelanguage') ? gemini(text) : target.hostname.includes('anthropic') ? claude(text) : openai(text));
  if (role === 'architect') return reply(JSON.stringify(BLUEPRINT));
  if (role === 'builder') return reply(CODE[/# The file to write: (\S+)/.exec(textOf(body))?.[1]] ?? 'export {};\n');
  if (role === 'review') return reply(JSON.stringify({ issues: [] }));
  return reply(`תשובה מ-${target.hostname}`);
};

const database = await startTestDatabase();
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { db } = await import('../src/lib/db.js');
const { adjustCredits } = await import('../src/services/credits.js');
console.warn = () => {};

let server;
let base;
let store;
before(async () => {
  await Promise.all([config.paths.archives, config.paths.files, config.paths.media].map((dir) => fs.mkdir(dir, { recursive: true })));
  store = new JsonStore(config.paths.database);
  await store.init();
  server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.flush();
  await storage.cleanup();
});

const api = (route, init = {}, user = MEMBER) => realFetch(`${base}${route}`, { ...init, headers: { ...authHeader(user), ...(init.headers ?? {}) } });
const post = (route, body, user = MEMBER) => api(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, user);
const newChat = async (user = MEMBER) => (await (await post('/chat/conversations', {}, user)).json()).conversation.id;
const PREMIUM = { workspace: 'premium', effort: 'low', premiumModel: 'auto' };
const FREE = { workspace: 'free', freeMode: 'manual', provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'low' };
async function ask(id, body, user = MEMBER) {
  const response = await post(`/chat/conversations/${id}/messages`, { ...PREMIUM, ...body }, user);
  assert.equal(response.status, 200, `the answer started (got ${response.status})`);
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  return { events, final: events.find((event) => event.type === 'done' || event.type === 'error'), route: events.find((event) => event.type === 'route')?.route };
}
const balance = async (user = MEMBER) => (await db().user.findUnique({ where: { id: user.id }, select: { credits: true } })).credits;
const setBalance = (credits, user = MEMBER) => db().user.update({ where: { id: user.id }, data: { credits } });

describe('Credits', () => {
  test('a new account starts with 50 credits, and /me shows the balance, the prices and where to upgrade', async () => {
    const me = await (await api('/auth/me')).json();
    assert.deepEqual(me.user.credits, { balance: 50, unlimited: false, pricing: { answer: 1, file: 1, media: 1 }, upgradeUrl: 'https://stash.example/upgrade' });
    const admin = await (await api('/auth/me', {}, OWNER)).json();
    assert.deepEqual([admin.user.credits.balance, admin.user.credits.unlimited], [null, true], "an admin isn't charged");
  });

  test('a premium answer costs one credit and the free workspace none; the new balance comes with the answer', async () => {
    rating = QUICK;
    const chat = await newChat();
    const premium = await ask(chat, { content: 'מה זה REST?' });
    assert.equal(premium.final.type, 'done');
    assert.deepEqual([premium.final.credits, premium.final.message.credits], [49, 1]);
    const free = await ask(chat, { ...FREE, content: 'ומה זה GraphQL?' });
    assert.equal(free.final.type, 'done');
    assert.deepEqual([free.final.credits, free.final.message.credits], [49, undefined]);
    assert.equal(await balance(), 49);
  });

  test('with no credits nothing runs: 402 with the Hebrew message, before any model is called or anything is saved', async () => {
    const used = await newChat();
    await ask(used, { content: 'שאלה ראשונה' });
    await setBalance(0);
    const chat = await newChat();
    const from = calls.length;
    const response = await post(`/chat/conversations/${chat}/messages`, { ...PREMIUM, content: 'שלום' });
    assert.equal(response.status, 402);
    assert.deepEqual((await response.json()).error, { message: 'נגמרו לך הקרדיטים. אנא שדרג את החשבון.', code: 'CREDITS_EXHAUSTED', details: { credits: 0, needed: 1 } });
    assert.equal(calls.length, from, 'no model was called');
    assert.deepEqual((await (await api(`/chat/conversations/${chat}`)).json()).conversation.messages, [], 'the message was not saved');
    // The free workspace, the media studio and a manual memory update are closed too.
    assert.equal((await post(`/chat/conversations/${chat}/messages`, { ...FREE, content: 'שלום' })).status, 402);
    assert.equal((await post('/media/generate', { kind: 'image', prompt: 'חתול על גג' })).status, 402);
    assert.equal((await post(`/chat/conversations/${used}/memory/compact`, {})).status, 402);
    assert.equal(calls.length, from);
    assert.equal(await balance(), 0);
  });

  test('the development team costs a credit per file of its blueprint, taken once the plan is ready and kept when it succeeds', async () => {
    await setBalance(50);
    rating = PLANNING;
    const result = await ask(await newChat(), { content: 'בנה מונה לחיצות' });
    assert.equal(result.route.mode, 'pipeline');
    assert.equal(result.final.type, 'done');
    assert.deepEqual([result.final.credits, result.final.message.credits], [47, 3], "three files, three credits (and not an answer's credit on top)");
    assert.equal(await balance(), 47);
  });

  test('not enough credits for the plan: the team stops before writing a file, says what it needs, and charges nothing', async () => {
    await setBalance(2);
    rating = PLANNING;
    const from = calls.length;
    const result = await ask(await newChat(), { content: 'בנה מונה לחיצות' });
    assert.equal(result.final.type, 'error');
    assert.deepEqual(result.final.message.error, { message: 'לפרויקט הזה (3 קבצים) צריך 3 קרדיטים, ויש לך 2 קרדיטים. אנא שדרג את החשבון.', detail: null, code: 'CREDITS_INSUFFICIENT', credits: 2, needed: 3 });
    assert.equal(calls.slice(from).filter((call) => call.role === 'builder').length, 0, 'no file was written');
    const [architect, builder] = result.final.message.team;
    assert.deepEqual([architect.state, builder.state, builder.note], ['done', 'failed', 'אין מספיק קרדיטים לכתיבת הקבצים']);
    assert.match(result.final.message.content, /^## מונה/, 'the plan is still shown');
    assert.equal(result.final.credits, 2);
    assert.equal(await balance(), 2);
  });

  test('a failed answer costs nothing', async () => {
    await setBalance(10);
    rating = QUICK;
    failAnswers = true;
    const result = await ask(await newChat(), { content: 'שלום' });
    failAnswers = false;
    assert.equal(result.final.type, 'error');
    assert.deepEqual([result.final.credits, result.final.message.credits], [10, undefined]);
    assert.equal(await balance(), 10);
  });

  test('two answers at once with one credit left: exactly one runs, and a balance never goes below zero', async () => {
    await setBalance(1);
    rating = QUICK;
    const chats = await Promise.all([newChat(), newChat()]);
    const responses = await Promise.all(chats.map((id) => post(`/chat/conversations/${id}/messages`, { ...PREMIUM, content: 'שלום' })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 402]);
    await Promise.all(responses.map((response) => response.text()));
    assert.equal(await balance(), 0);
    await assert.rejects(setBalance(-1), 'the database refuses a negative balance');
  });

  test("admins aren't charged", async () => {
    rating = QUICK;
    await api('/auth/me', {}, OWNER);
    const before = await balance(OWNER);
    const result = await ask(await newChat(OWNER), { content: 'שלום' }, OWNER);
    assert.equal(result.final.type, 'done');
    assert.deepEqual([result.final.credits, result.final.message.credits], [undefined, undefined]);
    assert.equal(await balance(OWNER), before);
  });

  test('the media studio: a credit an item, given back when the generation fails', async () => {
    await setBalance(5);
    const made = await post('/media/generate', { kind: 'image', prompt: 'חתול על גג' });
    assert.equal(made.status, 201);
    assert.equal((await made.json()).credits, 4);
    mediaFails = true;
    const failed = await post('/media/generate', { kind: 'image', prompt: 'חתול על גג' });
    mediaFails = false;
    assert.ok(failed.status >= 500, `the generation failed (${failed.status})`);
    assert.equal(await balance(), 4, 'its credit was given back');
  });

  test("npm run credits: an account's balance by email, added to or set, never below zero", async () => {
    await setBalance(4);
    assert.deepEqual(await adjustCredits('MEMBER@stash.test'), { email: 'member@stash.test', before: 4, after: 4 });
    assert.deepEqual(await adjustCredits('member@stash.test', { add: 100 }), { email: 'member@stash.test', before: 4, after: 104 });
    assert.deepEqual(await adjustCredits('member@stash.test', { set: 20 }), { email: 'member@stash.test', before: 104, after: 20 });
    await assert.rejects(adjustCredits('member@stash.test', { add: -21 }), /can't go below zero/);
    assert.equal(await adjustCredits('nobody@stash.test', { add: 5 }), null);
  });
});

// Last: the database outlives the server and whatever it was still writing.
after(() => database.stop());
