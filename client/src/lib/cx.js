/** Joins truthy class names: cx('a', cond && 'b') */
export const cx = (...parts) => parts.filter(Boolean).join(' ');
