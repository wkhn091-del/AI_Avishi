/**
 * Before each answer: the memories that apply to the request, as a block for
 * the system prompt (every model of the turn gets it, the team's architect
 * included) and a list for the answer's details.
 *
 * Preferences and code style that apply everywhere always come, the most
 * confirmed first. Project rules and other facts come when they relate to the
 * request: by meaning (embeddings) when there is an embedding provider, by
 * shared words otherwise, and always when the request names their project.
 */
import { config } from '../../config.js';
import { THRESHOLDS, cosine, embed, embedder, embedderId } from './embeddings.js';
import { backfillVectors, listMemories, markUsed } from './memoryStore.js';

const GENERAL_LIMIT = 10;
const RELATED_LIMIT = 6;
const WORDS_MIN = 0.34; // share of a memory's words that the request contains

export const memoryAvailable = () => config.longTermMemory.enabled;

// Words that say nothing about the subject.
const STOP = new Set(
  `the and for with that this from into your you use uses using prefer prefers always never should when what how are was not but its his her they them their our any all can will would just also only very more most
  של את על עם זה זו זאת הוא היא הם הן אני אנחנו אתה את לא כן גם רק כל מה איך אם או כי אבל יותר מאוד תמיד אף פעם משתמש משתמשת מעדיף מעדיפה רוצה צריך צריכה`
    .split(/\s+/)
    .filter(Boolean),
);
const HEBREW_PREFIX = /^[והבלמשכ](?=[\u05D0-\u05EA]{3,})/;

/** A text's meaningful words, lower-case; Hebrew words also without a one-letter prefix (ב-, ל-, ה-…). */
export function wordsOf(text) {
  const words = new Set();
  for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? []) {
    const clean = word.replace(/[.-]+$/, '');
    if (clean.length < 3 || STOP.has(clean)) continue;
    words.add(clean);
    const bare = clean.replace(HEBREW_PREFIX, '');
    if (bare !== clean && !STOP.has(bare)) words.add(bare);
  }
  return words;
}

/** How much of `memoryWords` appears in `requestWords`: 0 to 1. */
function overlap(requestWords, memoryWords) {
  if (!memoryWords.size) return 0;
  let shared = 0;
  for (const word of memoryWords) if (requestWords.has(word)) shared += 1;
  return shared / memoryWords.size;
}

const isGeneral = (memory) => !memory.project && (memory.kind === 'preference' || memory.kind === 'style');
const byStrength = (a, b) => b.confirmations - a.confirmations || b.updatedAt.localeCompare(a.updatedAt);

/**
 * @param {string} text  the request
 * @param {object} options
 * @param {string} options.userId  whose memories: only theirs are ever read
 * @param {boolean} [options.semantic]  may call the embedding provider (the free workspace matches words only, at no cost)
 * @returns {Promise<{ items: Array<object>, block: string }>}
 */
export async function recall(text, { userId, semantic = true } = {}) {
  if (!userId) return { items: [], block: '' };
  const all = await listMemories(userId, { withVectors: true });
  if (!all.length) return { items: [], block: '' };
  const who = semantic ? embedder() : null;
  if (who) {
    // Memories saved before there was an embedding provider (or with another one) get their vector now.
    await backfillVectors(userId, all, { who }).catch((error) => console.warn(`[memory] Backfilling vectors failed: ${error.log ?? error.message}`));
  }

  const general = all.filter(isGeneral).sort(byStrength).slice(0, GENERAL_LIMIT);
  const others = all.filter((memory) => !general.includes(memory));
  let related = [];
  if (others.length) {
    let query = null;
    const id = embedderId(who);
    if (who && others.some((memory) => memory.vectorModel === id)) {
      try {
        [query] = await embed([text], 'query', who);
      } catch (error) {
        console.warn(`[memory] Embedding the request failed: ${error.log ?? error.message}`);
      }
    }
    const requestWords = wordsOf(text);
    const lower = String(text).toLowerCase();
    related = others
      .map((memory) => {
        const named = Boolean(memory.project) && lower.includes(memory.project.toLowerCase());
        const meaning = query && memory.vector && memory.vectorModel === id ? cosine(query, memory.vector) : null;
        const words = overlap(requestWords, wordsOf(`${memory.project ?? ''} ${memory.content}`));
        const relevant = named || (meaning !== null ? meaning >= THRESHOLDS[who.provider].related : words >= WORDS_MIN);
        return { memory, relevant, score: (named ? 1 : 0) + (meaning ?? words) };
      })
      .filter((candidate) => candidate.relevant)
      .sort((a, b) => b.score - a.score)
      .slice(0, RELATED_LIMIT)
      .map((candidate) => candidate.memory);
  }

  const chosen = [...general, ...related];
  if (!chosen.length) return { items: [], block: '' };
  await markUsed(
    userId,
    chosen.map((memory) => memory.id),
  ).catch(() => {});
  return {
    items: chosen.map(({ id, kind, content, project }) => ({ id, kind, content, project })),
    block: blockOf(chosen),
  };
}

function blockOf(memories) {
  const lines = memories.map((memory) => `- ${memory.project ? `(${memory.project}) ` : ''}${memory.content}`);
  return `# What you know about the user
Long-term memory: what the user told you or accepted in earlier conversations. Follow it unless the user asks otherwise now. Use it silently: don't mention, list or quote it.
${lines.join('\n')}`;
}
