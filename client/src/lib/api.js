/**
 * Thin client for the Stash API. Every failure becomes an ApiError whose
 * message comes from the server (already written for people), so the UI can
 * show `error.message` directly.
 */

// The API's origin when the app is served from somewhere else (VITE_API_URL at build time: the app on Vercel and the
// API on Render, say). Empty when they share one: the dev server's proxy, or the server serving the built app.
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '');
export const CROSS_ORIGIN = Boolean(API_BASE);
const apiUrl = (path) => `${API_BASE}/api${path}`;

const OFFLINE_MESSAGE = CROSS_ORIGIN
  ? `אין חיבור לשרת של Stash (\u2068${API_BASE}\u2069). אם הוא באחסון חינמי שנרדם, הוא מתעורר עכשיו: נסו שוב בעוד דקה. אם זה נמשך, בדקו שכתובת האפליקציה מופיעה ב-CORS_ORIGINS של השרת.`
  : 'אין חיבור לשרת של Stash. הפעילו אותו עם \u2068npm run dev\u2069 ונסו שוב.';

export class ApiError extends Error {
  /** @param {string} message @param {{ status?: number, code?: string, details?: object }} [info] */
  constructor(message, { status = 0, code = 'ERROR', details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// The signed-in person's access token (set by the auth provider), and what to do when the server
// answers 401 (refresh the session, or sign out).
let accessToken = null;
let unauthorized = null;
export function setAuth({ token, onUnauthorized } = {}) {
  if (token !== undefined) {
    accessToken = token;
    if (!token) linkToken = null;
  }
  if (onUnauthorized !== undefined) unauthorized = onUnauthorized;
}
const authHeaders = () => (accessToken ? { authorization: `Bearer ${accessToken}` } : {});

// With the API on another origin, what the browser loads by itself (images, videos, downloads, the team dashboard's
// live updates) can't send the Authorization header, and a cookie from the API's domain would be a third-party
// cookie (blocked by Brave and Safari). Those URLs carry a read-only link token instead (the server's
// lib/resourceTokens.js): fetched after signing in, and again hourly and when the tab comes back after a while.
let linkToken = null; // { token, at }
export async function refreshLinkToken({ force = false } = {}) {
  if (!CROSS_ORIGIN || !accessToken) return;
  if (!force && linkToken && Date.now() - linkToken.at < 10 * 60_000) return;
  try {
    linkToken = { token: (await request('/auth/resource-token')).token, at: Date.now() };
  } catch {
    // The token in hand still works (it lasts 12 hours); the next refresh tries again.
  }
}

/**
 * The URL of an /api resource the browser loads by itself: as it is when the app and the API share an origin (the
 * session cookie goes with it), or on the API's origin with the link token (`access`) when they don't.
 */
export function resourceUrl(url) {
  if (!url || !CROSS_ORIGIN || !url.startsWith('/api/')) return url;
  const access = linkToken ? `${url.includes('?') ? '&' : '?'}access=${encodeURIComponent(linkToken.token)}` : '';
  return `${API_BASE}${url}${access}`;
}

function toApiError(status, data) {
  if (status === 401 && accessToken) unauthorized?.();
  if (data?.error) return new ApiError(data.error.message, { status, code: data.error.code, details: data.error.details });
  // No JSON body on a 5xx usually means the dev proxy couldn't reach Express.
  if (status >= 500) return new ApiError(OFFLINE_MESSAGE, { status, code: 'OFFLINE' });
  return new ApiError(`הבקשה נכשלה (HTTP ${status}).`, { status });
}

/**
 * JSON request to /api. Resolves with the parsed body (null for 204).
 * @param {string} path e.g. "/projects"
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options]
 */
export async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      signal,
      headers: { ...authHeaders(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(OFFLINE_MESSAGE, { code: 'OFFLINE' });
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, data);
  return data;
}

/**
 * GET that returns text (the code viewer's raw file content). Errors carry the
 * server's Hebrew message, like request().
 * @returns {Promise<{ text: string, size: number|null }>}
 */
export async function requestText(path, { signal } = {}) {
  let response;
  try {
    response = await fetch(apiUrl(path), { signal, headers: authHeaders() });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(OFFLINE_MESSAGE, { code: 'OFFLINE' });
  }
  if (!response.ok) throw toApiError(response.status, await response.json().catch(() => null));
  return { text: await response.text(), size: Number(response.headers.get('x-file-size')) || null };
}

/**
 * multipart/form-data upload with progress (fetch can't report upload progress).
 * @param {string} path
 * @param {FormData} formData
 * @param {{ onProgress?: (fraction: number) => void, signal?: AbortSignal }} [options]
 *        onProgress receives 0…1; 1 means the bytes are sent and the server is working.
 */
export function uploadWithProgress(path, formData, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl(path));
    if (accessToken) xhr.setRequestHeader('authorization', `Bearer ${accessToken}`);
    xhr.responseType = 'json';

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.min(0.999, event.loaded / event.total));
    };
    xhr.upload.onload = () => onProgress?.(1);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(toApiError(xhr.status, xhr.response));
    };
    xhr.onerror = () => reject(new ApiError(OFFLINE_MESSAGE, { code: 'OFFLINE' }));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(formData);
  });
}

/**
 * POSTs `body` and reads the answer as JSON lines (application/x-ndjson),
 * calling `onEvent` for each line as it arrives. Errors before the stream
 * starts throw ApiError, like request().
 */
export async function streamJsonLines(path, body, { signal, onEvent }) {
  let response;
  try {
    response = await fetch(apiUrl(path), {
      method: 'POST',
      signal,
      headers: { ...authHeaders(), 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(OFFLINE_MESSAGE, { code: 'OFFLINE' });
  }
  if (!response.ok) throw toApiError(response.status, await response.json().catch(() => null));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}
