// AI calls: temporary failures are retried with backoff, errors stay Hebrew, and GEMINI_MODEL picks the model.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

process.env.AI_PROVIDER = 'gemini';
process.env.AI_API_KEY = 'test-key';
process.env.AI_MODEL = 'ignored-when-gemini-model-is-set';
process.env.GEMINI_MODEL = 'gemini-test-model';
process.env.AI_MAX_RETRIES = '3';
process.env.AI_RETRY_BASE_MS = '5'; // milliseconds instead of seconds, so the suite stays fast

const HEBREW = /[\u05D0-\u05EA]/;
const queue = [];
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  const next = queue.shift();
  if (!next) throw new Error('Unexpected request');
  return next();
};
const answer = () => () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
const failure = (status, error = {}, headers = {}) => () =>
  new Response(JSON.stringify({ error: { code: status, message: 'The model is overloaded. Please try again later.', ...error } }), { status, headers });
const dropped = () => () => {
  throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
};
const retryInfo = (delay) => ({ details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] });

const { AiError, completeJson } = await import('../src/services/ai/llmClient.js');
const ask = () => completeJson({ system: 'Answer in JSON.', prompt: 'Hello' });
console.warn = () => {}; // the retry log lines

beforeEach(() => {
  queue.length = 0;
  calls.length = 0;
});

describe('AI calls', () => {
  test('GEMINI_MODEL picks the Gemini model, ahead of AI_MODEL', async () => {
    queue.push(answer());
    const result = await ask();
    assert.deepEqual(result.data, { ok: true });
    assert.equal(result.model, 'gemini-test-model');
    assert.match(calls[0], /\/models\/gemini-test-model:generateContent$/);
  });

  test('a 503 is retried until the model answers', async () => {
    queue.push(failure(503), failure(503), answer());
    assert.deepEqual((await ask()).data, { ok: true });
    assert.equal(calls.length, 3);
  });

  test('after the last attempt the message is Hebrew, and the provider text is kept apart', async () => {
    queue.push(failure(503), failure(503), failure(503), failure(503));
    await assert.rejects(ask(), (error) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'AI_BUSY');
      assert.match(error.message, HEBREW);
      assert.match(error.message, /4 ניסיונות/);
      assert.match(error.message, /GEMINI_MODEL/);
      assert.doesNotMatch(error.message, /overloaded/, 'no English sentence inside the Hebrew message');
      assert.match(error.detail, /^HTTP 503 \(Gemini\): The model is overloaded/);
      return true;
    });
    assert.equal(calls.length, 4);
  });

  test('a 429 waits as long as Gemini asks (RetryInfo), then succeeds', async () => {
    queue.push(failure(429, retryInfo('1s')), answer());
    const started = Date.now();
    assert.deepEqual((await ask()).data, { ok: true });
    assert.ok(Date.now() - started >= 950, 'waited about a second');
    assert.equal(calls.length, 2);
  });

  test('Retry-After is honoured as well', async () => {
    queue.push(failure(429, {}, { 'retry-after': '1' }), answer());
    assert.deepEqual((await ask()).data, { ok: true });
    assert.equal(calls.length, 2);
  });

  test('a quota that resets in minutes fails at once and says when to try again', async () => {
    queue.push(failure(429, retryInfo('120s')));
    await assert.rejects(ask(), (error) => {
      assert.equal(error.code, 'AI_RATE_LIMITED');
      assert.match(error.message, /2 דקות/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  test('dropped connections are retried', async () => {
    queue.push(dropped(), answer());
    assert.deepEqual((await ask()).data, { ok: true });
    assert.equal(calls.length, 2);
  });

  test('client errors are not retried; a missing model names the setting to change', async () => {
    queue.push(failure(404, { message: 'models/gemini-test-model is not found for API version v1beta' }));
    await assert.rejects(ask(), (error) => {
      assert.equal(error.code, 'AI_MODEL_NOT_FOUND');
      assert.match(error.message, /gemini-test-model/);
      assert.match(error.message, /GEMINI_MODEL/);
      return true;
    });
    queue.push(failure(400, { message: 'API key not valid. Please pass a valid API key.' }));
    await assert.rejects(ask(), (error) => error.code === 'AI_UNAUTHORIZED');
    assert.equal(calls.length, 2);
  });
});
