/**
 * Can a site be shown inside an iframe? Reads X-Frame-Options and the CSP
 * frame-ancestors directive, fetching through the link previewer's SSRF-safe
 * path (every redirect hop checked). Results are cached for ten minutes.
 */
import { fetchWithCheckedRedirects } from '../links/linkPreview.js';

const TTL_MS = 10 * 60_000;
const results = new Map();

/** @returns {Promise<{ framable: boolean|null }>} null when the site couldn't be checked */
export async function checkFramable(url) {
  const cached = results.get(url);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  let value;
  try {
    const { response } = await fetchWithCheckedRedirects(new URL(url));
    await response.body?.cancel();
    const frameOptions = (response.headers.get('x-frame-options') ?? '').toLowerCase();
    const ancestors = /frame-ancestors\s+([^;]+)/i.exec(response.headers.get('content-security-policy') ?? '')?.[1]?.trim().split(/\s+/);
    const blocked = frameOptions.includes('deny') || frameOptions.includes('sameorigin') || (ancestors !== undefined && !ancestors.includes('*'));
    value = { framable: !blocked };
  } catch {
    value = { framable: null };
  }
  results.set(url, { at: Date.now(), value });
  return value;
}
