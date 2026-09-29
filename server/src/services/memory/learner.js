/**
 * After an answer: what the exchange taught about how the person works, written
 * down by a cheap model (GPT-4o mini by default) in the background.
 *
 * The model sees the closest memories already kept, so a fact it learns again
 * confirms the old one, and a changed preference replaces it instead of
 * contradicting it. What it proposes is checked again here: facts that look
 * like secrets are dropped, and a fact already kept in other words (by its
 * vector, or by its text) only confirms the old one.
 */
import { premiumModel } from '../ai/catalog.js';
import { completeJson, isConfigured } from '../ai/llmClient.js';
import { config } from '../../config.js';
import { THRESHOLDS, cosine, embed, embedder, embedderId } from './embeddings.js';
import { CONTENT_MAX, MEMORY_KINDS, PROJECT_MAX, addMemory, confirmMemory, listMemories, updateMemory, vectorFor } from './memoryStore.js';
import { wordsOf } from './recall.js';

const CHEAP_MODELS = ['gpt-4o-mini', 'gemini-flash-lite', 'deepseek-flash', 'gpt-5.6-luna', 'haiku-4.5', 'kimi-k2.6'];
const MAX_FACTS = 3;
const SHOWN_MEMORIES = 12;

const LEARN_PROMPT = `You keep the long-term memory of an AI coding assistant: short, lasting facts about how this user likes to work, which make future answers fit them better.
From the latest exchange below, pick out new facts worth remembering:
- code style: languages, frameworks, libraries, patterns, naming and formatting they want or reject
- tools and setup: operating system, editor, package manager, runtime, databases, hosting
- how they want answers: format, length, language, level of detail
- the rules of a named project: its stack, conventions and constraints
- corrections: when the user rejected something, remember what they want instead
Keep only what the user said, asked for or clearly accepted. Never keep the task itself, one-off requests, facts about the world, guesses, secrets (keys, passwords, tokens, private URLs) or personal details unrelated to their work.
Write each fact as one short sentence in the user's language, about the user (for example "Prefers TypeScript with strict mode", or in Hebrew "מעדיף TypeScript במצב strict").
If a fact updates or contradicts a remembered one, set "replaces" to that memory's id. Don't return facts that are already remembered.
Reply with JSON only: {"memories": [{"content": string, "kind": "preference" | "style" | "rule" | "fact", "project": string | null, "replaces": string | null}]}. At most ${MAX_FACTS} facts; most exchanges teach nothing new, so an empty list is common.`;

// Things that must never be stored: API keys, tokens, private keys, passwords and URLs with credentials.
const SECRET =
  /(sk-(?:ant-|proj-)?[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|AIza[\w-]{30,}|tvly-[\w-]{12,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:password|passwd|secret|token|api[ _-]?key)\s*[:=]|סיסמ[הא]\s*[:=]|:\/\/[^/\s:@]+:[^/\s@]+@)/i;
export const looksSecret = (text) => SECRET.test(String(text));

/** The cheap model that learns: MEMORY_LEARNER first, then other cheap models with a key. */
export function learnerModel() {
  return [config.longTermMemory.learner, ...CHEAP_MODELS].map(premiumModel).find((entry) => entry && isConfigured(entry.provider)) ?? null;
}

const normal = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The model's proposals, checked: known kinds, sensible lengths, no secrets, at most MAX_FACTS. */
export function cleanProposals(value, knownIds) {
  if (!Array.isArray(value)) return [];
  const facts = [];
  for (const item of value) {
    const content = typeof item?.content === 'string' ? item.content.replace(/\s+/g, ' ').trim() : '';
    if (content.length < 6 || content.length > CONTENT_MAX || looksSecret(content)) continue;
    const project = typeof item.project === 'string' && item.project.trim() ? item.project.trim().slice(0, PROJECT_MAX) : null;
    facts.push({
      content,
      kind: MEMORY_KINDS.includes(item.kind) ? item.kind : project ? 'rule' : 'fact',
      project,
      replaces: typeof item.replaces === 'string' && knownIds.has(item.replaces) ? item.replaces : null,
    });
    if (facts.length === MAX_FACTS) break;
  }
  return facts;
}

/** The memories closest to a text: by meaning when possible, otherwise by shared words. */
async function closest(memories, text, limit, who) {
  if (memories.length <= limit) return memories;
  const id = embedderId(who);
  let query = null;
  if (who && memories.some((memory) => memory.vectorModel === id)) query = (await embed([text], 'query', who).catch(() => [null]))[0];
  const words = wordsOf(text);
  return memories
    .map((memory) => ({
      memory,
      score: query && memory.vectorModel === id ? cosine(query, memory.vector) : [...wordsOf(memory.content)].filter((word) => words.has(word)).length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((candidate) => candidate.memory);
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[…]` : text);

/**
 * @returns {Promise<{ added: object[], updated: object[], confirmed: string[] }>}
 */
export async function learnFrom({ userId, userText, answer, conversationId = null }) {
  const outcome = { added: [], updated: [], confirmed: [] };
  const model = learnerModel();
  if (!userId || !model || !String(userText ?? '').trim()) return outcome;
  const who = embedder();
  // Only this person's memories are shown to the model, and only they get what it learns.
  const memories = await listMemories(userId, { withVectors: true });
  const shown = await closest(memories, userText, SHOWN_MEMORIES, who);
  const files = [...String(answer ?? '').matchAll(/^\s{0,3}(?:`{3,}|~{3,})\S*\s+([\w@.+/-]+\.[A-Za-z0-9]{1,10})\s*$/gm)].map((match) => match[1]);
  const prompt = [
    '# Remembered already',
    shown.length ? shown.map((memory) => `- [${memory.id}] (${memory.kind}${memory.project ? `, ${memory.project}` : ''}) ${memory.content}`).join('\n') : '(nothing yet)',
    '',
    "# The user's message",
    shorten(String(userText), 4_000),
    '',
    "# The assistant's answer (shortened)",
    shorten(String(answer ?? '').replace(/```[\s\S]*?```/g, '[code]'), 2_500),
    files.length ? `Files in the answer: ${[...new Set(files)].slice(0, 30).join(', ')}` : '',
  ].join('\n');

  const { data } = await completeJson({ system: LEARN_PROMPT, prompt, provider: model.provider, model: model.model, retries: 1, params: { effort: 'low' } });
  const proposals = cleanProposals(data?.memories, new Set(memories.map((memory) => memory.id)));

  for (const fact of proposals) {
    if (fact.replaces) {
      const updated = await updateMemory(userId, fact.replaces, { content: fact.content, kind: fact.kind, project: fact.project }, { confirm: true });
      if (updated) outcome.updated.push(updated);
      continue;
    }
    const stored = await vectorFor(fact.content, who);
    const same = memories.find(
      (memory) =>
        normal(memory.content) === normal(fact.content) ||
        (stored.vector && memory.vectorModel === stored.embeddingModel && cosine(stored.vector, memory.vector) >= THRESHOLDS[who.provider].same),
    );
    if (same) {
      await confirmMemory(userId, same.id);
      outcome.confirmed.push(same.id);
      continue;
    }
    const added = await addMemory(userId, { ...fact, source: 'learned', conversationId, stored });
    memories.push({ ...added, vector: stored.vector, vectorModel: stored.embeddingModel });
    outcome.added.push(added);
  }
  return outcome;
}
