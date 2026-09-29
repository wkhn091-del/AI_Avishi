import { cx } from '../../lib/cx.js';

const VARIANTS = {
  primary: 'bg-ink text-on-ink hover:opacity-90',
  secondary: 'border border-line-strong bg-surface text-ink hover:border-graphite',
  ghost: 'text-graphite hover:bg-sunken hover:text-ink',
  danger: 'bg-danger text-on-ink hover:opacity-90',
};

/**
 * Pill button. `as="a"` renders a link styled the same way (used for downloads).
 * @param {{ variant?: keyof VARIANTS, size?: 'sm'|'md', icon?: import('react').ElementType, as?: 'button'|'a' }} props
 */
export function Button({ variant = 'secondary', size = 'md', icon: Icon, as: Tag = 'button', className, children, ...props }) {
  return (
    <Tag
      {...(Tag === 'button' ? { type: 'button' } : {})}
      {...props}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-[background-color,border-color,opacity] disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-[13.5px]' : 'h-10 px-4 text-[14.5px]',
        VARIANTS[variant],
        className,
      )}
    >
      {Icon && <Icon size={size === 'sm' ? 15 : 16} aria-hidden="true" />}
      {children}
    </Tag>
  );
}

/** Round icon-only button; `label` is its accessible name and tooltip. */
export function IconButton({ label, className, children, ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-graphite transition-colors hover:bg-sunken hover:text-ink disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}
