/**
 * Fetches a page and extracts preview metadata: title, description, image,
 * site name and favicon (OpenGraph → Twitter cards → plain HTML fallbacks).
 *
 * Built on fetch + cheerio rather than a preview library so every safety
 * property is explicit:
 *  - each redirect hop is re-checked against the SSRF guard (max 5 hops),
 *  - the whole request is bounded by a timeout,
 *  - at most 2 MB is read, and reading stops once </head> has arrived,
 *  - legacy charsets (e.g. windows-1255 Hebrew pages) are decoded correctly.
 *
 * It never throws for network or site problems: the link is still saved and
 * the result says why the preview is missing (metadataStatus + metadataNote).
 */
import { isolate } from '../../lib/bidi.js';
import { domainToUnicode } from 'node:url';
import * as cheerio from 'cheerio';
import { config } from '../../config.js';
import { truncateText } from '../projects/manifestParsers.js';
import { checkHost } from './urlSafety.js';

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const REQUEST_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; StashDashboard/1.0; link preview)',
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  'accept-language': 'en-US,en;q=0.9,*;q=0.5',
};

/** A failure with a message that is safe and useful to show on the card. */
class PreviewError extends Error {
  constructor(message, status = 'unavailable') {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {object} LinkPreview
 * @property {string} finalUrl       URL after redirects
 * @property {string} domain         Display domain, e.g. "github.com"
 * @property {string|null} siteName
 * @property {string|null} title
 * @property {string|null} description
 * @property {string|null} image     Absolute http(s) URL of the preview image
 * @property {string|null} favicon   Absolute http(s) URL of the best icon
 * @property {'ok'|'unavailable'|'skipped'} metadataStatus
 * @property {string|null} metadataNote Why metadata is missing, when it is
 * @property {string} fetchedAt
 */

/**
 * @param {string} pageUrl Normalised absolute URL (see normalizeUserUrl)
 * @returns {Promise<LinkPreview>}
 */
export async function fetchLinkPreview(pageUrl) {
  const start = new URL(pageUrl);
  const base = {
    finalUrl: start.href,
    domain: displayDomain(start),
    siteName: null,
    title: null,
    description: null,
    image: null,
    favicon: null,
    metadataStatus: 'ok',
    metadataNote: null,
    fetchedAt: new Date().toISOString(),
  };

  try {
    const { response, url } = await fetchWithCheckedRedirects(start);
    const finalUrl = url.href;
    const result = { ...base, finalUrl, domain: displayDomain(url), favicon: new URL('/favicon.ico', url).href };

    if (!response.ok) {
      await response.body?.cancel();
      return { ...result, metadataStatus: 'unavailable', metadataNote: describeHttpStatus(response.status) };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const mimeType = contentType.split(';')[0].trim().toLowerCase();
    if (mimeType && mimeType !== 'text/html' && mimeType !== 'application/xhtml+xml') {
      await response.body?.cancel();
      const fileName = safeDecode(url.pathname.split('/').filter(Boolean).pop() ?? '') || null;
      return {
        ...result,
        title: fileName,
        image: mimeType.startsWith('image/') && mimeType !== 'image/svg+xml' ? finalUrl : null,
        metadataNote: `קישור ישיר לקובץ מסוג ${isolate(mimeType)}.`,
      };
    }

    const html = decodeHtml(await readHead(response), contentType);
    return { ...result, ...extractMetadata(html, url) };
  } catch (error) {
    const status = error instanceof PreviewError ? error.status : 'unavailable';
    return { ...base, metadataStatus: status, metadataNote: describeError(error) };
  }
}

/** Follows redirects manually so every hop passes the SSRF guard. */
export async function fetchWithCheckedRedirects(startUrl) {
  const signal = AbortSignal.timeout(config.links.timeoutMs);
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!config.links.allowPrivateNetwork) {
      const verdict = await checkHost(url.hostname);
      if (verdict === 'unresolvable') throw new PreviewError('הדומיין לא נמצא.');
      if (verdict === 'private') {
        throw new PreviewError(
          hop === 0
            ? 'לא נוצרה תצוגה מקדימה: זו כתובת מקומית או כתובת ברשת פרטית.'
            : 'לא נוצרה תצוגה מקדימה: הקישור מפנה לכתובת מקומית או לכתובת ברשת פרטית.',
          'skipped',
        );
      }
    }

    const response = await fetch(url, { headers: REQUEST_HEADERS, redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PreviewError('הקישור מפנה לכתובת שאינה כתובת אינטרנט.');
      continue;
    }
    return { response, url };
  }
  throw new PreviewError(`הקישור הפנה הלאה יותר מ-${MAX_REDIRECTS} פעמים.`);
}

/** Reads the body until </head> (or the size cap) and stops the download. */
async function readHead(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      chunks.push(chunk);
      size += chunk.length;
      if (chunk.includes('</head>') || chunk.includes('</HEAD>')) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_HTML_BYTES);
}

/** Decodes with the charset from the header or a <meta charset>, defaulting to UTF-8. */
function decodeHtml(buffer, contentType) {
  const fromHeader = /charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType)?.[1];
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(buffer.subarray(0, 8192).toString('latin1'))?.[1];
  for (const charset of [fromHeader, fromMeta, 'utf-8']) {
    if (!charset) continue;
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch {
      // Unknown label — try the next candidate.
    }
  }
  return buffer.toString('utf8');
}

/** OpenGraph → Twitter card → plain HTML, for each field. */
function extractMetadata(html, pageUrl) {
  const $ = cheerio.load(html);
  const meta = (...keys) => {
    for (const key of keys) {
      const value = clean($(`meta[property="${key}" i], meta[name="${key}" i]`).first().attr('content'));
      if (value) return value;
    }
    return null;
  };

  const siteName = meta('og:site_name', 'application-name', 'apple-mobile-web-app-title');
  const title = stripSiteName(meta('og:title', 'twitter:title') ?? clean($('title').first().text()), siteName);
  const description = dropIfRepeated(meta('og:description', 'twitter:description', 'description'), title);
  return {
    title: title ? truncateText(title, 200) : null,
    description: description ? truncateText(description, 500) : null,
    siteName,
    image: absoluteHttpUrl(meta('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), pageUrl),
    favicon: pickFavicon($, pageUrl),
  };
}

/**
 * Removes the site name when a title carries it as a prefix or suffix — the
 * card already shows it. "GitHub - owner/repo: About" → "owner/repo: About",
 * "Array.map() | MDN" → "Array.map()". Titles that are only the site name stay.
 */
export function stripSiteName(title, siteName) {
  if (!title || !siteName) return title;
  const name = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = title
    .replace(new RegExp(`^${name}\\s*[-–—|:·]\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*[-–—|·]\\s*${name}$`, 'i'), '')
    .trim();
  return stripped || title;
}

/**
 * Drops a description that only repeats the title, like GitHub's
 * "About text. - owner/repo" under the title "owner/repo: About text."
 */
export function dropIfRepeated(description, title) {
  if (!description || !title) return description;
  const core = description.replace(/\s+[-–—|]\s+[^-–—|]+$/, '').trim().toLowerCase();
  return core.length >= 12 && title.toLowerCase().includes(core) ? null : description;
}

/** apple-touch-icon → largest declared icon → first icon → /favicon.ico */
function pickFavicon($, pageUrl) {
  const icons = $('link[rel][href]')
    .toArray()
    .map((element) => ({
      rel: String(element.attribs.rel).toLowerCase().split(/\s+/),
      href: element.attribs.href,
      size: largestSize(element.attribs.sizes),
    }))
    .filter((icon) => icon.rel.includes('icon') || icon.rel.some((rel) => rel.startsWith('apple-touch-icon')));

  const touch = icons.find((icon) => icon.rel.some((rel) => rel.startsWith('apple-touch-icon')));
  const largest = icons.filter((icon) => icon.rel.includes('icon')).sort((a, b) => b.size - a.size)[0];
  for (const icon of [touch, largest]) {
    const href = absoluteHttpUrl(icon?.href, pageUrl);
    if (href) return href;
  }
  return new URL('/favicon.ico', pageUrl).href;
}

function largestSize(sizes = '') {
  if (sizes.trim().toLowerCase() === 'any') return 512;
  return Math.max(0, ...sizes.split(/\s+/).map((size) => Number.parseInt(size, 10) || 0));
}

function absoluteHttpUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function clean(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text || null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** "www.github.com" → "github.com"; punycode → Unicode (Hebrew/IDN domains). */
function displayDomain(url) {
  return (domainToUnicode(url.hostname) || url.hostname).replace(/^www\./, '');
}

function describeHttpStatus(status) {
  if (status === 401 || status === 403) return `האתר חסם את בקשת התצוגה המקדימה (HTTP ${status}).`;
  if (status === 404 || status === 410) return `הדף לא נמצא (HTTP ${status}).`;
  if (status === 429) return 'האתר מגביל את קצב הבקשות (HTTP 429). נסו לרענן מאוחר יותר.';
  if (status >= 500) return `באתר אירעה שגיאת שרת (HTTP ${status}).`;
  return `האתר החזיר HTTP ${status}.`;
}

function describeError(error) {
  if (error instanceof PreviewError) return error.message;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `האתר לא הגיב תוך ${Math.round(config.links.timeoutMs / 1000)} שניות.`;
  }
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'הדומיין לא נמצא.';
  if (code === 'ECONNREFUSED') return 'האתר דחה את החיבור.';
  if (code === 'ECONNRESET') return 'האתר סגר את החיבור.';
  if (typeof code === 'string' && /CERT|SELF_SIGNED|TLS|SSL/i.test(code)) return 'לא ניתן היה לאמת את תעודת האבטחה של האתר.';
  return `לא ניתן היה לטעון את הדף${code ? ` (${isolate(code)})` : ''}.`;
}
