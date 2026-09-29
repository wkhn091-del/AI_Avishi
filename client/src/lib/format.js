/** Display formatting shared by every section (Hebrew locale). */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1536 → "1.5 KB", 262144000 → "250 MB" */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  // Left-to-right isolate, so a size reads "5.2 KB" (not "KB 5.2") inside right-to-left text.
  return `\u2066${value.toFixed(digits).replace(/\.0$/, '')} ${UNITS[unit]}\u2069`;
}

const relative = new Intl.RelativeTimeFormat('he', { numeric: 'auto' });
const STEPS = [
  [60, 'second', 1],
  [3_600, 'minute', 60],
  [86_400, 'hour', 3_600],
  [604_800, 'day', 86_400],
  [2_629_800, 'week', 604_800],
  [31_557_600, 'month', 2_629_800],
  [Infinity, 'year', 31_557_600],
];

/** ISO date → "הרגע", "לפני 5 דקות", "אתמול", "לפני 3 שבועות" */
export function formatRelative(iso, now = Date.now()) {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (Math.abs(seconds) < 45) return 'הרגע';
  const [, unit, size] = STEPS.find(([limit]) => Math.abs(seconds) < limit);
  return relative.format(Math.round(seconds / size), unit);
}

const dateTime = new Intl.DateTimeFormat('he', { dateStyle: 'medium', timeStyle: 'short' });
export const formatDateTime = (iso) => dateTime.format(new Date(iso));

/**
 * Hebrew count phrase: pluralize(1, 'קובץ אחד', 'קבצים') → "קובץ אחד",
 * pluralize(1200, 'קובץ אחד', 'קבצים') → "1,200 קבצים".
 */
export function pluralize(count, one, many) {
  return count === 1 ? one : `${count.toLocaleString('he-IL')} ${many}`;
}

/** Unicode isolate (FSI … PDI): keeps a Latin name, path or URL intact inside a Hebrew sentence. */
export const isolate = (text) => `\u2068${text}\u2069`;

/** A name in quotes for messages, e.g. הקובץ "report (2).pdf" הועלה */
export const quote = (text) => `"${isolate(text)}"`;

/** "https://www.github.com/a/b?x" → "github.com/a/b?x", decoded for readability (Hebrew paths). */
export function displayUrl(url) {
  let text = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  try {
    text = decodeURI(text);
  } catch {
    // keep the encoded form
  }
  return text;
}

/** Case-insensitive "every word appears somewhere" search. */
export function matchesQuery(query, ...fields) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fields.flat().filter(Boolean).join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** An estimated cost in US dollars, with enough decimals to show small amounts. */
export function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  if (value < 0.0001) return '<$0.0001';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** A token count: 950, 12.4K, 1.2M. */
export function formatTokens(count) {
  const value = Number(count) || 0;
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
