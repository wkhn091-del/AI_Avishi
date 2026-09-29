/**
 * Model prices in USD per 1M tokens, from each provider's price list (checked
 * September 25, 2026): input, output (including thinking tokens) and cached
 * input. Calls are priced when they are shown, from the time they were made,
 * so dated price changes and DeepSeek's peak hours apply to the right calls.
 * MODEL_PRICES in .env overrides or adds models; COST_FREE_PROVIDERS marks
 * providers whose usage costs nothing (a free-tier key).
 */
import { config } from '../../config.js';
import { providerById } from './providers.js';

export const PRICES_CHECKED = '2026-09-26';

const GEMINI_FLASH = { input: 0.75, output: 3.75, cached: 0.075, from: [{ date: '2027-01-01', input: 1.5, output: 7.5, cached: 0.15 }] };
const GEMINI_PRO = { input: 2, output: 12, cached: 0.2, longAbove: 200_000, long: { input: 4, output: 18, cached: 0.4 } };
const GEMINI_FLASH_LITE = { input: 0.3, output: 2.5, cached: 0.03 };
const DEEPSEEK_FLASH = { input: 0.3, output: 1.2, cached: 0.006, offPeakHalf: true };
// OpenAI bills a whole request above 272K input tokens at 2x input and 1.5x output.
const openaiLong = (input, output, cached) => ({ input, output, cached, longAbove: 272_000, long: { input: input * 2, output: output * 1.5, cached: cached * 2 } });
// GPT-5.6 Sol's $4/$20 is a promotional price (announced through at least November 21, 2026).
const GPT_5_6_SOL = openaiLong(4, 20, 0.4);

/** Peak-hour prices for DeepSeek (off-peak is half). Gemini's `-latest` aliases are priced as the models they point to. */
export const PRICES = Object.freeze({
  'claude-fable-5-1': { input: 10, output: 50, cached: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cached: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cached: 0.2 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cached: 0.1 },
  'gpt-6-astra': openaiLong(10, 50, 1),
  'gpt-6-sol': openaiLong(2, 10, 0.2),
  'gpt-5.6-sol': GPT_5_6_SOL,
  'gpt-5.6': GPT_5_6_SOL,
  'gpt-5.6-terra': openaiLong(2, 12, 0.2),
  'gpt-5.6-luna': openaiLong(0.2, 1.2, 0.02),
  'gpt-5.5': { input: 5, output: 30, cached: 0.5 },
  'gpt-4o': { input: 2.5, output: 10, cached: 1.25 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cached: 0.075 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075 },
  'gemini-pro-latest': GEMINI_PRO,
  'gemini-3.1-pro-preview': GEMINI_PRO,
  'gemini-flash-latest': GEMINI_FLASH,
  'gemini-3.8-flash': GEMINI_FLASH,
  'gemini-3.7-flash': GEMINI_FLASH,
  'gemini-3.6-flash': GEMINI_FLASH,
  'gemini-flash-lite-latest': GEMINI_FLASH_LITE,
  'gemini-3.5-flash-lite': GEMINI_FLASH_LITE,
  'deepseek-flash': DEEPSEEK_FLASH,
  'deepseek-v4-flash': DEEPSEEK_FLASH,
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cached: 0.044, offPeakHalf: true },
  'kimi-k3': { input: 3, output: 15, cached: 0.3 },
  'kimi-k2.7-code': { input: 0.95, output: 4, cached: 0.19 },
  'kimi-k2.6': { input: 0.95, output: 4 },
  // Embeddings for the long-term memory (input only).
  'gemini-embedding-001': { input: 0.15, output: 0 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  // Tavily bills searches in credits: $0.008 each pay-as-you-go (1,000 free a month; COST_FREE_PROVIDERS=tavily).
  'tavily-search': { input: 0, output: 0, perCredit: 0.008 },
});

const FREE = Object.freeze({ input: 0, output: 0, cached: 0, free: true });

/** DeepSeek's peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday (Chinese public holidays aren't tracked). */
export function isDeepSeekPeak(at) {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

/** The rates for a call to `model` at time `at`, or null when the price is unknown. */
export function priceFor(provider, model, at = new Date()) {
  if (providerById(provider)?.workspace === 'free' || config.pricing.freeProviders.includes(provider)) return FREE;
  const base = config.pricing.overrides[model] ?? PRICES[model];
  if (!base) return null;
  let rate = { ...base };
  for (const step of base.from ?? []) if (at >= new Date(`${step.date}T00:00:00Z`)) rate = { ...rate, ...step };
  if (base.offPeakHalf && !isDeepSeekPeak(at)) rate = { ...rate, input: rate.input / 2, output: rate.output / 2, cached: (rate.cached ?? rate.input) / 2 };
  return rate;
}

/** A call's cost in USD, or null when its model has no known price. */
export function costOf(call) {
  const rate = priceFor(call.provider, call.model, new Date(call.at));
  if (!rate) return null;
  const tier = rate.longAbove && call.input > rate.longAbove ? rate.long : rate;
  const cached = Math.min(call.cached ?? 0, call.input ?? 0);
  const tokens = (((call.input ?? 0) - cached) * tier.input + cached * (tier.cached ?? tier.input) + (call.output ?? 0) * tier.output) / 1_000_000;
  return tokens + (call.credits ?? 0) * (tier.perCredit ?? 0);
}

/** What a handed-off call saved: the same tokens at the price of the model it replaced. */
export function savingOf(call) {
  if (!call.insteadOf) return 0;
  const actual = costOf(call);
  const instead = costOf({ ...call, provider: call.insteadOf.provider, model: call.insteadOf.model });
  return actual === null || instead === null ? 0 : Math.max(0, instead - actual);
}
