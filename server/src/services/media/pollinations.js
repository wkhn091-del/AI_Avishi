/**
 * The media studio's generator: Pollinations (gen.pollinations.ai), one API for
 * images, speech, music and video, used with a secret key (sk_…) from
 * enter.pollinations.ai. Signing up needs no card, and registered accounts get
 * a small daily Pollen grant: plenty for images from cheap models such as Flux
 * Schnell, while music and video models cost far more per generation.
 */
import { config } from '../../config.js';
import { HttpError } from '../../lib/httpError.js';
import { retryAfterOf, withRetries } from '../../lib/retry.js';

const BASE = 'https://gen.pollinations.ai';
export const MEDIA_KINDS = Object.freeze(['image', 'speech', 'music', 'video']);

export const DEFAULT_MEDIA_MODELS = Object.freeze({
  image: 'black-forest-labs/flux.1-schnell',
  speech: 'elevenlabs/eleven-v3',
  music: 'elevenlabs/music-v2',
  video: 'alibaba/wan-2.2-fast',
});

/** Shown when the live catalogue can't be read. */
export const SUGGESTED_MODELS = Object.freeze({
  image: ['black-forest-labs/flux.1-schnell', 'tongyi-mai/z-image-turbo', 'black-forest-labs/flux.2-klein-4b', 'openai/gpt-image-1-mini', 'google/gemini-2.5-flash-image'],
  speech: ['elevenlabs/eleven-v3', 'elevenlabs/eleven-flash-v2.5', 'qwen/qwen3-tts-flash', 'hexgrad/kokoro-82m'],
  music: ['elevenlabs/music-v2', 'google/lyria-3-clip-preview', 'stability-ai/stable-audio-3-medium'],
  video: ['alibaba/wan-2.2-fast', 'bytedance/seedance-2.0-mini', 'google/veo-3.1-fast', 'amazon/nova-reel-v1'],
});

export const VOICES = Object.freeze(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse', 'rachel', 'bella', 'charlotte', 'sarah', 'lily', 'adam', 'antoni', 'josh', 'daniel', 'george', 'brian']);

/** Image sizes per aspect ratio (multiples of 16, about one megapixel). */
export const ASPECTS = Object.freeze({
  '1:1': [1024, 1024],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '3:2': [1216, 832],
  '2:3': [832, 1216],
});

const EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/aac': 'aac', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};
export const extensionOf = (mime) => EXTENSIONS[mime] ?? null;

export const isConfigured = () => Boolean(config.media.pollinationsKey);

// ---------------------------------------------------------------------------
// Live model catalogue (public, no key needed)

const CATALOGUE_TTL_MS = 60 * 60_000;
let catalogue = { at: 0, value: null };

function classify(entry) {
  const id = entry.id;
  const outputs = entry.outputs;
  if (outputs.includes('video') || /veo|seedance|wan-(2\.[2-6]|3\.\d|2\.7)(?!-image)|video|reel|happyhorse|minimax-h\d|omni/.test(id)) return 'video';
  if (outputs.includes('image') || /image|flux|dreamshaper|seedream|ideogram|recraft|kontext|krea|nova-canvas|p-image/.test(id)) return 'image';
  if (/music|lyria|stable-audio/.test(id)) return 'music';
  if (/whisper|transcribe|scribe|universal|isolator|sts|sound/.test(id)) return null;
  if (/tts|eleven-(v3|flash|multilingual)|kokoro|csm|fish-audio|qwen3-tts|dialogue/.test(id)) return 'speech';
  return null;
}

function normalize(list) {
  const items = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : [];
  return items
    .map((item) => {
      if (typeof item === 'string') return { id: item, outputs: [] };
      const id = item?.id ?? item?.name ?? item?.model;
      if (typeof id !== 'string') return null;
      const outputs = [item.output_modalities, item.outputModalities, item.outputs].find(Array.isArray) ?? [];
      return { id, outputs: outputs.map(String), paid: Boolean(item.paid_only ?? item.paidOnly), description: typeof item.description === 'string' ? item.description : null };
    })
    .filter(Boolean)
    .filter((entry) => !entry.id.startsWith('community/'));
}

/** Models per kind: the live catalogue when it can be read, the suggested ones otherwise. */
export async function mediaModels() {
  if (catalogue.value && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue.value;
  const grouped = { image: [], speech: [], music: [], video: [] };
  let live = false;
  for (const path of ['/image/models', '/audio/models', '/video/models']) {
    try {
      const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) continue;
      for (const entry of normalize(await response.json())) {
        const kind = classify(entry);
        if (kind && !grouped[kind].some((known) => known.id === entry.id)) grouped[kind].push(entry);
        live = true;
      }
    } catch {
      // the suggested models stand in
    }
  }
  const value = { live, models: {} };
  for (const kind of MEDIA_KINDS) {
    const ids = [...new Set([DEFAULT_MEDIA_MODELS[kind], ...SUGGESTED_MODELS[kind], ...grouped[kind].map((entry) => entry.id)])];
    value.models[kind] = ids.map((id) => ({ id, paid: grouped[kind].find((entry) => entry.id === id)?.paid ?? false }));
  }
  catalogue = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// Generation

function mediaError(status, message, code, detail) {
  return new HttpError(status, message, code, detail ? { detail } : undefined);
}

async function failureOf(response) {
  const raw = await response.text().catch(() => '');
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    // plain text
  }
  const text = String(payload?.error?.message ?? payload?.message ?? payload?.error ?? raw.slice(0, 300))
    .replaceAll(config.media.pollinationsKey || '\u0000', '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  const detail = `HTTP ${response.status} (Pollinations)${text ? `: ${text}` : ''}`;
  const status = response.status;
  if (status === 401) return mediaError(401, 'מפתח ה-Pollinations נדחה. בדקו את POLLINATIONS_API_KEY בקובץ server/.env.', 'MEDIA_UNAUTHORIZED', detail);
  if (status === 402) {
    return mediaError(
      402,
      'נגמרה יתרת ה-Pollen בחשבון ה-Pollinations. תמונות ממודלים זולים כמו Flux צורכות מעט מאוד; מוזיקה ווידאו יקרים בהרבה. אפשר לחכות למענק היומי או להטעין יתרה.',
      'MEDIA_PAYMENT_REQUIRED',
      detail,
    );
  }
  if (status === 403) return mediaError(403, 'המפתח אינו מורשה להשתמש במודל הזה. אפשר לבחור מודל אחר או לשנות את הרשאות המפתח ב-enter.pollinations.ai.', 'MEDIA_FORBIDDEN', detail);
  if (status === 404) return mediaError(404, 'המודל שנבחר לא נמצא ב-Pollinations. בחרו מודל אחר.', 'MEDIA_MODEL_NOT_FOUND', detail);
  if (status === 429 || status >= 500) {
    const error = mediaError(503, 'שירות Pollinations עמוס כרגע, ולא התקבלה תוצאה גם אחרי כמה ניסיונות. נסו שוב בעוד כמה דקות.', 'MEDIA_BUSY', detail);
    error.retryable = true;
    error.retryAfterMs = retryAfterOf(response.headers, payload);
    return error;
  }
  return mediaError(400, 'הבקשה נדחתה על ידי Pollinations. ייתכן שהמודל לא תומך באחת האפשרויות שנבחרו.', 'MEDIA_REJECTED', detail);
}

function buildRequest({ kind, prompt, model, aspect, seed, safe, voice, duration, audio }) {
  const key = config.media.pollinationsKey;
  const auth = { authorization: `Bearer ${key}` };
  const query = (values) =>
    new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString();
  // Safety filters for sexual and violent content (the Pollinations "safe" features).
  const safety = safe ? 'sexual,violence' : undefined;
  if (kind === 'image') {
    const [width, height] = ASPECTS[aspect] ?? ASPECTS['1:1'];
    return {
      url: `${BASE}/image/${encodeURIComponent(prompt)}?${query({ model, width, height, seed, safe: safety })}`,
      init: { headers: auth },
      timeoutMs: 180_000,
    };
  }
  if (kind === 'video') {
    return {
      url: `${BASE}/video/${encodeURIComponent(prompt)}?${query({ model, duration, aspectRatio: aspect, audio: audio ? 'true' : undefined, seed, safe: safety })}`,
      init: { headers: auth },
      timeoutMs: config.media.timeoutMs,
    };
  }
  const body = { model, input: prompt, response_format: 'mp3', ...(kind === 'speech' ? { voice } : {}) };
  return {
    url: `${BASE}/v1/audio/speech`,
    init: { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) },
    timeoutMs: kind === 'music' ? config.media.timeoutMs : 120_000,
  };
}

/**
 * Generates one image, speech clip, music clip or video.
 * @returns {Promise<{ bytes: Buffer, mime: string, ms: number }>}
 */
export async function generateMedia(request) {
  if (!isConfigured()) {
    throw mediaError(401, 'כדי ליצור מדיה צריך מפתח Pollinations. צרו מפתח חינמי ב-enter.pollinations.ai והוסיפו אותו כ-POLLINATIONS_API_KEY בקובץ server/.env.', 'MEDIA_NOT_CONFIGURED');
  }
  const { url, init, timeoutMs } = buildRequest(request);
  const started = Date.now();
  // The seed stays the same across retries, so a retry can pick up the generation already in progress.
  return withRetries(
    async () => {
      let response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (error.name === 'TimeoutError') {
          throw mediaError(504, `לא התקבלה תוצאה מ-Pollinations תוך ${Math.round(timeoutMs / 1000)} שניות.`, 'MEDIA_TIMEOUT');
        }
        const failure = mediaError(502, 'אין חיבור ל-Pollinations. בדקו את החיבור לאינטרנט ונסו שוב.', 'MEDIA_UNREACHABLE', String(error.cause?.code ?? error.message));
        failure.retryable = true;
        throw failure;
      }
      if (!response.ok) throw await failureOf(response);
      const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!extensionOf(mime)) {
        const text = (await response.text().catch(() => '')).slice(0, 200);
        throw mediaError(502, 'התשובה של Pollinations אינה קובץ מדיה.', 'MEDIA_BAD_RESPONSE', `${mime || 'no content type'}: ${text}`);
      }
      return { bytes: Buffer.from(await response.arrayBuffer()), mime, ms: Date.now() - started };
    },
    {
      retries: config.ai.maxRetries,
      baseMs: config.ai.retryBaseMs,
      isRetryable: (error) => Boolean(error.retryable),
      suggestedWait: (error) => error.retryAfterMs ?? null,
      onRetry: ({ error, nextAttempt, attempts, waitMs }) =>
        console.warn(`[media] Pollinations: ${error.details?.detail ?? error.message} Retrying in ${(waitMs / 1000).toFixed(1)} s (attempt ${nextAttempt} of ${attempts}).`),
    },
  );
}
