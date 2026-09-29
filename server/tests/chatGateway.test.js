// The AI gateway's cost features: auto-continue, cost-aware routing, handoff, the expanded model list,
// images and video, and temporary ZIPs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import AdmZip from 'adm-zip';
import { OWNER, startTestDatabase, tempDir } from './helpers.js';

const storage = await tempDir('stash-gateway-');
process.env.STORAGE_DIR = storage.dir;
process.env.LOG_REQUESTS = 'false';
process.env.LONG_TERM_MEMORY = 'off'; // the long-term memory and web research have their own suite (chatResearchMemory.test.js)
process.env.ANTHROPIC_API_KEY = 'anthropic-key';
process.env.OPENAI_API_KEY = 'openai-key';
process.env.GEMINI_API_KEY = 'gemini-key';
process.env.DEEPSEEK_API_KEY = 'deepseek-key';
process.env.GROQ_API_KEY = 'groq-key';
process.env.AUTO_CONTINUE_MAX = '3';
process.env.GEMINI_INLINE_MAX_MB = '0.002';
process.env.GEMINI_FILE_POLL_MS = '5';
process.env.AI_RETRY_BASE_MS = '5';
delete process.env.AI_PROVIDER;
delete process.env.AI_PROVIDERS;
delete process.env.CHAT_HANDOFF;

const HEBREW = /[\u05D0-\u05EA]/;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const PART_ONE = 'הנה הקבצים:\n\n```js src/app.js\nfunction add(a, b) {\n  return (';
const PART_TWO = '```js\n  return (\n    a + b\n  );\n}\n```\n\n```css src/style.css\nbody { margin: 0; }\n```\n';
const realFetch = globalThis.fetch;
const calls = [];
let rating = { complexity: 5, category: 'general', kind: 'question', output: 'short', reason: 'שאלה' };
let scenario = 'normal';

function sse(events) {
  const text = events.map((event) => (typeof event === 'string' ? `${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`)).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const claude = (text, stop = 'end_turn') =>
  sse([
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 7 } })}`,
  ]);
const openai = (text, finish = 'stop') => sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: finish }] }, 'data: [DONE]']);
const gemini = (text) => sse([{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }]);
const systemOf = (body) => (typeof body.system === 'string' ? body.system : (body.messages?.find((message) => message.role === 'system')?.content ?? body.systemInstruction?.parts?.[0]?.text ?? ''));

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
  calls.push({ url: href, body, headers: init.headers });
  if (href === 'https://api.groq.com/openai/v1/models') return json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  if (href === 'https://api.anthropic.com/v1/messages') {
    if (scenario === 'truncate' || scenario === 'endless') return claude(PART_ONE, 'max_tokens');
    return claude('תשובה מ-Claude');
  }
  if (href === 'https://api.deepseek.com/chat/completions') {
    if (scenario === 'truncate') return openai(PART_TWO);
    if (scenario === 'endless') return openai('\nx();', 'length');
    return openai('תשובה מ-DeepSeek');
  }
  if (href === 'https://api.openai.com/v1/chat/completions') return openai('תשובה מ-OpenAI');
  if (href === 'https://generativelanguage.googleapis.com/upload/v1beta/files') {
    return json({}, 200, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session/42' });
  }
  if (href === 'https://generativelanguage.googleapis.com/upload/session/42') {
    return json({ file: { name: 'files/42', state: 'PROCESSING', uri: 'https://generativelanguage.googleapis.com/v1beta/files/42', mimeType: 'video/mp4' } });
  }
  if (href === 'https://generativelanguage.googleapis.com/v1beta/files/42') {
    return json({ name: 'files/42', state: 'ACTIVE', uri: 'https://generativelanguage.googleapis.com/v1beta/files/42', mimeType: 'video/mp4' });
  }
  if (href.startsWith('https://generativelanguage.googleapis.com/')) {
    if (systemOf(body).includes('You route chat requests')) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(rating) }] } }] });
    return gemini('תשובה מ-Gemini');
  }
  throw new Error(`Unexpected request: ${href}`);
};

const database = await startTestDatabase();
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
console.warn = () => {};

let server;
let base;
let store;

before(async () => {
  await Promise.all([config.paths.archives, config.paths.files].map((dir) => fs.mkdir(dir, { recursive: true })));
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

const api = (route, init) => realFetch(`${base}${route}`, init);
const post = (route, body) => api(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const newChat = async () => (await (await post('/chat/conversations', {})).json()).conversation.id;
async function ask(id, body) {
  const response = await post(`/chat/conversations/${id}/messages`, { workspace: 'premium', effort: 'low', ...body });
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('ndjson')) return { status: response.status, error: JSON.parse(text).error };
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  return {
    events,
    streamed: events.filter((event) => event.type === 'text').map((event) => event.text).join(''),
    final: events.find((event) => event.type === 'done' || event.type === 'error'),
    route: events.find((event) => event.type === 'route')?.route,
  };
}
async function upload(bytes, type, name) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const response = await api('/chat/attachments', { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}
const last = (fragment) => calls.filter((call) => call.url.includes(fragment)).at(-1);

describe('AI gateway: cost features', () => {
  test('a cut-off answer continues on the same stream, on a cheaper model, with a seamless join', async () => {
    scenario = 'truncate';
    const id = await newChat();
    const result = await ask(id, { content: 'בנה אפליקציה קטנה', premiumModel: 'opus-5.5' });
    const joined = `${PART_ONE}\n    a + b\n  );\n}\n\`\`\`\n\n\`\`\`css src/style.css\nbody { margin: 0; }\n\`\`\`\n`;
    assert.equal(result.final.message.content, joined);
    assert.equal(result.streamed, joined, 'the reader saw exactly the joined answer'); 
    assert.deepEqual(result.events.filter((event) => event.type === 'continue').map((event) => event.label), ['DeepSeek V4.1 Flash']);
    const continuation = last('api.deepseek.com').body;
    assert.equal(continuation.model, 'deepseek-flash');
    assert.deepEqual(continuation.messages.slice(-2), [
      { role: 'assistant', content: PART_ONE },
      { role: 'user', content: 'Continue exactly where you left off' },
    ]);
    assert.match(continuation.messages[0].content, /cut off by the length limit/);
    assert.deepEqual(result.final.message.continuations.map((item) => [item.label, item.ok]), [['DeepSeek V4.1 Flash', true]]);
    const bundle = result.events.find((event) => event.type === 'bundle').bundle;
    const zip = new AdmZip(Buffer.from(await (await realFetch(`${base.replace('/api', '')}${bundle.url}`)).arrayBuffer()));
    assert.equal(zip.readAsText('stash-code/src/app.js'), 'function add(a, b) {\n  return (\n    a + b\n  );\n}\n');

    // The temporary ZIP expires; downloading it again rebuilds it from the answer.
    await fs.rm(path.join(config.paths.bundles, `${bundle.id}.zip`));
    const again = await realFetch(`${base.replace('/api', '')}${bundle.url}`);
    assert.equal(again.status, 200);
    assert.equal(new AdmZip(Buffer.from(await again.arrayBuffer())).getEntries().length, 2);
  });

  test('the seam drops restarted and repeated lines but keeps a legitimately repeated one', async () => {
    const { joinSeam } = await import('../src/services/ai/orchestrator.js');
    assert.equal(joinSeam('[\n  59,\n  60,\n  6', '  61,\n  62,'), '1,\n  62,', 'a restarted short line');
    assert.equal(joinSeam('[\n  59,\n  60,\n  6', '  59,\n  60,\n  61,'), '1,', 'repeated lines and a restarted one');
    assert.equal(joinSeam('[\n  59,\n  60,\n  6', '\n  61,\n  62,'), '1,\n  62,', 'the cut line restarted on a new line');
    assert.equal(joinSeam('[\n  58,\n  59,\n  60,\n', '  59,\n  60,\n  61,'), '  61,', 'two repeated whole lines');
    assert.equal(joinSeam('<ul>\n    </li>\n', '    </li>\n  </ul>'), '    </li>\n  </ul>', 'one short repeated line stays');
    assert.equal(joinSeam('```js a.js\nconst x = 1;\n', '```js\nconst y = 2;'), 'const y = 2;', 'a reopened fence');
    assert.equal(joinSeam('Hello wor', 'ld, and more'), 'ld, and more', 'a clean continuation is untouched');
  });

  test('auto-continue stops after AUTO_CONTINUE_MAX rounds and says so', async () => {
    scenario = 'endless';
    const before = calls.filter((call) => call.url.includes('api.deepseek.com')).length;
    const result = await ask(await newChat(), { content: 'כתוב קוד ארוך', premiumModel: 'opus-5.5' });
    assert.equal(calls.filter((call) => call.url.includes('api.deepseek.com')).length - before, 3);
    assert.equal(result.final.message.continuations.length, 3);
    assert.match(result.final.message.route.notice, /3 המשכים/);
    scenario = 'normal';
  });

  test('the auto-router picks the cheapest model that fits; Opus only at 9–10; big code goes to DeepSeek', async () => {
    // One model per request: the development team (on by default for complex code) is off here.
    const pick = async (next) => {
      rating = next;
      return (await ask(await newChat(), { content: 'בקשה', premiumModel: 'auto', pipeline: false })).route;
    };
    assert.equal((await pick({ complexity: 5, category: 'general', kind: 'question', output: 'short' })).label, 'Haiku 4.5');
    assert.equal((await pick({ complexity: 8, category: 'code', kind: 'implementation', output: 'medium' })).label, 'Sonnet 5');
    assert.equal((await pick({ complexity: 9, category: 'code', kind: 'planning', output: 'long' })).label, 'Opus 5.5');
    const big = await pick({ complexity: 6, category: 'code', kind: 'implementation', output: 'massive' });
    assert.deepEqual([big.label, big.tier], ['DeepSeek V4.1 Flash', 'massiveCode']);
    // 32K for the answer plus room for DeepSeek's thinking at low effort.
    assert.equal(last('api.deepseek.com').body.max_tokens, 32_768 + 2_048);
  });

  test('after the first answer, follow-ups move to a cheap model; planning keeps the expensive one', async () => {
    const id = await newChat();
    rating = { complexity: 6, category: 'code', kind: 'fix', output: 'medium' };
    assert.equal((await ask(id, { content: 'תכנן מערכת', premiumModel: 'opus-5.5' })).route.label, 'Opus 5.5', 'the first answer is never handed off');
    const followUp = await ask(id, { content: 'תקן את הבאג', premiumModel: 'opus-5.5' });
    assert.deepEqual(followUp.route.handoff, { from: 'Opus 5.5', to: 'DeepSeek V4.1 Flash', reason: 'תיקון' });
    assert.equal(last('api.deepseek.com').body.model, 'deepseek-flash');
    rating = { complexity: 7, category: 'code', kind: 'planning', output: 'long' };
    assert.equal((await ask(id, { content: 'תכנן מודול חדש', premiumModel: 'opus-5.5' })).route.handoff, undefined);
    rating = { complexity: 4, category: 'code', kind: 'fix', output: 'short' };
    const pinned = await ask(id, { content: 'עוד תיקון', premiumModel: 'opus-5.5', handoff: false });
    assert.equal(pinned.route.label, 'Opus 5.5');
    assert.equal(last('api.anthropic.com').body.model, 'claude-opus-5-5');
  });

  test('every provider lists its cheaper models, and they can be chosen by hand', async () => {
    const catalog = await (await api('/chat/catalog')).json();
    const openaiModels = catalog.premium.models.filter((model) => model.provider === 'openai');
    assert.deepEqual(openaiModels.map((model) => model.model), ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-4o', 'gpt-5.4-mini', 'gpt-4o-mini']);
    assert.equal(openaiModels.at(-1).costLabel, 'זול מאוד');
    assert.deepEqual(catalog.premium.models.filter((model) => model.provider === 'anthropic').map((model) => model.label), ['Fable 5.1', 'Opus 5.5', 'Sonnet 5', 'Haiku 4.5']);
    assert.equal(catalog.premium.handoff.workhorse, 'DeepSeek V4.1 Flash');
    await ask(await newChat(), { content: 'שאלה', premiumModel: 'gpt-4o-mini' });
    assert.equal(last('api.openai.com').body.model, 'gpt-4o-mini');
    await ask(await newChat(), { content: 'שאלה', premiumModel: 'gemini-flash-lite' });
    assert.match(last('streamGenerateContent').url, /models\/gemini-flash-lite-latest:streamGenerateContent/);
  });

  test('images go to vision models as Base64 in each provider\'s format', async () => {
    const uploaded = await upload(PNG, 'image/png', 'צילום מסך.png');
    assert.equal(uploaded.status, 201);
    const image = uploaded.body.attachment;
    assert.deepEqual([image.kind, image.name], ['image', 'צילום מסך.png']);
    const served = await api(`/chat/attachments/${image.id}`);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('content-security-policy'), /sandbox/);

    const id = await newChat();
    const result = await ask(id, { content: 'מה בתמונה?', premiumModel: 'haiku-4.5', attachments: [image.id] });
    assert.equal(result.final.type, 'done');
    const content = last('api.anthropic.com').body.messages.at(-1).content;
    assert.deepEqual(content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
      { type: 'text', text: 'מה בתמונה?' },
    ]);
    assert.equal(result.events[0].userMessage.attachments[0].id, image.id);

    const second = (await upload(PNG, 'image/png', 'b.png')).body.attachment;
    await ask(await newChat(), { content: 'תאר', premiumModel: 'gpt-4o', attachments: [second.id] });
    assert.deepEqual(last('api.openai.com').body.messages.at(-1).content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } });
  });

  test('video goes to Gemini: inline when small, through the Files API when large', async () => {
    rating = { complexity: 4, category: 'general', kind: 'question', output: 'short' };
    const small = (await upload(Buffer.alloc(500, 1), 'video/mp4', 'clip.mp4')).body.attachment;
    const inline = await ask(await newChat(), { content: 'מה קורה בסרטון?', attachments: [small.id] });
    assert.equal(inline.route.label, 'Gemini Flash');
    assert.equal(last('streamGenerateContent').body.contents.at(-1).parts[0].inlineData.mimeType, 'video/mp4');

    const large = (await upload(Buffer.alloc(4_000, 2), 'video/mp4', 'long.mp4')).body.attachment;
    const uploaded = await ask(await newChat(), { content: 'סכם את הסרטון', attachments: [large.id] });
    assert.ok(uploaded.events.some((event) => event.type === 'stage' && event.stage === 'upload'));
    assert.deepEqual(last('streamGenerateContent').body.contents.at(-1).parts[0], {
      fileData: { mimeType: 'video/mp4', fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/42' },
    });
    assert.equal(last('upload/v1beta/files').headers['X-Goog-Upload-Header-Content-Length'], '4000');
  });

  test('media made with the chat\'s generators is recorded in the conversation, and later models know about it', async () => {
    const id = await newChat();
    await store.insert('media', { id: 'made-1', ownerId: OWNER.id, kind: 'image', prompt: 'חתול על הירח', model: 'flux', options: {}, mime: 'image/png', size: 10, ms: 1_200, file: 'made-1.png', createdAt: new Date().toISOString() });
    const response = await post(`/chat/conversations/${id}/media`, { kind: 'image', mediaId: 'made-1' });
    assert.equal(response.status, 201);
    const made = await response.json();
    assert.deepEqual([made.userMessage.tool, made.userMessage.content], ['image', 'חתול על הירח']);
    assert.deepEqual([made.message.media.url, made.message.media.prompt], ['/api/media/made-1/file', 'חתול על הירח']);
    assert.equal(made.conversation.title, 'חתול על הירח');
    const stored = await (await api(`/chat/conversations/${id}`)).json();
    assert.equal(stored.conversation.messages.length, 2);
    rating = { complexity: 3, category: 'general', kind: 'question', output: 'short' };
    await ask(id, { content: 'מה יצרנו קודם?', premiumModel: 'haiku-4.5' });
    assert.match(JSON.stringify(last('api.anthropic.com').body.messages), /נוצרה תמונה ב-Pollinations \(flux\)/);
    const mismatch = await post(`/chat/conversations/${id}/media`, { kind: 'video', mediaId: 'made-1' });
    assert.equal(mismatch.status, 400);
    assert.match((await mismatch.json()).error.message, /לא נמצא/);
  });

  test('attachments that don\'t fit are refused in Hebrew before the answer starts', async () => {
    const image = (await upload(PNG, 'image/png', 'c.png')).body.attachment;
    const video = (await upload(Buffer.alloc(100), 'video/mp4', 'v.mp4')).body.attachment;
    const id = await newChat();
    const textOnly = await ask(id, { content: 'מה בתמונה?', premiumModel: 'deepseek-v4-pro', attachments: [image.id] });
    assert.equal(textOnly.error.code, 'ATTACHMENTS_UNSUPPORTED');
    assert.match(textOnly.error.message, /DeepSeek V4 Pro לא מקבל תמונות/);
    const free = await ask(id, { content: 'מה בתמונה?', workspace: 'free', freeMode: 'manual', provider: 'groq', attachments: [image.id] });
    assert.equal(free.error.code, 'ATTACHMENTS_UNSUPPORTED');
    const emergency = await ask(id, { content: 'מה בסרטון?', emergency: true, attachments: [video.id] });
    assert.match(emergency.error.message, HEBREW);
    const text = await upload(Buffer.from('hello'), 'text/plain', 'a.txt');
    assert.equal(text.status, 415);
    assert.match(text.body.error.message, /תמונה|וידאו/);
  });
});

// Last: the database outlives the server and whatever it was still writing.
after(() => database.stop());
