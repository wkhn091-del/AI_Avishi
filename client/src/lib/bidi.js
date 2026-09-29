const RTL_LETTERS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const LTR_LETTERS = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g;

/**
 * The direction of mixed Hebrew/English text by its letters, not its first
 * character: "REST ו-GraphQL פותרים…" is a Hebrew sentence that happens to
 * start with an English word, which dir="auto" would lay out left-to-right.
 * Hebrew wins unless it is under a quarter of the English letters.
 * @returns {'rtl'|'ltr'|'auto'}
 */
export function directionOf(text) {
  const value = String(text ?? '');
  const rtl = value.match(RTL_LETTERS)?.length ?? 0;
  const ltr = value.match(LTR_LETTERS)?.length ?? 0;
  if (!rtl && !ltr) return 'auto';
  return rtl >= ltr * 0.25 ? 'rtl' : 'ltr';
}
