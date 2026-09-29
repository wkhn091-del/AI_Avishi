/**
 * Picks models for the chat, favouring the cheapest model that can do the job.
 *
 * Premium auto-router: a fast classifier (Gemini Flash, ROUTER_MODEL) rates the
 * request's complexity (1–10), category, kind (planning, fix…) and expected
 * output size. Standard requests (1–6) go to cheap models (Haiku, Gemini Flash,
 * GPT mini), 7–8 to mid-priced ones, and only 9–10 to Opus. Requests for a large
 * amount of code (full pages, whole apps) go to DeepSeek, whose output limit is
 * far higher and whose price far lower. Attachments limit the choice to models
 * that accept them (video: Gemini only).
 * Auto-Free: Groq's small Llama rates the request, and the category picks a free
 * provider, skipping ones that were rate-limited recently.
 */
import { config } from '../../config.js';
import { completeJson, isConfigured, modelOf } from './llmClient.js';
import { WORKHORSE_MODELS, premiumModel } from './catalog.js';
import { withTags } from './usageMeter.js';

const CATEGORIES = ['code', 'reasoning', 'math', 'writing', 'translation', 'quick', 'general'];
const KINDS = ['planning', 'implementation', 'fix', 'question', 'other'];
const OUTPUTS = ['short', 'medium', 'long', 'massive'];
const WEB_KINDS = ['none', 'news', 'docs', 'general'];
export const CATEGORY_LABELS = Object.freeze({
  code: 'קוד', reasoning: 'היגיון', math: 'מתמטיקה', writing: 'כתיבה', translation: 'תרגום', quick: 'שאלה קצרה', general: 'כללי',
});
export const KIND_LABELS = Object.freeze({ planning: 'תכנון', implementation: 'מימוש', fix: 'תיקון', question: 'שאלה', other: 'המשך' });

const CLASSIFIER_PROMPT = `You route chat requests to AI models of different strengths and prices.
Rate the request's complexity from 1 (a trivial question) to 10 (a hard, multi-step engineering or research task that needs the strongest model), and describe it:
- category: one of ${CATEGORIES.join(', ')}
- kind: "planning" (architecture, design, or a new system or feature from scratch), "implementation" (writing code for a design that is already agreed), "fix" (a bug fix or a small change), "question" (an explanation or a fact), or "other"
- output: the expected answer size: "short", "medium", "long", or "massive" (a full web page, a whole app, many files, or hundreds of lines of code)
- web: whether a good answer needs a live web search first: "news" (current events, prices, or announcements from the last weeks), "docs" (the newest version of a library, framework, API or tool, or documentation that may have changed recently), "general" (other facts that may have changed since your training), or "none" (your own knowledge is enough, including for code with well-known tools). Choose "none" unless recency really matters.
- query: when web isn't "none", a short web search query for it (in English for technical subjects, otherwise in the user's language); otherwise ""
Reply with JSON only: {"complexity": number, "category": string, "kind": string, "output": string, "web": string, "query": string, "reason": string}. Write "reason" in Hebrew, in at most 12 words.`;
const CLASSIFIER_TIMEOUT_MS = 8_000;

// Words that ask for something recent (Hebrew has no \b, so its words are matched as they are).
const NEWS_WORDS = /\b(news|today|yesterday|this week|headlines?|just announced)\b|חדשות|היום|אתמול|השבוע|הוכרז|הכריז/i;
const RECENT_WORDS =
  /\b(latest|newest|current(ly)?|recent(ly)?|up[- ]to[- ]date|release notes|changelog|new (version|release|api)|this (month|year)|20(2[6-9]|3\d))\b|הכי חדש|החדש(ה|ות|ים)? ביותר|עדכני|האחרונ(ה|ות|ים)|גרסה (חדשה|אחרונה)|החודש|השנה|שוחרר/i;

/** Whether a text asks for recent information, without a model: "news", "docs" or "none". */
export function heuristicWeb(text) {
  const value = String(text ?? '');
  const web = NEWS_WORDS.test(value) ? 'news' : RECENT_WORDS.test(value) ? 'docs' : 'none';
  return { web, query: web === 'none' ? '' : value.replace(/\s+/g, ' ').trim().slice(0, 200) };
}

/**
 * The web research a request needs, `{ kind: 'general' | 'news', query }`, or
 * null: from the router's rating, or, without one (a model chosen by hand,
 * emergency mode), from the request's words.
 */
export function webNeedOf(rating, text) {
  const source = rating && WEB_KINDS.includes(rating.web) ? rating : heuristicWeb(text);
  if (!source.web || source.web === 'none') return null;
  const query = String(source.query || text).replace(/\s+/g, ' ').trim().slice(0, 200);
  return query ? { kind: source.web === 'news' ? 'news' : 'general', query } : null;
}

/** A rough rating without a model: length, code and keywords (Hebrew and English). */
export function heuristicRating(text) {
  const value = String(text ?? '');
  const hasCode = /```|\bfunction\b|=>|\bclass\s+\w|\bimport\s|\bconst\s+\w|<\/?[a-z][\w-]*>/.test(value);
  const hard = /(architect|design|refactor|optimi[sz]e|debug|implement|build|migrate|prove|algorithm|scal|security|ארכיטקטורה|תכנ[ןו]|תכנון|בנה|לבנות|דבג|באג|שכתב|ייעל|אופטימיזציה|אלגוריתם|הוכח|אבטחה)/i.test(value);
  const translation = /(translate|תרגם|תרגום)/i.test(value);
  const math = /(\d+\s*[-+*/^]\s*\d+|equation|integral|derivative|probability|משוואה|אינטגרל|הסתברות|נגזרת)/i.test(value);
  const planning = /(architect|design|plan\b|ארכיטקטורה|תכנ[ןו]|תכנון|אפיון)/i.test(value);
  const fix = /(fix|bug|error|broken|doesn'?t work|תקן|תקני|באג|שגיאה|לא עובד|נשבר)/i.test(value);
  const massive =
    /(full (web )?page|landing page|entire|complete (app|site|website|project)|whole (app|site|project)|all (the )?files|דף (אינטרנט |נחיתה )?(מלא|שלם)|אתר (מלא|שלם)|אפליקציה (מלאה|שלמה)|פרויקט (מלא|שלם)|כל הקבצים|קוד מלא)/i.test(value) ||
    /(build|create|write|בנה|צור|כתוב)[^.?!\n]{0,40}(website|web app|app\b|site\b|game|אתר|אפליקציה|משחק|דף)/i.test(value);
  let complexity = 2 + Math.min(4, Math.floor(value.length / 400));
  if (hasCode) complexity += 2;
  if (hard) complexity += 3;
  complexity = Math.max(1, Math.min(10, complexity));
  const category = translation
    ? 'translation'
    : hasCode || massive || /\b(code|js|jsx|react|node|python|css|html|sql|api|typescript)\b|קוד/i.test(value)
      ? 'code'
      : math
        ? 'math'
        : value.length < 80
          ? 'quick'
          : hard
            ? 'reasoning'
            : 'general';
  const kind = planning ? 'planning' : fix ? 'fix' : category === 'code' ? 'implementation' : /\?\s*$/.test(value) ? 'question' : 'other';
  const output = massive ? 'massive' : category === 'code' && value.length > 300 ? 'long' : value.length < 80 ? 'short' : 'medium';
  return { complexity, category, kind, output, ...heuristicWeb(value), reason: null, by: 'heuristic' };
}

/** Complexity (1–10), category, kind and expected output; the built-in rating when no classifier answers in time. */
export async function rateRequest(text, { workspace }) {
  const classifier = workspace === 'premium' ? { provider: 'gemini', model: config.chat.routerModel } : { provider: 'groq', model: 'llama-3.1-8b-instant' };
  if (isConfigured(classifier.provider)) {
    try {
      const call = withTags({ role: 'router' }, () =>
        // Low thinking: a rating needs little, and Gemini Flash otherwise thinks at length by default.
        completeJson({
          // The date lets the classifier tell what "latest" or "this week" needs.
          system: `${CLASSIFIER_PROMPT}\nToday is ${new Date().toISOString().slice(0, 10)}.`,
          prompt: String(text).slice(0, 6_000),
          provider: classifier.provider,
          model: classifier.model,
          retries: 0,
          params: { effort: 'low' },
        }),
      );
      const { data } = await Promise.race([call, new Promise((_, reject) => setTimeout(() => reject(new Error('classifier timeout')), CLASSIFIER_TIMEOUT_MS))]);
      const complexity = Math.round(Number(data.complexity));
      if (!Number.isFinite(complexity)) throw new Error('no complexity in the answer');
      const fallback = heuristicRating(text);
      return {
        complexity: Math.max(1, Math.min(10, complexity)),
        category: CATEGORIES.includes(data.category) ? data.category : 'general',
        kind: KINDS.includes(data.kind) ? data.kind : fallback.kind,
        output: OUTPUTS.includes(data.output) ? data.output : fallback.output,
        web: WEB_KINDS.includes(data.web) ? data.web : fallback.web,
        query: WEB_KINDS.includes(data.web) ? (typeof data.query === 'string' ? data.query.slice(0, 200) : '') : fallback.query,
        reason: typeof data.reason === 'string' ? data.reason.slice(0, 120) : null,
        by: classifier.provider,
      };
    } catch (error) {
      console.warn(`[router] Rating with ${classifier.provider} failed (${error.log ?? error.message}); using the built-in rating.`);
    }
  }
  return heuristicRating(text);
}

/** Model lists, cheapest suitable first. Fable 5.1 is never picked automatically. */
const PREMIUM_TIERS = Object.freeze({
  standard: ['haiku-4.5', 'gpt-4o-mini', 'gemini-flash', 'gpt-5.4-mini', 'deepseek-flash', 'gpt-5.6-luna', 'gemini-flash-lite', 'kimi-k2.6', 'sonnet-5'],
  advanced: ['sonnet-5', 'gpt-6-sol', 'gemini-pro', 'gpt-4o', 'deepseek-flash', 'kimi-k3', 'haiku-4.5', 'gemini-flash', 'gpt-5.4-mini'],
  advancedCode: ['sonnet-5', 'gpt-6-sol', 'deepseek-flash', 'kimi-k2.7-code', 'gemini-pro', 'gpt-5.4-mini', 'haiku-4.5', 'gemini-flash'],
  advancedMath: ['deepseek-flash', 'gemini-pro', 'sonnet-5', 'gpt-5.4-mini', 'haiku-4.5', 'gemini-flash'],
  extreme: ['opus-5.5', 'gpt-5.6-sol', 'gpt-5.5', 'gemini-pro', 'sonnet-5', 'kimi-k3', 'deepseek-flash', 'haiku-4.5'],
  massiveCode: ['deepseek-flash', 'gemini-flash', 'gpt-5.4-mini', 'sonnet-5', 'kimi-k2.7-code', 'haiku-4.5', 'gpt-4o-mini'],
  video: ['gemini-flash', 'gemini-pro', 'gemini-flash-lite'],
  videoHard: ['gemini-pro', 'gemini-flash', 'gemini-flash-lite'],
});

const usable = (entry, needs = {}) => isConfigured(entry.provider) && (!needs.vision || entry.vision) && (!needs.video || entry.video);

/** Which tier a rating falls in. */
export function tierFor({ complexity, category, kind, output }, needs = {}) {
  if (needs.video) return complexity >= 7 ? 'videoHard' : 'video';
  // Planning keeps the strong tiers however long the answer; a long plan is finished by auto-continue.
  if (output === 'massive' && kind !== 'planning' && (category === 'code' || kind === 'implementation')) return 'massiveCode';
  if (complexity >= 9) return 'extreme';
  if (complexity >= 7) return category === 'code' ? 'advancedCode' : category === 'math' || category === 'reasoning' ? 'advancedMath' : 'advanced';
  return 'standard';
}

/** The premium model for a rating: the first in its tier whose provider has a key and that accepts the attachments. */
export function pickPremium(rating, needs = {}) {
  const tier = tierFor(rating, needs);
  const id = PREMIUM_TIERS[tier].find((candidate) => usable(premiumModel(candidate), needs));
  return id ? { entry: premiumModel(id), tier } : null;
}

/** The cheap, high-output model for follow-ups and continuations. */
export function pickWorkhorse(needs = {}) {
  return WORKHORSE_MODELS.map(premiumModel).find((entry) => usable(entry, needs)) ?? null;
}

/**
 * The project manager's call: a coding request rated complex enough goes to the
 * development team (plan, frontend, backend, review) instead of one model.
 * Simpler or merely long code stays with one model; video stays with Gemini.
 */
export function wantsPipeline({ complexity, category }, needs = {}) {
  return config.chat.pipeline.enabled && !needs.video && category === 'code' && complexity >= config.chat.pipeline.minComplexity;
}

const FREE_ROUTES = Object.freeze({
  quick: [['groq', 'openai/gpt-oss-20b'], ['openrouter', null], ['cohere', null], ['huggingface', 'openai/gpt-oss-20b:cheapest']],
  code: [['groq', 'openai/gpt-oss-120b'], ['openrouter', null], ['huggingface', null], ['cohere', null]],
  reasoning: [['groq', 'openai/gpt-oss-120b'], ['huggingface', null], ['openrouter', null], ['cohere', null]],
  writing: [['cohere', null], ['groq', 'openai/gpt-oss-120b'], ['openrouter', null], ['huggingface', null]],
  general: [['groq', 'openai/gpt-oss-120b'], ['cohere', null], ['openrouter', null], ['huggingface', null]],
});
const cooldowns = new Map(); // provider id → until (ms)

/** A free provider that hit its rate limit is skipped by Auto-Free for a while. */
export function coolDown(providerId, ms = 5 * 60_000) {
  cooldowns.set(providerId, Date.now() + ms);
}
const coolingDown = (id) => (cooldowns.get(id) ?? 0) > Date.now();

/** The free provider and model for a rating. */
export function pickFree({ complexity, category }) {
  const route =
    complexity <= 3 && category !== 'code'
      ? 'quick'
      : ({ translation: 'writing', math: 'reasoning', quick: 'quick' }[category] ?? (FREE_ROUTES[category] ? category : 'general'));
  const options = FREE_ROUTES[route].filter(([id]) => isConfigured(id));
  const [provider, model] = options.find(([id]) => !coolingDown(id)) ?? options[0] ?? [];
  return provider ? { provider, model: model || modelOf(provider), route } : null;
}
