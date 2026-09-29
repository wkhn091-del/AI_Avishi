/**
 * URL helpers for the link manager.
 *
 * - normalizeUserUrl: turns whatever was pasted ("example.com/docs") into an
 *   absolute http(s) URL, or throws a 400 with an actionable message.
 * - checkHost: SSRF guard. The server fetches pages on the user's behalf, so a
 *   saved link must not be able to make it request loopback, LAN, link-local
 *   (cloud metadata) or other non-public addresses.
 *
 * Known limitation: the address is checked before fetch() resolves it again,
 * so a DNS-rebinding host could still switch addresses in between. The server
 * only runs locally and the response is never returned raw (only title,
 * description and image URLs are extracted), which keeps that risk small.
 */
import { isolate } from '../../lib/bidi.js';
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { HttpError } from '../../lib/httpError.js';

const MAX_URL_LENGTH = 2048;

/**
 * @param {unknown} input Raw text from the "Paste a link" field
 * @returns {string} Absolute, normalised http(s) URL
 * @throws {HttpError} 400 when it can't be a web address
 */
export function normalizeUserUrl(input) {
  let text = typeof input === 'string' ? input.trim() : '';
  if (!text) throw new HttpError(400, 'הדביקו קישור כדי לשמור אותו.', 'URL_REQUIRED');
  if (text.length > MAX_URL_LENGTH) {
    throw new HttpError(400, `קישור יכול להכיל עד ${MAX_URL_LENGTH} תווים.`, 'URL_TOO_LONG');
  }

  // No scheme ("example.com") or host:port ("localhost:3000") → add one:
  // http for local addresses (dev servers rarely use TLS), https otherwise.
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(text);
  if (!hasScheme) {
    const bare = text.replace(/^\/+/, '');
    const isLocal = /^(localhost|[^/:]+\.localhost|\d{1,3}(\.\d{1,3}){3}|\[[\da-f:.]+\])(?::\d+)?(?:[/?#]|$)/i.test(bare);
    text = `${isLocal ? 'http' : 'https'}://${bare}`;
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, `זו לא נראית כמו כתובת אינטרנט. נסו משהו כמו ${isolate('https://example.com')}.`, 'INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'אפשר לשמור רק קישורי http ו-https.', 'UNSUPPORTED_SCHEME');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && host !== 'localhost' && !net.isIP(host)) {
    throw new HttpError(400, `הכתובת ${isolate(url.hostname)} אינה דומיין מלא. נסו משהו כמו ${isolate(`${url.hostname}.com`)}.`, 'INVALID_URL');
  }

  // Credentials in URLs leak easily (logs, previews, sharing) — never keep them.
  url.username = '';
  url.password = '';
  return url.href;
}

/**
 * Resolves a hostname and reports whether every address it points to is a
 * public unicast address.
 * @param {string} hostname URL hostname (IPv6 literals may keep their brackets)
 * @returns {Promise<'public'|'private'|'unresolvable'>}
 */
export async function checkHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      return 'unresolvable';
    }
  }
  if (!addresses.length) return 'unresolvable';
  return addresses.every(isPublicAddress) ? 'public' : 'private';
}

/** True only for ordinary public unicast addresses (IPv4-mapped IPv6 is unwrapped first). */
export function isPublicAddress(address) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}
