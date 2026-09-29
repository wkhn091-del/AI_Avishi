/**
 * Wraps text in Unicode isolates (FSI … PDI) so a Latin name, URL, path or
 * provider message keeps its own direction inside a Hebrew (right-to-left)
 * sentence, e.g. "הקובץ "report (2).pdf" הועלה" or "ב-C#".
 */
export const isolate = (text) => `\u2068${text}\u2069`;
