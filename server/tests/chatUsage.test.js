// The per-chat token and cost meter: prices, recording every model call of a turn, and conversation totals.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { OWNER, startTestDatabase, tempDir } from './helpers.js';

const storage = await tempDir('stash-usage-');
process.env.STORAGE_DIR = storage.dir;
process.env.LOG_REQUESTS = 'false';
process.env.LONG_TERM_MEMORY = 'off'; // the long-term memory and web research have their own suite (chatResearchMemory.test.js)
process.env.ANTHROPIC_API_KEY = 'anthropic-key';
process.env.GEMINI_API_KEY = 'gemini-key';
process.env.DEEPSEEK_API_KEY = 'deepseek-key';
process.env.GROQ_API_KEY = 'groq-key';
process.env.CHAT_COMPACT_EVERY = '2';
process.env.MODEL_PRICES = '{"my-model": {"input": 1, "output": 2}, "broken": {"input": "x"}}';
process.env.COST_FREE_PROVIDERS = 'moonshot';
process.env.AI_RETRY_BASE_MS = '5';
delete process.env.AI_PROVIDER;
delete process.env.AI_PROVIDERS;
delete process.env.CHAT_HANDOFF;
delete process.env.AUTO_CONTINUE_MAX;

const realFetch = globalThis.fetch;
let rating = { complexity: 3, category: 'general', kind: 'question', output: 'short' };
let scenario = 'normal';
const sse = (events) =>
  new Response(events.map((event) => (typeof event === 'string' ? `${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`)).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const systemOf = (body) => body.system ?? body.systemInstruction?.parts?.[0]?.text ?? body.messages?.find((message) => message.role === 'system')?.content ?? '';

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
  if (href === 'https://api.groq.com/openai/v1/models') return json({ data: [] });
  if (href === 'https://api.anthropic.com/v1/messages') {
    const text = scenario === 'truncate' ? '```js a.js\nconst a = 1;\n' : 'תשובה מ-Claude';
    return sse([
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1_000, output_tokens: 1 } } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: scenario === 'truncate' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 500 } })}`,
    ]);
  }
  if (href === 'https://api.deepseek.com/chat/completions') {
    const usage = scenario === 'no-usage' ? [] : [{ choices: [], usage: { prompt_tokens: 1_200, completion_tokens: 300, prompt_cache_hit_tokens: 1_000 } }];
    return sse([{ choices: [{ delta: { content: 'const b = 2;\n```\n' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, ...usage, 'data: [DONE]']);
  }
  if (href.startsWith('https://generativelanguage.googleapis.com/')) {
    if (systemOf(body).includes('You route chat requests')) {
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(rating) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 } });
    }
    if (href.includes(':generateContent')) {
      return json({ candidates: [{ content: { parts: [{ text: '# Project state\n- שיחה על קוד' }] } }], usageMetadata: { promptTokenCount: 2_000, candidatesTokenCount: 100 } });
    }
    return sse([{ candidates: [{ content: { parts: [{ text: 'תשובה מ-Gemini' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 50, thoughtsTokenCount: 150 } }]);
  }
  throw new Error(`Unexpected request: ${href}`);
};

const database = await startTestDatabase();
const { createApp } = await import('../src/app.js');
const { chatSessions } = await import('../src/services/chat/chatSessions.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { costOf, priceFor, savingOf } = await import('../src/services/ai/pricing.js');
console.warn = () => {};

let server;
let base;
let store;
before(async () => {
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

const post = (route, body) => realFetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async (route) => (await realFetch(`${base}${route}`)).json();
const newChat = async () => (await (await post('/chat/conversations', {})).json()).conversation.id;
async function ask(id, body) {
  const text = await (await post(`/chat/conversations/${id}/messages`, { workspace: 'premium', effort: 'low', ...body })).text();
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  return { events, final: events.find((event) => event.type === 'done' || event.type === 'error') };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

describe('Cost meter: prices', () => {
  test('input, cached input and output are priced per 1M tokens', () => {
    const at = '2026-09-25T12:00:00Z';
    near(costOf({ provider: 'anthropic', model: 'claude-opus-5-5', input: 1_000_000, output: 1_000_000, at }), 24);
    near(costOf({ provider: 'anthropic', model: 'claude-opus-5-5', input: 1_000_000, cached: 500_000, output: 1_000_000, at }), 2 + 0.1 + 20);
    near(costOf({ provider: 'openai', model: 'gpt-4o-mini', input: 2_000_000, output: 1_000_000, at }), 0.3 + 0.6);
  });

  test('DeepSeek costs half off-peak; Gemini Flash follows its dated price; Gemini Pro has a long-context rate', () => {
    const call = { provider: 'deepseek', model: 'deepseek-flash', input: 0, output: 1_000_000 };
    near(costOf({ ...call, at: '2026-09-25T07:00:00Z' }), 1.2); // Friday, 07:00 UTC: peak
    near(costOf({ ...call, at: '2026-09-25T12:00:00Z' }), 0.6); // Friday, noon: off-peak
    near(costOf({ ...call, at: '2026-09-26T07:00:00Z' }), 0.6); // Saturday
    const flash = { provider: 'gemini', model: 'gemini-flash-latest', input: 1_000_000, output: 1_000_000 };
    near(costOf({ ...flash, at: '2026-12-31T23:00:00Z' }), 4.5);
    near(costOf({ ...flash, at: '2027-01-02T00:00:00Z' }), 9);
    near(costOf({ provider: 'gemini', model: 'gemini-pro-latest', input: 300_000, output: 0, at: '2026-09-25T12:00:00Z' }), 1.2);
  });

  test('free providers cost nothing, MODEL_PRICES adds prices, and unknown models have no price', () => {
    assert.equal(costOf({ provider: 'groq', model: 'openai/gpt-oss-120b', input: 5_000, output: 5_000, at: '2026-09-25T12:00:00Z' }), 0);
    assert.equal(priceFor('moonshot', 'kimi-k3').free, true, 'COST_FREE_PROVIDERS');
    near(costOf({ provider: 'openai', model: 'my-model', input: 1_000_000, output: 1_000_000, at: '2026-09-25T12:00:00Z' }), 3);
    assert.equal(costOf({ provider: 'openai', model: 'broken', input: 1, output: 1, at: '2026-09-25T12:00:00Z' }), null);
    assert.equal(costOf({ provider: 'anthropic', model: 'claude-unknown', input: 1, output: 1, at: '2026-09-25T12:00:00Z' }), null);
  });

  test('a handed-off call saves the difference to the model it replaced', () => {
    const call = { provider: 'deepseek', model: 'deepseek-flash', input: 100_000, output: 100_000, at: '2026-09-25T12:00:00Z', insteadOf: { provider: 'anthropic', model: 'claude-opus-5-5' } };
    near(savingOf(call), 0.4 + 2 - (0.015 + 0.06));
  });
});

describe('Cost meter: conversations', () => {
  test('every call of a turn is recorded with its role; costs come with the message and the conversation', async () => {
    scenario = 'truncate';
    const id = await newChat();
    const { final, events } = await ask(id, { content: 'כתוב קוד', premiumModel: 'opus-5.5' });
    const calls = final.message.usage.calls;
    assert.deepEqual(calls.map((call) => [call.role, call.provider, call.model, call.input, call.output, call.cached]), [
      ['answer', 'anthropic', 'claude-opus-5-5', 1_000, 500, undefined],
      ['continuation', 'deepseek', 'deepseek-flash', 1_200, 300, 1_000],
    ]);
    assert.deepEqual(calls[1].insteadOf, { provider: 'anthropic', model: 'claude-opus-5-5' });
    near(calls[0].cost, 0.004 + 0.01);
    near(final.message.usage.cost, calls[0].cost + calls[1].cost);
    assert.ok(final.message.usage.saved > 0, 'the continuation on DeepSeek saved money');
    assert.deepEqual([final.message.usage.input, final.message.usage.output], [2_200, 800]);
    near(events.find((event) => event.type === 'done').conversationUsage.cost, final.message.usage.cost);
    assert.equal(calls[0].label, 'Opus 5.5');
  });

  test('the router, Gemini thinking tokens, estimates and memory updates count too', async () => {
    scenario = 'normal';
    const id = await newChat();
    const first = await ask(id, { content: 'שאלה ראשונה', premiumModel: 'auto', effort: 'low' });
    rating = { complexity: 3, category: 'general', kind: 'question', output: 'short' };
    assert.deepEqual(first.final.message.usage.calls.map((call) => [call.role, call.provider, call.input, call.output]), [
      ['router', 'gemini', 300, 20],
      ['answer', 'anthropic', 1_000, 500],
    ]);

    scenario = 'no-usage';
    const second = await ask(id, { content: 'כתוב עוד', premiumModel: 'deepseek-flash' });
    const estimated = second.final.message.usage.calls[0];
    assert.equal(estimated.estimated, true);
    assert.ok(estimated.input > 0 && estimated.output > 0);
    assert.equal(second.final.message.usage.estimated, true);

    // CHAT_COMPACT_EVERY=2: the second turn updated project_state.md, and its model call is counted.
    const conversation = (await get(`/chat/conversations/${id}`)).conversation;
    const detail = await get(`/chat/conversations/${id}/usage`);
    assert.deepEqual(detail.usage.byRole.map((row) => row.role).sort(), ['answer', 'memory', 'router']);
    assert.equal(detail.usage.byRole.find((row) => row.role === 'memory').label, 'זיכרון');
    near(conversation.usage.cost, detail.usage.cost);
    near(conversation.cost, detail.usage.cost);
    assert.ok(detail.all.cost >= detail.usage.cost && detail.all.conversations >= 2);
    assert.equal(detail.pricesChecked, '2026-09-26');
    const list = (await get('/chat/conversations')).conversations;
    near(list.find((item) => item.id === id).cost, detail.usage.cost);

    scenario = 'normal';
    const gemini = await ask(await newChat(), { content: 'שאלה', premiumModel: 'gemini-flash' });
    assert.equal(gemini.final.message.usage.calls[0].output, 200, 'thinking tokens are billed as output');
  });

  test('messages saved before the meter are priced from their totals', async () => {
    const id = await newChat();
    // An old conversation, written straight into the database.
    await chatSessions(OWNER.id).update(id, {
      messages: [
        { id: 'u1', role: 'user', content: 'שלום', createdAt: '2026-09-01T12:00:00Z' },
        { id: 'a1', role: 'assistant', content: 'היי', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', usage: { input: 1_000, output: 1_000 }, createdAt: '2026-09-01T12:00:00Z' },
      ],
    });
    const conversation = (await get(`/chat/conversations/${id}`)).conversation;
    near(conversation.messages[1].usage.cost, 0.001 + 0.005);
    near(conversation.cost, 0.006);
  });
});

// Last: the database outlives the server and whatever it was still writing.
after(() => database.stop());
