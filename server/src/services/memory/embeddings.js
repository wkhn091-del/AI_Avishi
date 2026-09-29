/**
 * Vectors for the long-term memory's semantic search: Gemini's embedding model
 * or OpenAI's, whichever has a key (Gemini first; MEMORY_EMBEDDINGS chooses).
 * Both give 768 dimensions. Vectors are normalized, so cosine similarity is a
 * dot product, and stored as base64 with the provider/model that made them:
 * vectors from different models are never compared. Every call is recorded by
 * the cost meter.
 */
import { config } from '../../config.js';
import { AiError, isConfigured, keyFor } from '../ai/llmClient.js';
import { estimateTokens, recordCall } from '../ai/usageMeter.js';

export const DIMENSIONS = 768;
const TIMEOUT_MS = 10_000;
const MAX_CHARS = 6_000; // well within both models' input limits

/** The provider and model that make vectors now, or null (the memory then matches words instead). */
export function embedder() {
  const setting = config.longTermMemory.embeddings;
  if (setting === 'off') return null;
  if ((setting === 'auto' || setting === 'gemini') && isConfigured('gemini')) return { provider: 'gemini', model: config.longTermMemory.geminiEmbeddingModel };
  if ((setting === 'auto' || setting === 'openai') && isConfigured('openai')) return { provider: 'openai', model: config.longTermMemory.openaiEmbeddingModel };
  return null;
}

export const embedderId = (who) => (who ? `${who.provider}/${who.model}` : null);

/**
 * @param {string[]} texts
 * @param {'query' | 'document'} task  a search text, or text being stored
 * @returns {Promise<Float32Array[]>} one normalized vector per text
 */
export async function embed(texts, task, who = embedder()) {
  if (!who) throw new AiError('אין ספק מוגדר להטמעות.', { code: 'AI_DISABLED', log: 'No embedding provider is configured.' });
  const input = texts.map((text) => String(text).slice(0, MAX_CHARS));
  const vectors = who.provider === 'gemini' ? await geminiEmbed(input, task, who.model) : await openaiEmbed(input, who.model);
  if (vectors.length !== input.length || vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)) {
    throw new AiError('ההטמעה החזירה תשובה לא צפויה.', { code: 'AI_EMBEDDING_FAILED', log: `${who.provider} returned ${vectors.length} vectors for ${input.length} texts.` });
  }
  return vectors.map(normalize);
}

async function post(url, headers, body, label) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new AiError(`אין חיבור ל-${label}.`, { code: 'AI_EMBEDDING_FAILED', log: `${label} embeddings: ${error.message}` });
  }
  const text = await response.text();
  if (!response.ok) throw new AiError(`ההטמעה ב-${label} נכשלה (HTTP ${response.status}).`, { code: 'AI_EMBEDDING_FAILED', log: `${label} embeddings HTTP ${response.status}: ${text.slice(0, 300)}` });
  return JSON.parse(text);
}

async function geminiEmbed(texts, task, model) {
  const data = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
    { 'x-goog-api-key': keyFor('gemini') },
    {
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
        outputDimensionality: DIMENSIONS,
      })),
    },
    'Gemini',
  );
  // Gemini doesn't report tokens for embeddings: they are estimated from the text.
  recordCall({ provider: 'gemini', model, input: texts.reduce((sum, text) => sum + estimateTokens(text), 0), output: 0, estimated: true });
  return (data.embeddings ?? []).map((item) => item.values);
}

async function openaiEmbed(texts, model) {
  const data = await post('https://api.openai.com/v1/embeddings', { authorization: `Bearer ${keyFor('openai')}` }, { model, input: texts, dimensions: DIMENSIONS }, 'OpenAI');
  const reported = Number.isFinite(data.usage?.prompt_tokens);
  recordCall({ provider: 'openai', model, input: reported ? data.usage.prompt_tokens : texts.reduce((sum, text) => sum + estimateTokens(text), 0), output: 0, estimated: !reported });
  return [...(data.data ?? [])].sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

function normalize(values) {
  const vector = Float32Array.from(values);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

/** Cosine similarity of two normalized vectors (0 when their sizes differ). */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

/** A vector as the bytes the database keeps (float32, little-endian). */
export const vectorBytes = (vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

export function vectorFromBytes(bytes) {
  // A copy, so the Float32Array starts on an aligned offset whatever the driver's buffer was.
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/**
 * How similar two texts must be to count, per provider: the models place
 * unrelated texts at different baselines (Gemini's are higher than OpenAI's).
 * `related` gates what a request recalls; `same` says a new fact is one already known.
 */
export const THRESHOLDS = Object.freeze({
  gemini: { related: 0.55, same: 0.9 },
  openai: { related: 0.3, same: 0.85 },
});
