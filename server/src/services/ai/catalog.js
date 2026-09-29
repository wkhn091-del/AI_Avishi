/**
 * The chat's two workspaces, the premium models by provider (with their
 * relative price and what they accept), and the effort levels. Model ids and
 * limits were checked in September 2026.
 */
import { config } from '../../config.js';
import { configuredProviders, isConfigured, listModels, modelOf } from './llmClient.js';
import { providerById } from './providers.js';
import { embedder } from '../memory/embeddings.js';
import { researchAvailable } from '../research/webSearch.js';

/** Relative price per token, 1 (cheapest) to 5. */
export const COST_LABELS = Object.freeze({ 1: 'זול מאוד', 2: 'זול', 3: 'בינוני', 4: 'יקר', 5: 'יקר מאוד' });

const entry = (provider, id, model, label, subtitle, extra) => ({
  id, provider, model, label, subtitle,
  more: provider !== 'anthropic',
  vision: true, // accepts images
  video: false, // accepts video (Gemini only)
  maxOutput: 32_000, // the most output tokens a request asks for
  ...extra,
});

/** The main sheet shows the Anthropic models; "More models" shows the rest, grouped by provider. */
export const PREMIUM_MODELS = Object.freeze([
  entry('anthropic', 'fable-5.1', 'claude-fable-5-1', 'Fable 5.1', 'לאתגרים הקשים ביותר', { tag: 'דורש קרדיטי שימוש', cost: 5 }),
  entry('anthropic', 'opus-5.5', 'claude-opus-5-5', 'Opus 5.5', 'החזק ביותר לעבודה שאפתנית', { cost: 4 }),
  entry('anthropic', 'sonnet-5', 'claude-sonnet-5', 'Sonnet 5', 'היעיל ביותר למשימות יומיומיות', { cost: 3 }),
  entry('anthropic', 'haiku-4.5', 'claude-haiku-4-5-20251001', 'Haiku 4.5', 'המהיר ביותר לתשובות קצרות', { cost: 2 }),
  entry('openai', 'gpt-6-astra', 'gpt-6-astra', 'GPT-6 Astra', 'הדגל החדש של OpenAI, במחיר של Fable', { cost: 5, maxOutput: 128_000 }),
  entry('openai', 'gpt-6-sol', 'gpt-6-sol', 'GPT-6 Sol', 'הארכיטקט של צוות הפיתוח, בחצי מחיר של GPT-5.6', { cost: 3, maxOutput: 128_000 }),
  entry('openai', 'gpt-5.6-sol', 'gpt-5.6-sol', 'GPT-5.6 Sol', 'הדגל הקודם, חלון של מיליון טוקנים', { cost: 4, maxOutput: 128_000 }),
  entry('openai', 'gpt-5.6-terra', 'gpt-5.6-terra', 'GPT-5.6 Terra', 'המאוזן של GPT-5.6', { cost: 3, maxOutput: 128_000 }),
  entry('openai', 'gpt-5.6-luna', 'gpt-5.6-luna', 'GPT-5.6 Luna', 'מהיר וזול מאוד, עם פלט ארוך', { cost: 1, maxOutput: 128_000 }),
  entry('openai', 'gpt-5.5', 'gpt-5.5', 'GPT-5.5', 'הדור הקודם של הדגל', { cost: 4, maxOutput: 64_000 }),
  entry('openai', 'gpt-4o', 'gpt-4o', 'GPT-4o', 'רב-שימושי ומבין תמונות', { cost: 3, maxOutput: 16_384 }),
  entry('openai', 'gpt-5.4-mini', 'gpt-5.4-mini', 'GPT-5.4 mini', 'מהיר וזול, עם פלט ארוך', { cost: 2, maxOutput: 64_000 }),
  entry('openai', 'gpt-4o-mini', 'gpt-4o-mini', 'GPT-4o mini', 'הזול ביותר של OpenAI', { cost: 1, maxOutput: 16_384 }),
  entry('gemini', 'gemini-pro', 'gemini-pro-latest', 'Gemini Pro', 'החזק של Google, מבין גם וידאו', { cost: 3, video: true, maxOutput: 65_536 }),
  entry('gemini', 'gemini-flash', 'gemini-flash-latest', 'Gemini Flash', 'מהיר וזול, מבין גם וידאו', { cost: 2, video: true, maxOutput: 65_536 }),
  entry('gemini', 'gemini-flash-lite', 'gemini-flash-lite-latest', 'Gemini Flash-Lite', 'הזול ביותר של Google, מבין גם וידאו', { cost: 1, video: true, maxOutput: 65_536 }),
  entry('deepseek', 'deepseek-flash', 'deepseek-flash', 'DeepSeek V4.1 Flash', 'זול מאוד, לקוד ארוך: פלט עד 384K טוקנים', { cost: 1, maxOutput: 65_536 }),
  entry('deepseek', 'deepseek-v4-pro', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 'הדור הקודם, טקסט בלבד', { cost: 2, vision: false, maxOutput: 65_536 }),
  entry('moonshot', 'kimi-k3', 'kimi-k3', 'Kimi K3', 'קוד ומשימות ארוכות, טקסט בלבד', { cost: 3, vision: false, maxOutput: 16_384 }),
  entry('moonshot', 'kimi-k2.7-code', 'kimi-k2.7-code', 'Kimi K2.7 Code', 'ממוקד בכתיבת קוד, טקסט בלבד', { cost: 2, vision: false, maxOutput: 16_384 }),
  entry('moonshot', 'kimi-k2.6', 'kimi-k2.6', 'Kimi K2.6', 'הזול של Kimi, טקסט בלבד', { cost: 2, vision: false, maxOutput: 16_384 }),
]);
export const DEFAULT_PREMIUM_MODEL = 'opus-5.5';
export const EMERGENCY_MODEL = 'fable-5.1';
export const premiumModel = (id) => PREMIUM_MODELS.find((item) => item.id === id) ?? null;

/**
 * Cheap, high-output models, in order of preference: follow-ups after the
 * first answer and automatic continuations go to the first one with a key.
 */
export const WORKHORSE_MODELS = Object.freeze(['deepseek-flash', 'gemini-flash', 'gpt-5.4-mini', 'gpt-4o-mini', 'haiku-4.5', 'kimi-k2.6']);
/** Models at or below this price are never handed off. */
export const HANDOFF_MAX_COST = 2;

/**
 * The development team for complex coding requests (the swarm, in ai/swarm/): the
 * architect, the micro-agents that write the files, and the QA reviewer, each with
 * the models that can take it, best first. PIPELINE_* in .env puts another model
 * first, and a role falls back to the next model with a key.
 */
export const PIPELINE_ROLES = Object.freeze([
  { id: 'architect', title: 'תוכנית (Blueprint)', doing: 'מתכנן את הארכיטקטורה ואת המפרט של כל קובץ', candidates: ['gpt-6-sol', 'opus-5.5', 'gpt-5.6-sol', 'gemini-pro', 'sonnet-5'] },
  { id: 'builder', title: 'סוכני הקבצים', doing: 'כותבים את הקבצים במקביל', candidates: ['deepseek-flash', 'gemini-flash', 'gpt-5.4-mini', 'kimi-k2.7-code', 'haiku-4.5'] },
  { id: 'review', title: 'בדיקת QA', doing: 'בודק את הקוד', candidates: ['sonnet-5', 'deepseek-flash', 'kimi-k2.7-code', 'gpt-5.4-mini', 'gemini-pro'] },
]);
const ROLE_SETTING = Object.freeze({ architect: 'architect', builder: 'builder', review: 'reviewer' });

/**
 * The team for one request: each role with its models that have a key, in order
 * (the first one works; the next takes over if it fails, and the architect's
 * second model finishes a plan the first couldn't). With images, models that
 * see them come first for the roles that get the images. Null when fewer than
 * two different models would take part.
 */
/** The micro-agents' two lanes: the first builder model and the first on another provider. */
export const builderLanes = (models) => [models[0], models.find((item) => item.provider !== models[0]?.provider)].filter(Boolean).map((item) => item.label).join(' + ');

export function teamFor({ vision = false } = {}) {
  const settings = config.chat.pipeline;
  const roles = PIPELINE_ROLES.map((role) => {
    const preferred = [settings[ROLE_SETTING[role.id]], ...(role.id === 'architect' ? [settings.architectFallback] : [])];
    let models = [...new Set([...preferred, ...role.candidates])].map(premiumModel).filter((item) => item && isConfigured(item.provider));
    if (vision && role.id === 'architect') models = [...models.filter((item) => item.vision), ...models.filter((item) => !item.vision)];
    return { ...role, models };
  });
  if (roles.some((role) => !role.models.length)) return null;
  return new Set(roles.map((role) => role.models[0].id)).size >= 2 ? roles : null;
}

/**
 * Effort levels. `native` is the provider's own reasoning effort for the calls;
 * `strategy` is what the orchestrator does around them.
 */
export const EFFORTS = Object.freeze([
  { id: 'low', label: 'נמוך', description: 'תשובה מהירה, עם מעט חשיבה', native: 'low', strategy: 'single', maxTokens: 2_048 },
  { id: 'medium', label: 'בינוני', description: 'איזון בין מהירות לעומק', native: 'medium', strategy: 'single', maxTokens: 4_096, default: true },
  { id: 'high', label: 'גבוה', description: 'המודל מתכנן ובודק את התוכנית לפני התשובה', native: 'high', strategy: 'reflect', maxTokens: 8_192 },
  { id: 'extra', label: 'גבוה במיוחד', description: 'טיוטה, ביקורת עצמית ותשובה משופרת', native: 'high', strategy: 'reflect-critique', maxTokens: 8_192 },
  { id: 'max', label: 'מקסימלי', description: 'שלושה מודלים עונים במקביל, והתשובות מאוחדות לתשובה אחת', native: 'high', strategy: 'experts', maxTokens: 8_192, tag: 'פי 5.5 שימוש או יותר' },
]);
export const effortOf = (id) => EFFORTS.find((effort) => effort.id === id) ?? EFFORTS.find((effort) => effort.default);

export const FREE_MODES = Object.freeze(['manual', 'brainstorm', 'auto']);

export const freeProviders = () => configuredProviders().filter((provider) => provider.workspace === 'free');
export const premiumProviders = () => configuredProviders().filter((provider) => provider.workspace === 'premium');

/** Everything the chat's sheets need. */
export async function chatCatalog() {
  const free = freeProviders();
  const lists = await Promise.all(free.map((provider) => listModels(provider.id).catch(() => ({ live: false, models: [] }))));
  const workhorse = WORKHORSE_MODELS.map(premiumModel).find((item) => isConfigured(item.provider));
  return {
    free: {
      available: free.length > 0,
      providers: free.map((provider, index) => ({
        id: provider.id,
        name: provider.name,
        defaultModel: modelOf(provider.id),
        live: lists[index].live,
        models: lists[index].models,
      })),
      modes: FREE_MODES,
      keys: ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'COHERE_API_KEY', 'HF_API_KEY'],
    },
    premium: {
      available: premiumProviders().length > 0,
      models: PREMIUM_MODELS.map((item) => ({
        ...item,
        providerName: providerById(item.provider).name,
        costLabel: COST_LABELS[item.cost],
        available: isConfigured(item.provider),
        keyEnv: providerById(item.provider).keyEnv,
      })),
      defaultModel: DEFAULT_PREMIUM_MODEL,
      classifier: isConfigured('gemini') ? 'gemini' : 'heuristic',
      emergency: { model: EMERGENCY_MODEL, available: isConfigured('anthropic') },
      handoff: { default: config.chat.handoff, workhorse: workhorse?.label ?? null },
      pipeline: (() => {
        const team = teamFor();
        return {
          default: config.chat.pipeline.enabled,
          available: config.chat.pipeline.enabled && Boolean(team),
          minComplexity: config.chat.pipeline.minComplexity,
          team: (team ?? []).map((role) => ({ role: role.id, title: role.title, model: role.id === 'builder' ? builderLanes(role.models) : role.models[0].label, fallback: role.id === 'architect' ? (role.models[1]?.label ?? null) : null })),
        };
      })(),
      keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY'],
    },
    attachments: {
      imageMaxMb: config.chat.imageMaxMb,
      videoMaxMb: config.chat.videoMaxMb,
      video: isConfigured('gemini'),
    },
    // Both workspaces: live web research (a Tavily key) and the long-term memory.
    research: { available: researchAvailable(), provider: 'Tavily', keyEnv: 'TAVILY_API_KEY', enabled: config.research.enabled },
    longTermMemory: { available: config.longTermMemory.enabled, embeddings: embedder()?.provider ?? null },
    autoContinue: config.chat.autoContinueMax,
    efforts: EFFORTS,
    memory: { compactEvery: config.chat.compactEvery, keepRecent: config.chat.keepRecent },
  };
}
