/**
 * GitHub REST API access.
 *
 * Token: one saved in the app (Settings → storage/settings.json) wins over
 * GITHUB_TOKEN from server/.env. The token is only ever sent to api.github.com
 * and is never returned to the browser (only its last four characters).
 *
 * GET responses are cached with their ETag: GitHub answers a repeated request
 * with 304 Not Modified, which doesn't count against the rate limit.
 */
import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { isolate } from '../../lib/bidi.js';
import { HttpError } from '../../lib/httpError.js';
import { readSettings, updateSettings } from '../../lib/settingsStore.js';

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
const MAX_CACHED_RESPONSES = 500;
const STATUS_TTL_MS = 60_000;

const responses = new Map(); // key → { etag, data }
let statusCache = { key: null, at: 0, value: null };

const tokenId = (token) => (token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : 'anonymous');

/** @returns {Promise<{ token: string|null, source: 'settings'|'env'|null }>} */
export async function currentToken() {
  const settings = await readSettings();
  if (settings.githubToken) return { token: settings.githubToken, source: 'settings' };
  if (config.github.token) return { token: config.github.token, source: 'env' };
  return { token: null, source: null };
}

/** The token, or a Hebrew 401 explaining how to connect GitHub. */
export async function requireToken() {
  const current = await currentToken();
  if (!current.token) {
    throw new HttpError(401, 'כדי להציג את המאגרים שלכם צריך לחבר את GitHub: הוסיפו טוקן גישה בהגדרות.', 'GITHUB_NOT_CONNECTED');
  }
  return current;
}

/**
 * GET from the GitHub API.
 * @param {string} path e.g. "/user/repos?per_page=100"
 * @param {{ token?: string|null, raw?: boolean }} [options] raw: file bytes from the contents API
 * @returns {Promise<{ data: any, headers: Headers }>}
 */
export async function githubRequest(path, { token = null, raw = false } = {}) {
  const accept = raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json';
  const key = `${tokenId(token)}|${accept}|${path}`;
  const cached = responses.get(key);
  const headers = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Stash-Dashboard' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cached) headers['If-None-Match'] = cached.etag;

  let response;
  try {
    response = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new HttpError(504, 'אין תשובה מ-GitHub. נסו שוב בעוד רגע.', 'GITHUB_TIMEOUT');
    }
    throw new HttpError(502, 'אין חיבור ל-GitHub. בדקו את החיבור לאינטרנט ונסו שוב.', 'GITHUB_UNREACHABLE');
  }
  if (response.status === 304 && cached) return { data: cached.data, headers: response.headers };
  if (!response.ok) throw await githubError(response, Boolean(token));

  const data = raw ? Buffer.from(await response.arrayBuffer()) : await response.json();
  const etag = response.headers.get('etag');
  if (etag) {
    responses.delete(key);
    responses.set(key, { etag, data });
    if (responses.size > MAX_CACHED_RESPONSES) responses.delete(responses.keys().next().value);
  }
  return { data, headers: response.headers };
}

async function githubError(response, authenticated) {
  let message = '';
  try {
    message = (await response.json())?.message ?? '';
  } catch {
    // no JSON body
  }
  const { status } = response;
  const rateLimited = response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message);
  if (status === 401) {
    return new HttpError(401, 'טוקן ה-GitHub אינו תקין או שפג תוקפו. עדכנו אותו בהגדרות.', 'GITHUB_UNAUTHORIZED');
  }
  if ((status === 403 || status === 429) && rateLimited) {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const at = reset ? new Intl.DateTimeFormat('he', { timeStyle: 'short' }).format(new Date(reset)) : null;
    const hint = authenticated ? '' : ' חיבור טוקן בהגדרות מגדיל את המכסה.';
    return new HttpError(429, `חרגתם ממכסת הבקשות ל-GitHub${at ? `. אפשר לנסות שוב אחרי ${at}` : ''}.${hint}`, 'GITHUB_RATE_LIMITED');
  }
  if (status === 403) return new HttpError(403, 'לטוקן אין הרשאה לבקשה הזו ב-GitHub.', 'GITHUB_FORBIDDEN');
  if (status === 404) return new HttpError(404, 'המאגר או הקובץ לא נמצאו ב-GitHub, או שלטוקן אין גישה אליהם.', 'GITHUB_NOT_FOUND');
  if (status === 409) return new HttpError(409, 'המאגר ריק: עדיין אין בו קבצים.', 'GITHUB_EMPTY_REPO');
  return new HttpError(502, `תשובה לא צפויה מ-GitHub (HTTP ${status})${message ? `: ${isolate(message)}` : ''}`, 'GITHUB_ERROR');
}

function rateLimitOf(headers) {
  const limit = Number(headers.get('x-ratelimit-limit'));
  if (!limit) return null;
  return {
    limit,
    remaining: Number(headers.get('x-ratelimit-remaining')),
    resetAt: new Date(Number(headers.get('x-ratelimit-reset')) * 1000).toISOString(),
  };
}

/**
 * Connection status for the Settings dialog: who the token belongs to, where
 * it came from, its scopes and the remaining rate limit. Cached for a minute.
 */
export async function getAuthStatus({ fresh = false } = {}) {
  const { token, source } = await currentToken();
  const envToken = Boolean(config.github.token);
  if (!token) return { connected: false, source: null, envToken };
  const key = tokenId(token);
  if (!fresh && statusCache.key === key && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;

  let value;
  try {
    const { data, headers } = await githubRequest('/user', { token });
    const scopes = headers.get('x-oauth-scopes');
    value = {
      connected: true,
      source,
      envToken,
      tokenHint: `…${token.slice(-4)}`,
      user: { login: data.login, name: data.name ?? null, avatarUrl: data.avatar_url ?? null, htmlUrl: data.html_url ?? null },
      scopes: scopes === null ? null : scopes.split(',').map((scope) => scope.trim()).filter(Boolean),
      rateLimit: rateLimitOf(headers),
    };
  } catch (error) {
    value = { connected: false, source, envToken, tokenHint: `…${token.slice(-4)}`, error: { message: error.message, code: error.code } };
  }
  statusCache = { key, at: Date.now(), value };
  return value;
}

/** Validates a token with GitHub, then saves it. */
export async function saveToken(raw) {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) {
    throw new HttpError(400, 'זה לא נראה כמו טוקן של GitHub. טוקן מתחיל בדרך כלל ב-github_pat_ או ב-ghp_.', 'INVALID_TOKEN');
  }
  try {
    await githubRequest('/user', { token });
  } catch (error) {
    if (error.code === 'GITHUB_UNAUTHORIZED') {
      throw new HttpError(400, 'הטוקן לא התקבל ב-GitHub. בדקו שהעתקתם אותו במלואו ושהוא עדיין בתוקף.', 'TOKEN_REJECTED');
    }
    throw error;
  }
  await updateSettings({ githubToken: token });
  statusCache = { key: null, at: 0, value: null };
  return getAuthStatus({ fresh: true });
}

/** Removes the saved token (GITHUB_TOKEN from server/.env, if set, applies again). */
export async function removeToken() {
  await updateSettings({ githubToken: null });
  statusCache = { key: null, at: 0, value: null };
  return getAuthStatus({ fresh: true });
}
