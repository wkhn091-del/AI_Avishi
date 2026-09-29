import { motion } from 'framer-motion';
import { useRef } from 'react';
import { cx } from '../../lib/cx.js';

/**
 * Underlined tabs (role="tablist"). Arrow keys move between enabled tabs and
 * follow the page direction: on a right-to-left page ← goes to the next tab.
 *
 * @param {{ items: Array<{ id: string, label: string, icon?: import('react').ElementType, disabled?: boolean }>,
 *           value: string, onChange: (id: string) => void, label: string, idPrefix: string, className?: string }} props
 */
export function Tabs({ items, value, onChange, label, idPrefix, className }) {
  const buttons = useRef({});

  const onKeyDown = (event) => {
    const rtl = document.documentElement.dir === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const enabled = items.filter((item) => !item.disabled);
    const index = enabled.findIndex((item) => item.id === value);
    const next = enabled[(index + step + enabled.length) % enabled.length].id;
    onChange(next);
    buttons.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cx('flex gap-1 overflow-x-auto', className)}>
      {items.map(({ id, label: text, icon: Icon, disabled }) => {
        const selected = id === value;
        return (
          <button
            key={id}
            ref={(element) => {
              buttons.current[id] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-${id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(id)}
            className={cx(
              'relative inline-flex shrink-0 items-center gap-2 px-3 pt-2 pb-3 text-[14.5px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              selected ? 'text-ink' : 'text-graphite hover:text-ink',
            )}
          >
            {Icon && <Icon size={16} aria-hidden="true" />}
            {text}
            {selected && (
              <motion.span
                layoutId={`${idPrefix}-underline`}
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-ink"
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
