/**
 * Token and cost totals for messages and conversations. Messages store the
 * tokens of each model call; costs are computed from them when shown.
 */
import { PREMIUM_MODELS } from '../ai/catalog.js';
import { costOf, savingOf } from '../ai/pricing.js';
import { providerById } from '../ai/providers.js';

export const ROLE_LABELS = Object.freeze({
  answer: 'תשובות', continuation: 'המשכים אוטומטיים', thinking: 'חשיבה וביקורת עצמית', expert: 'מומחים', synthesis: 'איחוד תשובות', router: 'ניתוב', memory: 'זיכרון',
  // The development team's roles.
  architect: 'צוות: תוכנית', builder: 'צוות: כתיבת קבצים', qa: 'צוות: בדיקת QA', fix: 'צוות: תיקונים',
  // The team before the swarm, in older conversations.
  frontend: 'צוות: ממשק', backend: 'צוות: צד שרת', review: 'צוות: בדיקה',
  // The web researcher and the long-term memory.
  research: 'חיפוש ברשת', recall: 'שליפה מהזיכרון', learning: 'למידה לזיכרון',
});

// Services that aren't chat models.
const SERVICE_LABELS = Object.freeze({
  'tavily/tavily-search': 'Tavily (חיפוש ברשת)',
  'gemini/gemini-embedding-001': 'Gemini Embedding',
  'openai/text-embedding-3-small': 'OpenAI Embeddings',
});
export const labelOf = (provider, model) =>
  PREMIUM_MODELS.find((item) => item.provider === provider && item.model === model)?.label ??
  SERVICE_LABELS[`${provider}/${model}`] ??
  `${providerById(provider)?.name ?? provider} ${model}`;

/** A message's calls: stored ones, or one call rebuilt from an older message's totals. */
export function callsOf(message) {
  if (message.role !== 'assistant' || !message.usage) return [];
  if (Array.isArray(message.usage.calls)) return message.usage.calls;
  const provider = message.provider ?? message.route?.provider;
  if (!provider || !message.model || !(message.usage.input || message.usage.output)) return [];
  return [{ role: 'answer', provider, model: message.model, input: message.usage.input ?? 0, output: message.usage.output ?? 0, at: message.createdAt }];
}

/** Totals, by model and by role. `unpriced` counts calls to models without a known price. */
export function summarize(calls) {
  const total = { input: 0, output: 0, cached: 0, cost: 0, saved: 0, calls: calls.length, estimated: false, unpriced: 0 };
  const byModel = new Map();
  const byRole = new Map();
  const add = (map, key, seed, call, cost) => {
    const row = map.get(key) ?? { ...seed, input: 0, output: 0, cost: 0, calls: 0 };
    row.input += call.input ?? 0;
    row.output += call.output ?? 0;
    row.cost += cost ?? 0;
    row.calls += 1;
    map.set(key, row);
  };
  for (const call of calls) {
    const cost = costOf(call);
    total.input += call.input ?? 0;
    total.output += call.output ?? 0;
    total.cached += call.cached ?? 0;
    if (cost === null) total.unpriced += 1;
    else total.cost += cost;
    total.saved += savingOf(call);
    if (call.estimated) total.estimated = true;
    add(byModel, `${call.provider}/${call.model}`, { provider: call.provider, model: call.model, label: labelOf(call.provider, call.model), priced: cost !== null }, call, cost);
    add(byRole, call.role ?? 'answer', { role: call.role ?? 'answer', label: ROLE_LABELS[call.role ?? 'answer'] ?? call.role }, call, cost);
  }
  const sorted = (map) => [...map.values()].sort((a, b) => b.cost - a.cost || b.output - a.output);
  return { ...total, byModel: sorted(byModel), byRole: sorted(byRole) };
}

export const totalsOf = ({ input, output, cached, cost, saved, calls, estimated, unpriced }) => ({ input, output, cached, cost, saved, calls, estimated, unpriced });

/** What a message stores: the calls and their token totals. */
export function storedUsage(calls) {
  const sum = (field) => calls.reduce((total, call) => total + (call[field] ?? 0), 0);
  return { input: sum('input'), output: sum('output'), calls };
}

/** A message as the client gets it: its usage with costs added. */
export function withCosts(message) {
  const calls = callsOf(message);
  if (!calls.length) return message;
  return {
    ...message,
    usage: {
      ...totalsOf(summarize(calls)),
      calls: calls.map((call) => ({ ...call, label: labelOf(call.provider, call.model), cost: costOf(call), saved: savingOf(call) || undefined })),
    },
  };
}

export const conversationCalls = (chat) => [...chat.messages.flatMap(callsOf), ...(chat.memory?.calls ?? [])];
export const conversationUsage = (chat) => summarize(conversationCalls(chat));
