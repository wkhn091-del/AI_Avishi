// Mixture of experts: free providers answer at once, a synthesizer merges, failures are skipped.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

process.env.GEMINI_API_KEY = 'gemini-key';
process.env.GROQ_API_KEY = 'groq-key';
process.env.OPENROUTER_API_KEY = 'openrouter-key';
process.env.ANTHROPIC_API_KEY = 'anthropic-key'; // paid: not in the default ensemble
delete process.env.AI_PROVIDER;
delete process.env.AI_ENSEMBLE;
process.env.AI_RETRY_BASE_MS = '5';

const HEBREW = /[\u05D0-\u05EA]/;
const plan = { gemini: [], groq: [], openrouter: [], anthropic: [] };
const calls = [];
const providerOf = (href) =>
  href.includes('generativelanguage') ? 'gemini' : href.includes('groq.com') ? 'groq' : href.includes('openrouter.ai') ? 'openrouter' : href.includes('anthropic.com') ? 'anthropic' : null;

globalThis.fetch = async (url, init = {}) => {
  const provider = providerOf(String(url));
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ provider, url: String(url), headers: init.headers, body });
  const next = plan[provider]?.shift();
  if (!next) throw new Error(`Unexpected ${provider} request`);
  return next(body);
};
const geminiJson = (answer) => () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });
const openaiJson = (answer) => () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
const anthropicJson = (answer) => () => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(answer) }] }), { status: 200 });
const failure = (status, message) => () => new Response(JSON.stringify({ error: { message } }), { status });

const A = { title: 'תחזית ימית', description: 'אפליקציה לשייטים שמציגה רוח וגלים.', tags: ['שיט'] };
const B = { title: 'תחזית לשייטים', description: 'תחזית ימית עם רוח, גלים וגאות.', tags: ['ים'] };
const MERGED = { title: 'תחזית ימית לשייטים', description: 'אפליקציה לשייטים עם תחזית רוח, גלים וגאות.', tags: ['שיט', 'ים'] };
const ENGLISH = { title: 'Marine forecast', description: 'A sailing forecast app.', tags: ['sailing'] };

const { completeJsonAny, getAiStatus } = await import('../src/services/ai/llmClient.js');
const { runEnsemble } = await import('../src/services/ai/ensemble.js');
const { SYNTHESIS_PROMPT, SYSTEM_PROMPT, buildSynthesisPrompt, validateAnswer } = await import('../src/services/projects/summarizer.js');
console.warn = () => {};

const ensemble = () =>
  runEnsemble({
    system: SYSTEM_PROMPT,
    prompt: 'Archive name: harbor-weather',
    members: ['gemini', 'groq', 'openrouter'],
    synthesizer: 'gemini',
    validate: validateAnswer,
    synthesis: { system: SYNTHESIS_PROMPT, prompt: (candidates) => buildSynthesisPrompt('Archive name: harbor-weather', candidates) },
  });

beforeEach(() => {
  for (const queue of Object.values(plan)) queue.length = 0;
  calls.length = 0;
});

describe('AI ensemble', () => {
  test('the configured free providers form the ensemble, and the primary one merges', () => {
    const ai = getAiStatus();
    assert.equal(ai.provider, 'gemini');
    assert.deepEqual(ai.ensemble, ['gemini', 'groq', 'openrouter']);
    assert.equal(ai.synthesizer, 'gemini');
    assert.equal(ai.providers.find((provider) => provider.id === 'anthropic').configured, true);
    assert.equal(ai.providers.find((provider) => provider.id === 'cohere').configured, false);
  });

  test('all providers answer at once; a busy one is skipped after its retries; the synthesizer merges', async () => {
    plan.gemini.push(geminiJson(A), geminiJson(MERGED));
    plan.groq.push(failure(503, 'Service unavailable'), failure(503, 'Service unavailable'), failure(503, 'Service unavailable'), failure(503, 'Service unavailable'));
    plan.openrouter.push(openaiJson(B));
    const result = await ensemble();
    assert.deepEqual(result.data, MERGED);
    assert.equal(result.ensemble.synthesizer.provider, 'gemini');
    const groq = result.ensemble.members.find((member) => member.provider === 'groq');
    assert.equal(groq.ok, false);
    assert.equal(groq.code, 'AI_BUSY');
    assert.match(groq.message, HEBREW);
    assert.equal(calls.filter((call) => call.provider === 'groq').length, 4);
    const synthesis = JSON.stringify(calls.filter((call) => call.provider === 'gemini').at(-1).body);
    assert.match(synthesis, /Candidate summaries/);
    assert.match(synthesis, /תחזית לשייטים/);
  });

  test('an answer that is not in Hebrew is rejected, and the synthesis moves to a provider that answered', async () => {
    plan.gemini.push(geminiJson(ENGLISH));
    plan.groq.push(openaiJson(B), openaiJson(MERGED));
    plan.openrouter.push(openaiJson(A));
    const result = await ensemble();
    assert.equal(result.ensemble.members.find((member) => member.provider === 'gemini').ok, false);
    assert.equal(result.ensemble.synthesizer.provider, 'groq');
    assert.deepEqual(result.data, MERGED);
  });

  test('when the synthesizer fails, the next provider that answered merges', async () => {
    plan.gemini.push(geminiJson(A), failure(400, 'Bad request'));
    plan.groq.push(openaiJson(B), openaiJson(MERGED));
    plan.openrouter.push(openaiJson(A));
    const result = await ensemble();
    assert.equal(result.ensemble.synthesizer.provider, 'groq');
  });

  test('only when every provider fails does the ensemble fail, with a Hebrew message', async () => {
    plan.gemini.push(failure(400, 'API key not valid. Please pass a valid API key.'));
    plan.groq.push(failure(503, 'Over capacity'), failure(503, 'Over capacity'), failure(503, 'Over capacity'), failure(503, 'Over capacity'));
    plan.openrouter.push(failure(402, 'Insufficient credits'));
    await assert.rejects(ensemble(), (error) => {
      assert.match(error.message, HEBREW);
      assert.match(error.message, /Gemini, Groq, OpenRouter/);
      assert.match(error.detail, /Groq: HTTP 503/);
      assert.match(error.detail, /OpenRouter: HTTP 402/);
      return true;
    });
  });

  test('a single request falls back to the next provider in order', async () => {
    plan.gemini.push(geminiJson(ENGLISH));
    plan.anthropic.push(anthropicJson(A));
    const result = await completeJsonAny({ system: SYSTEM_PROMPT, prompt: 'Archive name: harbor-weather', validate: validateAnswer });
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.fallbacks[0].provider, 'gemini');
    const request = calls.at(-1);
    assert.equal(request.headers['x-api-key'], 'anthropic-key');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.body.max_tokens, 2048);
  });

  test('a provider that rejects an optional parameter gets the request again without it', async () => {
    plan.gemini.push(geminiJson(ENGLISH));
    plan.anthropic.push(failure(400, 'Bad request: messages missing'));
    plan.groq.push(failure(400, 'response_format is not supported with this model'), openaiJson(A));
    const result = await completeJsonAny({ system: SYSTEM_PROMPT, prompt: 'Archive name: harbor-weather', validate: validateAnswer });
    assert.equal(result.provider, 'groq');
    const [first, second] = calls.filter((call) => call.provider === 'groq');
    assert.deepEqual(first.body.response_format, { type: 'json_object' });
    assert.equal(second.body.response_format, undefined);
  });
});
