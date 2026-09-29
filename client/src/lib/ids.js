/** Client-only ids for optimistic items. (crypto.randomUUID needs a secure context, so it can't be used on LAN http.) */
let sequence = 0;
export const nextClientId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(sequence += 1)}`;
