/**
 * Retries temporary failures with exponential backoff (base, 2×base, 4×base…)
 * and ±20 % jitter, so parallel requests don't retry in lockstep. A wait the
 * server asked for (Retry-After, OpenRouter's rate-limit reset, Gemini's
 * RetryInfo) is used instead; when that is longer than `maxSuggestedMs`, the
 * quota won't reset soon, so the failure is reported at once.
 */

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * @param {(attempt: number) => Promise<any>} task
 * @param {{ retries: number, baseMs: number, maxSuggestedMs?: number, isRetryable: (error: any) => boolean,
 *           suggestedWait?: (error: any) => number|null, onRetry?: (info: object) => any, signal?: AbortSignal }} policy
 * The error finally thrown carries `attempts`, the number of attempts made.
 */
export async function withRetries(task, { retries, baseMs, maxSuggestedMs = 30_000, isRetryable, suggestedWait = () => null, onRetry, signal }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      let wait = null;
      if (attempt <= retries && isRetryable(error)) {
        const suggested = suggestedWait(error);
        if (suggested === null || suggested === undefined) wait = Math.round(baseMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));
        else if (suggested <= maxSuggestedMs) wait = suggested;
      }
      if (wait === null) {
        if (error && typeof error === 'object') error.attempts = attempt;
        throw error;
      }
      await onRetry?.({ error, attempt, nextAttempt: attempt + 1, attempts: retries + 1, waitMs: wait });
      await sleep(wait, signal);
    }
  }
}

/** A wait the server asked for, in milliseconds, or null when it didn't say. */
export function retryAfterOf(headers, payload) {
  const header = headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(1_000, at - Date.now());
  }
  const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
  const info = details.find((item) => String(item?.['@type'] ?? '').endsWith('google.rpc.RetryInfo'));
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(info?.retryDelay ?? ''));
  if (match) return Math.max(1_000, Math.ceil(Number(match[1]) * 1_000));
  const reset = Number(headers.get('x-ratelimit-reset')); // OpenRouter: epoch milliseconds
  if (reset > 1e12) return Math.max(1_000, reset - Date.now());
  return null;
}
