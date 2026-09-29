/**
 * Context compaction. Every CHAT_COMPACT_EVERY turns (10), a fast model rewrites
 * the conversation's project_state.md from the current file and the messages
 * since the last update: goals, decisions, architecture, code structure, status
 * and next steps. From then on the models get project_state.md plus only the
 * recent messages (the last CHAT_KEEP_RECENT, 3, at the time of compaction, and
 * everything after them). The conversation itself keeps every message for the reader.
 */
import { config } from '../../config.js';
import { AiError, completeText, configuredProviders, isConfigured } from './llmClient.js';

const PROMPT = `You maintain project_state.md: the memory of a long working conversation between a developer and an AI assistant.
You get the current file (it may be empty) and the messages since it was last updated. Reply with the whole updated file, in Markdown, with these sections:
# project_state.md
## מטרות
## החלטות
## ארכיטקטורה
## מבנה הקוד
## מצב נוכחי
## שאלות פתוחות וצעדים הבאים
Rules: keep decisions with their reasons, the architecture, the code structure (files, modules, important functions, data shapes, conventions), the current status, open questions and next steps. Drop small talk and anything superseded. Keep code identifiers, file paths and commands exactly as written. Write in the conversation's language (usually Hebrew). At most 900 words. Reply with the file only.`;

/** Fast or free models first: Gemini Flash, then Groq, then any configured provider. */
const PREFERRED = [
  ['gemini', 'gemini-flash-latest'],
  ['groq', 'openai/gpt-oss-120b'],
  ['openrouter', null],
  ['cohere', null],
  ['huggingface', null],
];

export const turnsSinceCompaction = (chat) =>
  chat.messages.slice(chat.memory?.summarizedUpTo ?? 0).filter((message) => message.role === 'assistant' && !message.error && !message.stopped).length;

export const compactionDue = (chat) => turnsSinceCompaction(chat) >= config.chat.compactEvery;

/** The messages the models still see. */
export const contextWindow = (chat) => chat.messages.slice(chat.memory?.windowStart ?? 0);

/** What the client shows about the memory. */
export function memoryInfo(chat) {
  return {
    state: chat.memory?.state ?? '',
    updatedAt: chat.memory?.updatedAt ?? null,
    compactions: chat.memory?.compactions ?? 0,
    windowStart: chat.memory?.windowStart ?? 0,
    turnsSince: turnsSinceCompaction(chat),
    compactEvery: config.chat.compactEvery,
    keepRecent: config.chat.keepRecent,
    by: chat.memory?.by ?? null,
  };
}

/** Writes the new project_state.md; returns the conversation's new `memory`. */
export async function compactConversation(chat) {
  const pending = chat.messages.slice(chat.memory?.summarizedUpTo ?? 0).filter((message) => message.content);
  const transcript = pending
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.content.slice(0, 6_000)}`)
    .join('\n\n---\n\n')
    .slice(-80_000);
  const prompt = `Current project_state.md:\n<<<\n${chat.memory?.state || '(empty)'}\n>>>\n\nNew messages:\n<<<\n${transcript}\n>>>`;
  const candidates = [
    ...PREFERRED.filter(([id]) => isConfigured(id)),
    ...configuredProviders()
      .filter((provider) => provider.workspace && !PREFERRED.some(([id]) => id === provider.id))
      .map((provider) => [provider.id, null]),
  ];
  let lastError = null;
  for (const [provider, model] of candidates) {
    try {
      const result = await completeText({ system: PROMPT, messages: [{ role: 'user', content: prompt }], provider, model: model ?? undefined, params: { maxTokens: 3_000 } });
      const state = result.text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
      const count = chat.messages.length;
      return {
        state,
        updatedAt: new Date().toISOString(),
        compactions: (chat.memory?.compactions ?? 0) + 1,
        summarizedUpTo: count,
        windowStart: Math.max(0, count - config.chat.keepRecent),
        by: { provider: result.provider, name: result.providerName, model: result.model },
      };
    } catch (error) {
      lastError = error;
      console.warn(`[memory] Compaction with ${provider} failed: ${error.log ?? error.message}`);
    }
  }
  throw lastError ?? new AiError('אין מודל זמין לעדכון הזיכרון.', { code: 'AI_DISABLED' });
}
