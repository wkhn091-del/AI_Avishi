/**
 * The AI providers Stash can call, in order of preference for the primary
 * provider and the ensemble's synthesizer. Default models were checked in
 * September 2026; each can be changed in server/.env (modelEnv), and the chat
 * lists every model a provider currently offers.
 *
 *   api: 'gemini' | 'anthropic' | 'openai' (OpenAI-compatible chat completions)
 *   free: has a free tier with no card; the default summary ensemble uses only these.
 *   workspace: the chat workspace the provider belongs to ('free' or 'premium');
 *              Pollinations belongs to neither: it serves the media studio.
 */
export const PROVIDERS = Object.freeze([
  {
    id: 'gemini', name: 'Gemini', api: 'gemini', free: true, workspace: 'premium',
    keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_MODEL', keyUrl: 'https://aistudio.google.com/apikey',
    // Google's rolling aliases: the current Flash, Flash-Lite and Pro models.
    defaultModel: 'gemini-flash-latest', suggested: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'],
  },
  {
    id: 'anthropic', name: 'Anthropic', api: 'anthropic', free: false, workspace: 'premium',
    keyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'ANTHROPIC_MODEL', keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-haiku-4-5-20251001', suggested: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5'],
  },
  {
    id: 'openai', name: 'OpenAI', api: 'openai', free: false, workspace: 'premium', baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL', keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-5.4-mini', suggested: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.4-nano'],
    tokenField: 'max_completion_tokens', reasoningField: 'reasoning_effort', streamUsage: true,
  },
  {
    id: 'groq', name: 'Groq', api: 'openai', free: true, workspace: 'free', baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY', modelEnv: 'GROQ_MODEL', keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'openai/gpt-oss-120b', suggested: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b'],
    reasoningField: 'reasoning_effort', streamUsage: true,
  },
  {
    id: 'cohere', name: 'Cohere', api: 'openai', free: true, workspace: 'free', baseUrl: 'https://api.cohere.com/compatibility/v1',
    modelsUrl: 'https://api.cohere.com/v1/models?endpoint=chat&page_size=100',
    keyEnv: 'COHERE_API_KEY', modelEnv: 'COHERE_MODEL', keyUrl: 'https://dashboard.cohere.com/api-keys',
    defaultModel: 'command-a-plus-05-2026', suggested: ['command-a-plus-05-2026', 'command-a-03-2025'],
  },
  {
    id: 'openrouter', name: 'OpenRouter', api: 'openai', free: true, workspace: 'free', baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', keyUrl: 'https://openrouter.ai/keys',
    // OpenRouter's router over its free models, so rotating free models don't break anything.
    defaultModel: 'openrouter/free', suggested: ['openrouter/free'],
    headers: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'Stash Dashboard' }, reasoningField: 'reasoning',
    streamUsage: true,
  },
  {
    id: 'huggingface', name: 'Hugging Face', api: 'openai', free: true, workspace: 'free', baseUrl: 'https://router.huggingface.co/v1',
    keyEnv: 'HF_API_KEY', modelEnv: 'HF_MODEL', keyUrl: 'https://huggingface.co/settings/tokens',
    // ":cheapest" lets the router pick the lowest-priced partner, which stretches the small free monthly credit.
    defaultModel: 'openai/gpt-oss-120b:cheapest', suggested: ['openai/gpt-oss-120b:cheapest', 'openai/gpt-oss-20b:cheapest'],
    reasoningField: 'reasoning_effort',
  },
  {
    // Legacy deepseek-chat / deepseek-reasoner were retired on 24 July 2026.
    id: 'deepseek', name: 'DeepSeek', api: 'openai', free: false, workspace: 'premium', baseUrl: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-flash', suggested: ['deepseek-flash', 'deepseek-v4-pro'],
    reasoningField: 'reasoning_effort',
    streamUsage: true,
  },
  {
    // kimi-k2.5 and the moonshot-v1 models were retired on 31 August 2026.
    id: 'moonshot', name: 'Kimi', api: 'openai', free: false, workspace: 'premium', baseUrl: 'https://api.moonshot.ai/v1',
    keyEnv: 'MOONSHOT_API_KEY', modelEnv: 'MOONSHOT_MODEL', keyUrl: 'https://platform.kimi.ai/console/api-keys',
    defaultModel: 'kimi-k2.6', suggested: ['kimi-k2.6', 'kimi-k3', 'kimi-k2.7-code'],
  },
  {
    id: 'pollinations', name: 'Pollinations', api: 'openai', free: false, baseUrl: 'https://gen.pollinations.ai/v1',
    keyEnv: 'POLLINATIONS_API_KEY', modelEnv: 'POLLINATIONS_TEXT_MODEL', keyUrl: 'https://enter.pollinations.ai/keys',
    defaultModel: 'openai/gpt-5.4-nano', suggested: ['openai/gpt-5.4-nano', 'google/gemini-3.5-flash-lite', 'deepseek/deepseek-v4-flash'],
    reasoningField: 'reasoning_effort',
  },
]);

export const providerById = (id) => PROVIDERS.find((provider) => provider.id === id) ?? null;

/** Whether a model takes a reasoning effort / thinking budget (the chat's effort slider). */
export function supportsReasoning(providerId, model) {
  const id = String(model).toLowerCase();
  switch (providerId) {
    case 'gemini':
      return /gemini-(2\.5|[3-9])|gemini-(flash|flash-lite|pro)-latest/.test(id);
    case 'anthropic':
      return /claude-(opus|sonnet|haiku|fable|mythos)-[4-9]|claude-(opus|sonnet|fable|mythos)/.test(id);
    case 'openai':
      return /^(o\d|gpt-5|gpt-6)/.test(id);
    case 'groq':
    case 'huggingface':
      return /gpt-oss/.test(id);
    case 'deepseek':
      return /v4|flash|pro/.test(id);
    case 'openrouter':
    case 'pollinations':
      return true; // both ignore reasoning settings on models without reasoning
    default:
      return false;
  }
}
