// The AI workspace chat: catalog, premium routing and emergency mode, effort strategies, and the free workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { startTestDatabase, tempDir } from './helpers.js';

const storage = await tempDir('stash-chat-');
process.env.STORAGE_DIR = storage.dir;
process.env.LOG_REQUESTS = 'false';
process.env.LONG_TERM_MEMORY = 'off'; // the long-term memory and web research have their own suite (chatResearchMemory.test.js)
process.env.GEMINI_API_KEY = 'gemini-key';
process.env.ANTHROPIC_API_KEY = 'anthropic-key';
process.env.GROQ_API_KEY = 'groq-key';
process.env.OPENROUTER_API_KEY = 'openrouter-key';
delete process.env.AI_PROVIDER;
delete process.env.AI_PROVIDERS;
delete process.env.POLLINATIONS_API_KEY;
process.env.AI_RETRY_BASE_MS = '5';
// These tests pin models; the cost-saving handoff has its own suite (chatGateway.test.js).
process.env.CHAT_HANDOFF = 'off';

const HEBREW = /[\u05D0-\u05EA]/;
const realFetch = globalThis.fetch;
const calls = [];
let rating = { complexity: 8, category: 'code', reason: 'משימת קוד מורכבת' };
let groqScenario = 'normal';
let groqStreams = 0;

function sse(events) {
  const text = events.map((event) => (typeof event === 'string' ? `${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`)).join('');
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + 7));
        offset += 7;
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const claudeStream = (text) =>
  sse([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}',
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}`,
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
  ]);
const openaiStream = (text, reasoning) =>
  sse([
    ...(reasoning ? [{ choices: [{ delta: { reasoning } }] }] : []),
    { choices: [{ delta: { content: text.slice(0, 3) } }] },
    { choices: [{ delta: { content: text.slice(3) } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    'data: [DONE]',
  ]);
const systemOf = (body) => (typeof body.system === 'string' ? body.system : (body.messages?.find((message) => message.role === 'system')?.content ?? body.systemInstruction?.parts?.[0]?.text ?? ''));

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: href, headers: init.headers, body });
  if (href === 'https://api.groq.com/openai/v1/models') return json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-3.3-70b-versatile' }] });
  if (href === 'https://openrouter.ai/api/v1/models') return json({ data: [{ id: 'openrouter/free', pricing: { prompt: '0', completion: '0' } }] });
  if (href.startsWith('https://generativelanguage.googleapis.com/')) {
    const system = systemOf(body);
    if (system.includes('You route chat requests')) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(rating) }] } }] });
    return json({ candidates: [{ content: { parts: [{ text: 'תשובת Gemini Pro' }] } }] });
  }
  if (href === 'https://api.anthropic.com/v1/messages') {
    const system = systemOf(body);
    if (!body.stream) return json({ content: [{ type: 'text', text: 'תשובת Opus' }] });
    if (system.includes('Several expert models')) return claudeStream('תשובה מאוחדת');
    if (system.includes('Before answering, think privately')) return claudeStream('הערות תכנון');
    if (system.includes('write a complete first draft')) return claudeStream('טיוטה');
    if (system.includes('Review the draft')) return claudeStream('ביקורת');
    return claudeStream('תשובה מ-Claude');
  }
  if (href === 'https://api.groq.com/openai/v1/chat/completions') {
    if (body.model === 'llama-3.1-8b-instant') return json({ choices: [{ message: { content: JSON.stringify(rating) } }] });
    if (!body.stream) return json({ choices: [{ message: { content: 'תשובת Groq' } }] });
    groqStreams += 1;
    if (groqScenario === 'retry' && groqStreams === 1) return json({ error: { message: 'Over capacity' } }, 503);
    if (groqScenario === 'broken') return sse([{ choices: [{ delta: { content: 'התחלה' } }] }, { error: { message: 'Upstream model crashed' } }]);
    if (groqScenario === 'empty') return sse([{ choices: [{ delta: { reasoning: 'חושב וחושב' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }, 'data: [DONE]']);
    if (systemOf(body).includes('Several expert models')) return openaiStream('סיכום הסיעור');
    return openaiStream('שלום!', 'חושב');
  }
  if (href === 'https://openrouter.ai/api/v1/chat/completions') return json({ choices: [{ message: { content: 'תשובת OpenRouter' } }] });
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
const send = (method, route, body) => api(route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
async function ask(id, body) {
  const response = await send('POST', `/chat/conversations/${id}/messages`, body);
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('ndjson')) return { status: response.status, error: JSON.parse(text).error };
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  return { status: response.status, events, final: events.find((event) => event.type === 'done' || event.type === 'error'), route: events.find((event) => event.type === 'route')?.route };
}
const callsTo = (fragment) => calls.filter((call) => call.url.includes(fragment));
let chatId;

describe('AI workspace chat', () => {
  test('the catalog describes both workspaces, the premium models and the efforts', async () => {
    const catalog = await (await api('/chat/catalog')).json();
    assert.deepEqual(catalog.free.providers.map((provider) => provider.id), ['groq', 'openrouter']);
    assert.deepEqual(catalog.free.modes, ['manual', 'brainstorm', 'auto']);
    const models = Object.fromEntries(catalog.premium.models.map((model) => [model.id, model]));
    assert.equal(catalog.premium.defaultModel, 'opus-5.5');
    assert.equal(models['opus-5.5'].available, true);
    assert.equal(models['fable-5.1'].tag, 'דורש קרדיטי שימוש');
    assert.equal(models['gpt-5.5'].available, false);
    assert.equal(models['gpt-5.5'].keyEnv, 'OPENAI_API_KEY');
    assert.equal(models['gemini-pro'].more, true);
    assert.equal(catalog.premium.emergency.available, true);
    assert.deepEqual(catalog.efforts.map((effort) => effort.id), ['low', 'medium', 'high', 'extra', 'max']);
    assert.match(catalog.efforts.at(-1).tag, /5\.5/);
    chatId = (await (await send('POST', '/chat/conversations', {})).json()).conversation.id;
  });

  test('a manual premium model answers in one streamed call at low effort', async () => {
    const { final, route } = await ask(chatId, { content: 'שלום', workspace: 'premium', premiumModel: 'opus-5.5', effort: 'low' });
    assert.equal(route.mode, 'manual');
    assert.equal(route.label, 'Opus 5.5');
    assert.equal(final.message.content, 'תשובה מ-Claude');
    assert.equal(final.message.strategy, 'single');
    const request = callsTo('api.anthropic.com').at(-1).body;
    assert.equal(request.model, 'claude-opus-5-5');
    assert.deepEqual(request.thinking, { type: 'enabled', budget_tokens: 1024 });
  });

  test('the auto-router rates the task with Gemini Flash and picks the tier', async () => {
    rating = { complexity: 9, category: 'code', kind: 'planning', output: 'long', reason: 'משימת קוד מורכבת' };
    // With the team off, the tiers choose one model (the team itself is tested in chatPipeline.test.js).
    let result = await ask(chatId, { content: 'כתוב שרת Express עם אימות', workspace: 'premium', premiumModel: 'auto', pipeline: false });
    assert.deepEqual(
      { mode: result.route.mode, complexity: result.route.complexity, category: result.route.categoryLabel, by: result.route.by, label: result.route.label },
      { mode: 'auto', complexity: 9, category: 'קוד', by: 'gemini', label: 'Opus 5.5' },
    );
    const classifier = callsTo('generativelanguage').at(-1);
    assert.match(classifier.url, /models\/gemini-flash-latest:generateContent/);
    rating = { complexity: 2, category: 'quick', reason: 'שאלה קצרה' };
    result = await ask(chatId, { content: 'מה השעה בטוקיו?', workspace: 'premium' });
    assert.equal(result.route.label, 'Haiku 4.5');
    assert.equal(callsTo('api.anthropic.com').at(-1).body.model, 'claude-haiku-4-5-20251001');
  });

  test('emergency mode sends everything to Fable 5.1, even at Max effort', async () => {
    const { route, final, events } = await ask(chatId, { content: 'בעיה דחופה', workspace: 'premium', premiumModel: 'haiku-4.5', emergency: true, effort: 'max' });
    assert.equal(route.mode, 'emergency');
    assert.equal(route.label, 'Fable 5.1');
    assert.match(route.notice, HEBREW);
    assert.equal(final.message.strategy, 'reflect-critique');
    const models = new Set(callsTo('api.anthropic.com').slice(-3).map((call) => call.body.model));
    assert.deepEqual([...models], ['claude-fable-5-1']);
    assert.ok(!events.some((event) => event.type === 'expert'));
  });

  test('High effort streams a self-reflection before the answer', async () => {
    const before = callsTo('api.anthropic.com').length;
    const { events, final } = await ask(chatId, { content: 'תכנן ארכיטקטורה', workspace: 'premium', premiumModel: 'sonnet-5', effort: 'high' });
    const [plan, answer] = callsTo('api.anthropic.com').slice(before);
    assert.match(plan.body.system, /Before answering, think privately/);
    assert.match(answer.body.system, /# Your private notes for this answer[\s\S]*הערות תכנון/);
    assert.deepEqual(events.filter((event) => event.type === 'stage').map((event) => event.stage), ['reflect', 'answer']);
    assert.match(final.message.reasoning, /הערות תכנון/);
    assert.equal(final.message.content, 'תשובה מ-Claude');
  });

  test('Max effort asks the experts at once and the primary model merges them in Hebrew', async () => {
    const { events, final } = await ask(chatId, { content: 'השווה בין גישות', workspace: 'premium', premiumModel: 'opus-5.5', effort: 'max' });
    const experts = events.filter((event) => event.type === 'expert').map((event) => event.expert);
    assert.deepEqual(experts.map((expert) => expert.label).sort(), ['Gemini Pro', 'Opus 5.5']);
    assert.ok(experts.every((expert) => expert.ok));
    const synthesis = callsTo('api.anthropic.com').at(-1).body;
    assert.equal(synthesis.stream, true);
    assert.match(synthesis.system, /ONE final answer in Hebrew/);
    assert.match(synthesis.system, /תשובת Gemini Pro/);
    assert.equal(final.message.content, 'תשובה מאוחדת');
    assert.equal(final.message.experts.length, 2);
  });

  test('the free workspace: a chosen model streams, with its reasoning', async () => {
    const { final, route } = await ask(chatId, { content: 'שלום', workspace: 'free', freeMode: 'manual', provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'high' });
    assert.equal(route.mode, 'manual');
    assert.equal(final.message.content, 'שלום!');
    const request = callsTo('api.groq.com/openai/v1/chat/completions').at(-1).body;
    assert.equal(request.reasoning_effort, 'high');
  });

  test('Brainstorm asks every free model at once and one merges the answers', async () => {
    const { events, final, route } = await ask(chatId, { content: 'רעיונות לשם', workspace: 'free', freeMode: 'brainstorm' });
    assert.equal(route.mode, 'brainstorm');
    assert.deepEqual(events.filter((event) => event.type === 'expert').map((event) => event.expert.providerName).sort(), ['Groq', 'OpenRouter']);
    const synthesis = callsTo('api.groq.com/openai/v1/chat/completions').at(-1).body;
    assert.match(synthesis.messages[0].content, /in the user's language/);
    assert.equal(final.message.content, 'סיכום הסיעור');
  });

  test('Auto-Free rates the request with a small free model and routes it', async () => {
    rating = { complexity: 2, category: 'quick', reason: 'שאלה קצרה' };
    const { route } = await ask(chatId, { content: 'מה זה JSON?', workspace: 'free', freeMode: 'auto' });
    assert.equal(route.by, 'groq');
    assert.equal(route.model, 'openai/gpt-oss-20b');
    assert.ok(callsTo('api.groq.com').some((call) => call.body?.model === 'llama-3.1-8b-instant'));
  });

  test('a busy provider is retried; a broken stream keeps its text; an empty one is an error', async () => {
    groqScenario = 'retry';
    groqStreams = 0;
    let result = await ask(chatId, { content: 'שוב', workspace: 'free', freeMode: 'manual', provider: 'groq' });
    assert.ok(result.events.some((event) => event.type === 'retry' && event.attempt === 2));
    assert.equal(result.final.type, 'done');
    groqScenario = 'broken';
    result = await ask(chatId, { content: 'נסה', workspace: 'free', freeMode: 'manual', provider: 'groq' });
    assert.equal(result.final.type, 'error');
    assert.equal(result.final.message.content, 'התחלה');
    assert.match(result.final.message.error.message, HEBREW);
    groqScenario = 'empty';
    result = await ask(chatId, { content: 'ענה', workspace: 'free', freeMode: 'manual', provider: 'groq' });
    assert.equal(result.final.type, 'error');
    assert.equal(result.final.message.error.code, 'AI_EMPTY_ANSWER');
    assert.match(result.final.message.error.message, /מגבלת האורך/);
    assert.match(result.final.message.reasoning, /חושב וחושב/);
    groqScenario = 'normal';
  });

  test('regenerate replaces the last answer', async () => {
    const before = (await (await api(`/chat/conversations/${chatId}`)).json()).conversation.messages.length;
    const { final } = await ask(chatId, { regenerate: true, workspace: 'free', freeMode: 'manual', provider: 'groq' });
    assert.equal(final.type, 'done');
    assert.equal((await (await api(`/chat/conversations/${chatId}`)).json()).conversation.messages.length, before);
  });

  test('unavailable choices are refused in Hebrew before the answer starts', async () => {
    const empty = await ask(chatId, { content: '  ', workspace: 'premium' });
    assert.equal(empty.status, 400);
    const noKey = await ask(chatId, { content: 'שלום', workspace: 'premium', premiumModel: 'gpt-5.5' });
    assert.equal(noKey.error.code, 'MODEL_UNAVAILABLE');
    assert.match(noKey.error.message, /OPENAI_API_KEY/);
    const noProvider = await ask(chatId, { content: 'שלום', workspace: 'free', freeMode: 'manual', provider: 'cohere' });
    assert.equal(noProvider.error.code, 'PROVIDER_NOT_CONFIGURED');
    assert.match(noProvider.error.message, HEBREW);
  });

  test('deleting a conversation removes it; the media studio explains how to connect', async () => {
    assert.equal((await send('DELETE', `/chat/conversations/${chatId}`)).status, 204);
    assert.equal((await api(`/chat/conversations/${chatId}`)).status, 404);
    const response = await send('POST', '/media/generate', { kind: 'image', prompt: 'ספינה' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'MEDIA_NOT_CONFIGURED');
  });
});

// Last: the database outlives the server and whatever it was still writing.
after(() => database.stop());
