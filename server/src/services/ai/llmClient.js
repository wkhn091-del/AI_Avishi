/**
 * Multi-provider LLM client. No SDKs, just fetch:
 *
 *   gemini       Google Gemini API (generateContent, streamGenerateContent)
 *   anthropic    Anthropic Messages API
 *   openai-style OpenAI, Groq, OpenRouter, Cohere (compatibility API), the Hugging Face router, Pollinations
 *
 *   completeJson()     one prompt → one JSON object, from one provider
 *   completeJsonAny()  the same, trying the configured providers in turn until one succeeds
 *   streamChat()       a chat reply, streamed while it is written
 *   listModels()       a provider's current models (live, cached for an hour)
 *
 * Keys come from server/.env (see providers.js). They are only ever sent in
 * request headers, never logged, and redacted from any error text a provider
 * echoes back.
 *
 * Temporary failures (HTTP 429, 500, 502, 503, 504 and dropped connections) are
 * retried with exponential backoff, 2 s, 4 s, 8 s by default (AI_MAX_RETRIES,
 * AI_RETRY_BASE_MS), with jitter. When the provider says how long to wait
 * (Retry-After, OpenRouter's reset header, Gemini's RetryInfo), that wait is
 * used instead; if it is longer than 30 s the quota won't reset soon, so the
 * call fails at once with a Hebrew message that says when to try again.
 * Timeouts aren't retried: each attempt already waited AI_TIMEOUT_MS.
 */
import { config } from '../../config.js';
import { isolate } from '../../lib/bidi.js';
import { HttpError } from '../../lib/httpError.js';
import { retryAfterOf, withRetries } from '../../lib/retry.js';
import { PROVIDERS, providerById, supportsReasoning } from './providers.js';
import { estimateTokens, metering, recordCall } from './usageMeter.js';

/** Used when a provider's model isn't configured. */
export const DEFAULT_MODELS = Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.defaultModel])));

/** Rate limits and temporary server trouble: worth another attempt. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
/** A provider asking for a longer pause than this has a quota that won't reset soon. */
const MAX_SUGGESTED_WAIT_MS = 30_000;
/** A stream that sends nothing for this long is treated as stuck. */
const STREAM_IDLE_MS = 90_000;
const MODEL_LIST_TTL_MS = 60 * 60_000;
const MODEL_LIST_RETRY_MS = 5 * 60_000;
/** A 400 mentioning one of these is retried once without the optional parameters. */
const RELAXABLE =
  /response_format|json|temperature|reasoning|thinking|max_tokens|max_completion_tokens|max_output_tokens|stream_options|not supported|unsupported|unknown (field|parameter)|unrecognized|additional properties/i;
const DONE = Symbol('done');

/**
 * A failed AI call. The summarizer and the explainer catch these.
 *
 * `message` is Hebrew and shown in the UI. `log` is the English version for the
 * server console, since most terminals can't display right-to-left text.
 * `detail` is the provider's own (English) text; the UI shows it apart from the
 * Hebrew message, so the two languages never share a sentence.
 */
export class AiError extends Error {
  constructor(message, { status, code = 'AI_FAILED', log, detail = null, retryable = false, retryAfterMs = null, provider = null } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code;
    this.log = log ?? message;
    this.detail = detail;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.provider = provider;
  }
}

/** The API error for a failed AI call: the Hebrew message, with the provider's text in `details.detail`. */
export function aiHttpError(error) {
  const temporary = error.code === 'AI_BUSY' || error.code === 'AI_RATE_LIMITED';
  return new HttpError(temporary ? 503 : 502, error.message, error.code ?? 'AI_FAILED', error.detail ? { detail: error.detail } : undefined);
}

// ---------------------------------------------------------------------------
// Which providers are configured

const keyOf = (id) =>
  config.ai.provider === 'none' || (config.ai.enabled && !config.ai.enabled.includes(id)) ? '' : config.ai.keys[id] || '';
export const isConfigured = (id) => Boolean(keyOf(id));
/** The API key of a configured provider (for its file uploads). */
export const keyFor = (id) => keyOf(id);
export const modelOf = (id) => config.ai.models[id] || providerById(id)?.defaultModel || '';

/** Providers with a key, in preference order. */
export function configuredProviders() {
  return PROVIDERS.filter((provider) => keyOf(provider.id));
}

/** AI_PROVIDER when it is configured, otherwise the first configured provider. */
export function primaryProvider() {
  const configured = configuredProviders();
  return configured.find((provider) => provider.id === config.ai.provider) ?? configured[0] ?? null;
}

/** The providers asked at once for project summaries (AI_ENSEMBLE). One provider means no ensemble. */
export function ensembleProviders() {
  const configured = configuredProviders();
  const primary = primaryProvider();
  if (!primary) return [];
  const setting = config.ai.ensemble;
  if (setting === 'off') return [primary];
  if (setting === 'all') return configured;
  if (setting === 'free') {
    const free = configured.filter((provider) => provider.free);
    return free.length ? free : [primary];
  }
  const listed = setting.split(',').map((id) => id.trim());
  const chosen = configured.filter((provider) => listed.includes(provider.id));
  return chosen.length ? chosen : [primary];
}

/** The provider that merges the ensemble's answers: AI_SYNTHESIZER, or the primary provider. */
export function synthesizerProvider() {
  return configuredProviders().find((provider) => provider.id === config.ai.synthesizer) ?? primaryProvider();
}

/** What the dashboard shows about AI: the primary provider, the ensemble and every provider's state. */
export function getAiStatus() {
  const primary = primaryProvider();
  const ensemble = ensembleProviders();
  const named = providerById(config.ai.provider);
  return {
    enabled: Boolean(primary),
    provider: primary?.id ?? 'none',
    providerName: primary?.name ?? null,
    model: primary ? modelOf(primary.id) : null,
    // AI_PROVIDER names a provider whose key is missing.
    missingKey: Boolean(named && !keyOf(named.id)),
    off: config.ai.provider === 'none',
    ensemble: ensemble.length > 1 ? ensemble.map((provider) => provider.id) : [],
    synthesizer: ensemble.length > 1 ? (synthesizerProvider()?.id ?? null) : null,
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      name: provider.name,
      configured: Boolean(keyOf(provider.id)),
      model: modelOf(provider.id),
      free: provider.free,
      workspace: provider.workspace ?? null,
      keyEnv: provider.keyEnv,
      modelEnv: provider.modelEnv,
      keyUrl: provider.keyUrl,
    })),
  };
}

function resolve(providerId) {
  const provider = providerId ? providerById(providerId) : primaryProvider();
  if (!provider || !keyOf(provider.id)) {
    const message = providerId
      ? `הספק ${provider?.name ?? isolate(providerId)} אינו מוגדר: חסר מפתח API בקובץ server/.env.`
      : 'אין ספק AI מוגדר. הוסיפו מפתח API של ספק אחד לפחות בקובץ server/.env.';
    throw new AiError(message, { code: 'AI_DISABLED', log: `AI provider ${providerId ?? '(primary)'} is not configured.` });
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Requests

/**
 * Builds the HTTP request for one call.
 * params: { temperature?, maxTokens?, effort?: 'default'|'low'|'medium'|'high' }
 */
/**
 * Token counts in one shape for every API: input (all prompt tokens, cached ones
 * included), output (billed output, thinking included), reasoning (the thinking
 * part, for display) and cached (prompt tokens read from the provider's cache).
 * A field the event doesn't carry is null, so partial stream events can be merged.
 */
function normalizeUsage(api, raw) {
  if (!raw) return null;
  const n = (value) => (Number.isFinite(value) ? value : null);
  if (api === 'gemini') {
    const candidates = n(raw.candidatesTokenCount);
    const thoughts = n(raw.thoughtsTokenCount);
    return {
      input: n(raw.promptTokenCount),
      output: candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0),
      reasoning: thoughts,
      cached: n(raw.cachedContentTokenCount),
    };
  }
  if (api === 'anthropic') {
    const input = n(raw.input_tokens);
    return {
      input: input === null ? null : input + (n(raw.cache_read_input_tokens) ?? 0) + (n(raw.cache_creation_input_tokens) ?? 0),
      output: n(raw.output_tokens),
      cached: n(raw.cache_read_input_tokens),
    };
  }
  return {
    input: n(raw.prompt_tokens),
    output: n(raw.completion_tokens),
    reasoning: n(raw.completion_tokens_details?.reasoning_tokens),
    cached: n(raw.prompt_tokens_details?.cached_tokens) ?? n(raw.prompt_cache_hit_tokens) ?? n(raw.cached_tokens),
  };
}

const IMAGE_TOKENS = 1_600;

/** Records a finished call in the chat turn's meter; counts the provider didn't report are estimated. */
function meterCall(provider, model, usage, { system, messages, text = '', reasoning = '' }) {
  if (!metering()) return;
  const reported = (field) => Number.isFinite(usage?.[field]);
  if (!reported('input') && !reported('output') && !text && !reasoning) return;
  const input = reported('input')
    ? usage.input
    : estimateTokens(system) +
      messages.reduce((sum, message) => sum + estimateTokens(message.content) + (message.media ?? []).filter((item) => item.kind === 'image').length * IMAGE_TOKENS, 0);
  const output = reported('output') ? usage.output : estimateTokens(text) + estimateTokens(reasoning);
  recordCall({
    provider: provider.id,
    model,
    input,
    output,
    cached: usage?.cached || undefined,
    reasoning: usage?.reasoning || undefined,
    estimated: !reported('input') || !reported('output') || undefined,
  });
}

/**
 * A message's content in the provider's format. `message.media` holds images
 * (base64) and videos (base64, or a Gemini file URI) attached to that message.
 */
function contentFor(provider, message) {
  const media = message.media ?? [];
  if (!media.length) return provider.api === 'gemini' ? [{ text: message.content }] : message.content;
  if (provider.api === 'gemini') {
    return [
      ...media.map((item) => (item.fileUri ? { fileData: { mimeType: item.mime, fileUri: item.fileUri } } : { inlineData: { mimeType: item.mime, data: item.data } })),
      { text: message.content },
    ];
  }
  if (media.some((item) => item.kind !== 'image')) {
    throw new AiError(`${provider.name} לא מקבל וידאו. וידאו נשלח רק ל-Gemini.`, { code: 'AI_BAD_REQUEST', log: `${provider.name} got a video.`, provider: provider.id });
  }
  if (provider.api === 'anthropic') {
    return [...media.map((item) => ({ type: 'image', source: { type: 'base64', media_type: item.mime, data: item.data } })), { type: 'text', text: message.content }];
  }
  return [{ type: 'text', text: message.content }, ...media.map((item) => ({ type: 'image_url', image_url: { url: `data:${item.mime};base64,${item.data}` } }))];
}

// Reasoning models count their thinking against the output limit, so the limit gets room for it on top of
// the answer (within the model's maximum) and thinking can't use up the answer. Anthropic's budget is below.
const THINKING_RESERVE = Object.freeze({ low: 2_048, medium: 8_192, high: 16_384 });

function buildRequest(provider, model, { system, messages, json = false, stream = false, params = {} }) {
  const key = keyOf(provider.id);
  const maxTokens = params.maxTokens && params.maxOutput ? Math.min(params.maxTokens, params.maxOutput) : params.maxTokens;
  const temperature = typeof params.temperature === 'number' ? params.temperature : undefined;
  const effort = params.effort && params.effort !== 'default' && supportsReasoning(provider.id, model) ? params.effort : null;
  const reserve = effort && maxTokens && provider.api !== 'anthropic' ? (THINKING_RESERVE[effort] ?? 0) : 0;
  const outputLimit = reserve ? Math.min(maxTokens + reserve, Math.max(params.maxOutput ?? Infinity, maxTokens)) : maxTokens;

  if (provider.api === 'gemini') {
    const generationConfig = {};
    if (json) generationConfig.responseMimeType = 'application/json';
    if (temperature !== undefined) generationConfig.temperature = temperature;
    if (outputLimit) generationConfig.maxOutputTokens = outputLimit;
    if (effort) generationConfig.thinkingConfig = { thinkingLevel: effort, includeThoughts: !json };
    const name = encodeURIComponent(model.replace(/^models\//, ''));
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${name}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
      headers: { 'x-goog-api-key': key },
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: contentFor(provider, message) })),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      },
    };
  }

  if (provider.api === 'anthropic') {
    const budget = effort ? { low: 1_024, medium: 4_096, high: 12_000 }[effort] : 0;
    // max_tokens covers the thinking too, so the answer gets its full length on top of the budget.
    const total = (maxTokens ?? (json ? 2_048 : 4_096)) + budget;
    const body = {
      model,
      max_tokens: params.maxOutput ? Math.min(total, params.maxOutput + budget) : total,
      messages: messages.map((message) => ({ role: message.role, content: contentFor(provider, message) })),
    };
    if (system) body.system = system;
    if (stream) body.stream = true;
    // With thinking on, Anthropic requires the default temperature.
    if (budget) body.thinking = { type: 'enabled', budget_tokens: budget };
    else if (temperature !== undefined) body.temperature = Math.min(temperature, 1);
    return { url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body };
  }

  const body = {
    model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map((message) => ({ role: message.role, content: contentFor(provider, message) }))],
  };
  if (json) body.response_format = { type: 'json_object' };
  if (stream) {
    body.stream = true;
    if (provider.streamUsage) body.stream_options = { include_usage: true };
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (outputLimit) body[provider.tokenField ?? 'max_tokens'] = outputLimit;
  if (effort && provider.reasoningField === 'reasoning') body.reasoning = { effort };
  else if (effort && provider.reasoningField) body.reasoning_effort = effort;
  return { url: `${provider.baseUrl}/chat/completions`, headers: { authorization: `Bearer ${key}`, ...(provider.headers ?? {}) }, body };
}

/** The same request without optional parameters, for providers that reject one of them. */
function relax(provider, request) {
  const body = structuredClone(request.body);
  if (provider.api === 'gemini') {
    if (!body.generationConfig) return null;
    delete body.generationConfig.thinkingConfig;
    delete body.generationConfig.temperature;
    delete body.generationConfig.maxOutputTokens;
  } else if (provider.api === 'anthropic') {
    if (!body.thinking && body.temperature === undefined) return null;
    delete body.thinking;
    delete body.temperature;
  } else {
    for (const field of ['response_format', 'temperature', 'reasoning', 'reasoning_effort', 'stream_options', 'max_tokens', 'max_completion_tokens']) delete body[field];
  }
  return JSON.stringify(body) === JSON.stringify(request.body) ? null : { ...request, body };
}

function networkFailure(error, provider) {
  if (error.name === 'TimeoutError') {
    const seconds = Math.round(config.ai.timeoutMs / 1000);
    return new AiError(`לא התקבלה תשובה מ-${provider.name} תוך ${seconds} שניות.`, {
      code: 'AI_TIMEOUT',
      log: `${provider.name} did not answer within ${seconds} s.`,
      provider: provider.id,
    });
  }
  const reason = String(error.cause?.code ?? error.message);
  return new AiError(`אין חיבור אל ${provider.name}.`, {
    code: 'AI_UNREACHABLE',
    log: `Could not reach ${provider.name} (${reason}).`,
    detail: reason,
    retryable: true,
    provider: provider.id,
  });
}

/** Maps an HTTP error answer to an AiError: retryable or not, with a specific Hebrew message where it helps. */
function httpFailure(response, payload, raw, provider, model) {
  const name = provider.name;
  const code = response.status;
  const text = String(payload?.error?.message ?? payload?.message ?? raw.slice(0, 240))
    .replaceAll(keyOf(provider.id) || '\u0000', '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  const shared = {
    status: code,
    provider: provider.id,
    log: `${name} returned HTTP ${code}${text ? `: ${text}` : '.'}`,
    detail: `HTTP ${code} (${name})${text ? `: ${text}` : ''}`,
  };
  if (RETRYABLE_STATUSES.has(code)) {
    return new AiError(`התקבלה שגיאת HTTP ${code} מ-${name}.`, {
      ...shared,
      code: code === 429 ? 'AI_RATE_LIMITED' : 'AI_BUSY',
      retryable: true,
      retryAfterMs: retryAfterOf(response.headers, payload),
    });
  }
  if (code === 402) {
    return new AiError(`נגמרה יתרת הקרדיטים אצל ${name}. אפשר להטעין יתרה, לחכות למכסה הבאה או לבחור ספק אחר.`, { ...shared, code: 'AI_PAYMENT_REQUIRED' });
  }
  if (code === 404) {
    return new AiError(
      `המודל ${isolate(model)} לא נמצא אצל ${name}, או שכבר אינו זמין. בחרו מודל אחר במשתנה ${provider.modelEnv} בקובץ server/.env.`,
      { ...shared, code: 'AI_MODEL_NOT_FOUND' },
    );
  }
  if (code === 401 || code === 403 || (code === 400 && /api key/i.test(text))) {
    return new AiError(`מפתח ה-API נדחה על ידי ${name}. בדקו את ${provider.keyEnv} בקובץ server/.env.`, { ...shared, code: 'AI_UNAUTHORIZED' });
  }
  return new AiError(`התקבלה שגיאת HTTP ${code} מ-${name}.`, { ...shared, code: 'AI_HTTP_ERROR' });
}

/** The error to report after the last attempt: a clearer Hebrew message for temporary failures. */
function giveUp(error, provider) {
  if (!(error instanceof AiError) || !error.retryable) return error;
  const attempts = error.attempts ?? 1;
  const name = provider.name;
  const setting = provider.modelEnv;
  const tried = attempts > 1 ? ` גם אחרי ${attempts} ניסיונות` : '';
  const fields = {
    status: error.status,
    code: error.code,
    detail: error.detail,
    retryAfterMs: error.retryAfterMs,
    provider: provider.id,
    log: `${error.log} Gave up after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
  };
  if (error.code === 'AI_RATE_LIMITED') {
    const message =
      error.retryAfterMs > MAX_SUGGESTED_WAIT_MS
        ? `הגעתם למכסת הבקשות של ${name}. אפשר לנסות שוב בעוד ${formatWait(error.retryAfterMs)}, או לבחור מודל אחר במשתנה ${setting}.`
        : `הגעתם למכסת הבקשות של ${name}, והיא לא התפנתה${tried}. נסו שוב בעוד כמה דקות, או בחרו מודל אחר במשתנה ${setting}.`;
    return new AiError(message, fields);
  }
  if (error.code === 'AI_BUSY') {
    return new AiError(`מודל ה-AI של ${name} עמוס כרגע, ולא התקבלה תשובה${tried}. נסו שוב בעוד כמה דקות, או בחרו מודל אחר במשתנה ${setting}.`, fields);
  }
  return new AiError(`אין חיבור אל ${name}${tried}. בדקו את החיבור לאינטרנט ונסו שוב.`, fields);
}

function formatWait(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 90) return `${seconds} שניות`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} דקות` : `${Math.ceil(minutes / 60)} שעות`;
}

function retryPolicy(provider, { onRetry, signal, retries } = {}) {
  return {
    retries: retries ?? config.ai.maxRetries,
    baseMs: config.ai.retryBaseMs,
    maxSuggestedMs: MAX_SUGGESTED_WAIT_MS,
    isRetryable: (error) => error instanceof AiError && error.retryable,
    suggestedWait: (error) => error.retryAfterMs ?? null,
    signal,
    onRetry: ({ error, nextAttempt, attempts, waitMs }) => {
      console.warn(`[ai] ${error.log} Retrying in ${(waitMs / 1000).toFixed(1)} s (attempt ${nextAttempt} of ${attempts}).`);
      return onRetry?.({ provider: provider.id, attempt: nextAttempt, attempts, waitMs });
    },
  };
}

async function sendOnce(provider, model, request, relaxed = false) {
  let response;
  let raw;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
    raw = await response.text();
  } catch (error) {
    throw networkFailure(error, provider);
  }
  const payload = parseJsonSafely(raw);
  if (!response.ok) {
    const failure = httpFailure(response, payload, raw, provider, model);
    const loose = response.status === 400 && !relaxed && RELAXABLE.test(failure.detail) ? relax(provider, request) : null;
    if (loose) return sendOnce(provider, model, loose, true);
    throw failure;
  }
  return payload;
}

function usageOf(provider, payload) {
  if (provider.api === 'gemini') return normalizeUsage('gemini', payload?.usageMetadata);
  return normalizeUsage(provider.api, payload?.usage);
}

function answerText(provider, payload) {
  if (provider.api === 'gemini') {
    return (payload?.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  if (provider.api === 'anthropic') {
    return (payload?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
  const content = payload?.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : (content ?? '');
}

/**
 * Sends one prompt to one provider (default: the primary one) and returns the
 * parsed JSON object from the answer, retrying temporary failures.
 * @returns {Promise<{ data: object, provider: string, providerName: string, model: string, ms: number }>}
 */
export async function completeJson({ system, prompt, provider: providerId, model: modelId, retries, params } = {}) {
  const provider = resolve(providerId);
  const model = modelId || modelOf(provider.id);
  const request = buildRequest(provider, model, { system, messages: [{ role: 'user', content: prompt }], json: true, params });
  const started = Date.now();
  let payload;
  try {
    payload = await withRetries(() => sendOnce(provider, model, request), retryPolicy(provider, { retries }));
  } catch (error) {
    throw giveUp(error, provider);
  }
  const text = answerText(provider, payload).trim();
  meterCall(provider, model, usageOf(provider, payload), { system, messages: [{ role: 'user', content: prompt }], text });
  if (!text) {
    throw new AiError(`התקבלה תשובה ריקה מ-${provider.name}.`, { code: 'AI_EMPTY_ANSWER', log: `${provider.name} returned an empty answer.`, provider: provider.id });
  }
  return { data: parseJsonLoose(text), provider: provider.id, providerName: provider.name, model, ms: Date.now() - started };
}

/**
 * One chat call answered in full (not streamed): the text, and the model's
 * reasoning when it shares it. Used for the orchestrator's hidden steps
 * (reflection, experts), the router and compaction.
 */
export async function completeText({ system, messages, provider: providerId, model: modelId, params = {}, retries, onRetry } = {}) {
  const provider = resolve(providerId);
  const model = modelId || modelOf(provider.id);
  const request = buildRequest(provider, model, { system, messages, params });
  const started = Date.now();
  let payload;
  try {
    payload = await withRetries(() => sendOnce(provider, model, request), retryPolicy(provider, { retries, onRetry }));
  } catch (error) {
    throw giveUp(error, provider);
  }
  const text = answerText(provider, payload).trim();
  meterCall(provider, model, usageOf(provider, payload), { system, messages, text });
  if (!text) {
    throw new AiError(`התקבלה תשובה ריקה מ-${provider.name}.`, { code: 'AI_EMPTY_ANSWER', log: `${provider.name} returned an empty answer.`, provider: provider.id });
  }
  const message = payload?.choices?.[0]?.message;
  const reasoning = provider.api === 'openai' ? (message?.reasoning ?? message?.reasoning_content ?? '') : '';
  return { text, reasoning: typeof reasoning === 'string' ? reasoning : '', provider: provider.id, providerName: provider.name, model, ms: Date.now() - started };
}

/**
 * Like completeJson, but tries the primary provider first and then every other
 * configured one, until an answer passes `validate` (which throws AiError when
 * it doesn't). `fallbacks` lists the providers that failed on the way.
 */
export async function completeJsonAny({ system, prompt, validate = (data) => data }) {
  const primary = primaryProvider();
  if (!primary) resolve(null);
  const order = [primary, ...configuredProviders().filter((provider) => provider !== primary)];
  const failures = [];
  for (const provider of order) {
    try {
      const result = await completeJson({ system, prompt, provider: provider.id });
      return { ...result, data: validate(result.data), fallbacks: failures.map(({ error, ...rest }) => rest) };
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      failures.push({ provider: provider.id, name: provider.name, message: error.message, detail: error.detail ?? null, code: error.code, error });
      if (order.length > 1) console.warn(`[ai] ${provider.name}: ${error.log} Trying the next provider.`);
    }
  }
  throw allFailed(failures);
}

/** One failure stays as it was; several become one Hebrew message, with each provider's text in `detail`. */
export function allFailed(failures) {
  if (failures.length === 1 && failures[0].error) return failures[0].error;
  const names = failures.map((failure) => failure.name).join(', ');
  const temporary = failures.every((failure) => failure.code === 'AI_BUSY' || failure.code === 'AI_RATE_LIMITED');
  return new AiError(`אף אחד מספקי ה-AI לא הצליח לענות (${names}).${temporary ? ' כולם עמוסים כרגע; נסו שוב בעוד כמה דקות.' : ''}`, {
    code: temporary ? 'AI_BUSY' : 'AI_FAILED',
    log: `Every AI provider failed: ${failures.map((failure) => `${failure.name} (${failure.error?.log ?? failure.code})`).join('; ')}`,
    detail: failures.map((failure) => `${failure.name}: ${failure.detail ?? failure.code}`).join('\n'),
  });
}

// ---------------------------------------------------------------------------
// Streaming chat

async function openStream(provider, model, request, signal, relaxed = false) {
  const connect = new AbortController();
  const timer = setTimeout(() => connect.abort(new DOMException('No answer', 'TimeoutError')), config.ai.timeoutMs);
  let response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: signal ? AbortSignal.any([signal, connect.signal]) : connect.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw networkFailure(connect.signal.aborted ? connect.signal.reason : error, provider);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const raw = await response.text();
    const failure = httpFailure(response, parseJsonSafely(raw), raw, provider, model);
    const loose = response.status === 400 && !relaxed && RELAXABLE.test(failure.detail) ? relax(provider, request) : null;
    if (loose) return openStream(provider, model, loose, signal, true);
    throw failure;
  }
  return { response, connect };
}

function parseDataLine(line) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return DONE;
  return parseJsonSafely(data);
}

/** Server-sent events → parsed JSON objects, with an idle timeout. */
async function* readEvents(body, connect, provider) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      let timer;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => {
          connect.abort();
          reject(new AiError(`התשובה מ-${provider.name} הפסיקה להגיע באמצע.`, { code: 'AI_TIMEOUT', log: `${provider.name} stopped streaming.`, provider: provider.id }));
        }, STREAM_IDLE_MS);
      });
      let chunk;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const event = parseDataLine(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
        if (event === DONE) return;
        if (event) yield event;
      }
    }
    const last = parseDataLine(buffer.trim());
    if (last && last !== DONE) yield last;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** One streamed event → { text, reasoning, usage, finish, error }. */
function streamDelta(provider, event) {
  if (provider.api === 'gemini') {
    const candidate = event.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const usage = event.usageMetadata;
    return {
      text: parts.filter((part) => !part.thought).map((part) => part.text ?? '').join(''),
      reasoning: parts.filter((part) => part.thought).map((part) => part.text ?? '').join(''),
      usage: normalizeUsage('gemini', usage),
      finish: candidate?.finishReason ?? null,
      error: event.error?.message ?? null,
    };
  }
  if (provider.api === 'anthropic') {
    if (event.type === 'error') return { error: event.error?.message ?? 'error' };
    if (event.type === 'content_block_delta') {
      return { text: event.delta?.type === 'text_delta' ? event.delta.text : '', reasoning: event.delta?.type === 'thinking_delta' ? event.delta.thinking : '' };
    }
    if (event.type === 'message_start') return { usage: normalizeUsage('anthropic', { ...event.message?.usage, output_tokens: undefined }) };
    if (event.type === 'message_delta') return { usage: normalizeUsage('anthropic', event.usage), finish: event.delta?.stop_reason ?? null };
    return {};
  }
  if (event.error) return { error: event.error.message ?? String(event.error) };
  const choice = event.choices?.[0];
  const delta = choice?.delta ?? {};
  // Kimi puts the usage on the last choice, Groq under x_groq.
  const usage = event.usage ?? choice?.usage ?? event.x_groq?.usage;
  return {
    text: typeof delta.content === 'string' ? delta.content : '',
    reasoning: typeof delta.reasoning === 'string' ? delta.reasoning : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '',
    usage: normalizeUsage('openai', usage),
    finish: choice?.finish_reason ?? null,
  };
}

/**
 * Streams a chat reply. `onDelta({ type: 'text'|'reasoning', text })` receives
 * the answer as it is written; `onRetry` hears about retries before the first
 * word. Aborting `signal` stops the provider too.
 */
export async function streamChat({ provider: providerId, model: modelId, system, messages, params = {}, json = false, signal, onDelta, onRetry }) {
  const provider = resolve(providerId);
  const model = modelId || modelOf(provider.id);
  const request = buildRequest(provider, model, { system, messages, stream: true, json, params });
  const started = Date.now();
  let stream;
  try {
    stream = await withRetries(() => openStream(provider, model, request, signal), retryPolicy(provider, { onRetry, signal }));
  } catch (error) {
    throw signal?.aborted ? error : giveUp(error, provider);
  }
  const result = { text: '', reasoning: '', usage: {}, finishReason: null };
  try {
  for await (const event of readEvents(stream.response.body, stream.connect, provider)) {
    const delta = streamDelta(provider, event);
    if (delta.error) {
      throw new AiError(`התשובה מ-${provider.name} נקטעה באמצע.`, {
        code: 'AI_STREAM_ERROR',
        log: `${provider.name} stream error: ${delta.error}`,
        detail: `${provider.name}: ${delta.error}`,
        provider: provider.id,
      });
    }
    if (delta.text) {
      result.text += delta.text;
      onDelta?.({ type: 'text', text: delta.text });
    }
    if (delta.reasoning) {
      result.reasoning += delta.reasoning;
      onDelta?.({ type: 'reasoning', text: delta.reasoning });
    }
    if (delta.usage) for (const [field, value] of Object.entries(delta.usage)) if (value !== null && value !== undefined) result.usage[field] = value;
    if (delta.finish) result.finishReason = delta.finish;
  }
  } finally {
    // Also when the stream broke or was stopped: what was generated is billed.
    meterCall(provider, model, result.usage, { system, messages, text: result.text, reasoning: result.reasoning });
  }
  if (!result.text.trim()) {
    // A stream can end without any answer: a filter, or a model that spent its whole budget thinking.
    const cutOff = /length|max_tokens/i.test(result.finishReason ?? '');
    throw new AiError(
      cutOff
        ? `${provider.name} הגיע למגבלת האורך לפני שכתב תשובה. נסו מאמץ נמוך יותר או מודל אחר.`
        : `${provider.name} סיים בלי לכתוב תשובה. נסו שוב או בחרו מודל אחר.`,
      { code: 'AI_EMPTY_ANSWER', log: `${provider.name} (${model}) streamed no text (finish: ${result.finishReason ?? 'none'}).`, provider: provider.id },
    );
  }
  return { ...result, provider: provider.id, providerName: provider.name, model, ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Model lists

const modelLists = new Map(); // provider id → { at, ttl, value }

function isOpenAiChatModel(id) {
  return /^(gpt-|o\d|chatgpt)/.test(id) && !/audio|realtime|image|tts|transcribe|search|embedding|moderation|instruct/.test(id);
}

async function fetchModelIds(provider) {
  const key = keyOf(provider.id);
  const get = async (url, headers = {}) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  switch (provider.id) {
    case 'gemini': {
      const data = await get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': key });
      return (data.models ?? [])
        .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((model) => model.name.replace(/^models\//, ''))
        .filter((id) => /gemini|gemma/.test(id) && !/image|tts|embedding|live|audio/.test(id));
    }
    case 'anthropic': {
      const data = await get('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
      return (data.data ?? []).map((model) => model.id);
    }
    case 'cohere': {
      const data = await get(provider.modelsUrl, { authorization: `Bearer ${key}` });
      return (data.models ?? []).map((model) => model.name);
    }
    case 'openrouter': {
      // Only the free models: the ones the free tier can use.
      const data = await get('https://openrouter.ai/api/v1/models');
      return (data.data ?? [])
        .filter((model) => model.id.endsWith(':free') || (Number(model.pricing?.prompt) === 0 && Number(model.pricing?.completion) === 0))
        .map((model) => model.id);
    }
    default: {
      const data = await get(`${provider.baseUrl}/models`, { authorization: `Bearer ${key}` });
      const ids = (data.data ?? []).map((model) => model.id).filter(Boolean);
      if (provider.id === 'openai') return ids.filter(isOpenAiChatModel);
      if (provider.id === 'groq') return ids.filter((id) => !/whisper|guard|tts|orpheus|playai|prompt/.test(id));
      return ids;
    }
  }
}

/**
 * A provider's models for the chat's picker: the configured and suggested
 * models first, then everything the provider lists right now.
 * @returns {Promise<{ live: boolean, models: Array<{ id: string, reasoning: boolean }> }>}
 */
/** The provider's own model list, nothing added (the smoke test checks the catalog against it). */
export const liveModelIds = (providerId) => fetchModelIds(resolve(providerId));

export async function listModels(providerId) {
  const provider = resolve(providerId);
  const cached = modelLists.get(provider.id);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
  let ids = null;
  try {
    ids = await fetchModelIds(provider);
  } catch (error) {
    console.warn(`[ai] Could not list ${provider.name} models (${error.message}); showing the suggested ones.`);
  }
  const ordered = [...new Set([modelOf(provider.id), ...provider.suggested, ...(ids ?? []).sort((a, b) => a.localeCompare(b))])];
  const value = { live: Boolean(ids), models: ordered.map((id) => ({ id, reasoning: supportsReasoning(provider.id, id) })) };
  modelLists.set(provider.id, { at: Date.now(), ttl: ids ? MODEL_LIST_TTL_MS : MODEL_LIST_RETRY_MS, value });
  return value;
}

// ---------------------------------------------------------------------------
// JSON answers

/**
 * Parses a model's JSON answer, tolerating Markdown fences or stray prose
 * around the object (some models add them even in JSON mode).
 */
export function parseJsonLoose(text) {
  const unfenced = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const direct = parseJsonSafely(unfenced);
  if (direct && typeof direct === 'object') return direct;

  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  const embedded = start !== -1 && end > start ? parseJsonSafely(unfenced.slice(start, end + 1)) : null;
  if (embedded && typeof embedded === 'object') return embedded;
  throw new AiError('התשובה של מודל ה-AI אינה JSON תקין.', { code: 'AI_BAD_ANSWER', log: 'The AI answer was not valid JSON.' });
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
