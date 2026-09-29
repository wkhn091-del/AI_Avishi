/**
 * Records the tokens of every model call made during a chat turn, without
 * passing a recorder through every function: the route opens a meter
 * (AsyncLocalStorage), and llmClient records each call into the meter it runs in.
 * Tags mark what a call was for (answer, continuation, router…) and, for the
 * cost-saving handoff, which model it replaced.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scopes = new AsyncLocalStorage();

/** `onCall(entry)` hears each call as it's recorded, for a live cost meter. */
export function createMeter({ onCall } = {}) {
  const calls = [];
  return { calls, run: (fn) => scopes.run({ calls, tags: {}, onCall }, fn) };
}

/** Runs `fn` with extra tags on the calls it makes (a no-op outside a meter). */
export function withTags(tags, fn) {
  const scope = scopes.getStore();
  return scope ? scopes.run({ calls: scope.calls, tags: { ...scope.tags, ...tags }, onCall: scope.onCall }, fn) : fn();
}

export const metering = () => scopes.getStore() !== undefined;

export function recordCall(call) {
  const scope = scopes.getStore();
  if (!scope) return;
  const entry = { ...scope.tags, ...call, at: new Date().toISOString() };
  for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
  scope.calls.push(entry);
  try {
    scope.onCall?.(entry);
  } catch {
    // a listener's failure never breaks the call being recorded
  }
}

/** A rough token count for text a provider didn't count: about 4 characters per token, 2 for Hebrew. */
export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  const hebrew = (value.match(/[\u0590-\u05FF]/g) ?? []).length;
  return Math.ceil(hebrew / 2 + (value.length - hebrew) / 4);
}
