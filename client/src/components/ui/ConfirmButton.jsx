import { motion } from 'framer-motion';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cx } from '../../lib/cx.js';

/**
 * Two-step destructive button: the first click turns it red and asks again
 * ("אישור מחיקה"), the second click acts. It disarms itself after 3
 * seconds or when focus leaves — no confirmation dialog needed.
 */
export function ConfirmButton({
  onConfirm,
  label = 'מחיקה',
  confirmLabel = 'אישור מחיקה',
  icon: Icon = Trash2,
  compact = false,
  disabled = false,
  className,
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 3_000);
    return () => clearTimeout(timer);
  }, [armed]);

  const showText = !compact || armed;
  return (
    <motion.button
      type="button"
      layout
      transition={{ layout: { type: 'spring', stiffness: 520, damping: 38 } }}
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
      aria-label={showText ? undefined : label}
      title={showText ? undefined : label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        compact ? 'h-8 min-w-8 px-2 text-[13px]' : 'h-10 px-4 text-[14.5px]',
        // on-ink doubles as "text on a strong fill": white in light mode, near-black in dark mode.
        armed ? 'bg-danger text-on-ink' : 'text-graphite hover:bg-sunken hover:text-ink',
        className,
      )}
    >
      <motion.span layout="position" className="inline-flex">
        <Icon size={compact ? 15 : 16} aria-hidden="true" />
      </motion.span>
      {showText && (
        <motion.span layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          {armed ? confirmLabel : label}
        </motion.span>
      )}
    </motion.button>
  );
}
