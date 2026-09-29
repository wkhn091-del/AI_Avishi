import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx.js';

/**
 * Accessible dialog rendered in a portal. While open, the page behind is
 * inert and doesn't scroll; focus moves into the dialog and returns to the
 * element that opened it. Escape and a click on the backdrop call onClose.
 * size: 'sm' (a short confirmation or form), 'md' (default) or 'xl', a tall
 * workspace for the project details.
 */
export function Modal({ open, onClose, labelledBy, className, size = 'md', children }) {
  const panel = useRef(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const root = document.getElementById('root');
    const { overflow } = document.body.style;

    // <html> has scrollbar-gutter: stable (index.css), so hiding the scrollbar
    // doesn't shift the page, whichever side the scrollbar is on.
    document.body.style.overflow = 'hidden';
    if (root) root.inert = true;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    const frame = requestAnimationFrame(() => panel.current?.focus());

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      if (root) root.inert = false;
      opener?.focus?.();
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="modal"
          className="fixed inset-0 z-40 flex items-end justify-center sm:items-center sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-scrim/45 backdrop-blur-[3px]" onClick={() => closeRef.current()} aria-hidden="true" />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            tabIndex={-1}
            initial={{ opacity: 0, y: 28, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            className={cx(
              'relative flex w-full flex-col overflow-hidden rounded-t-[22px] bg-surface shadow-[0_24px_80px_-12px_rgb(13_16_22/0.5)] outline-none sm:rounded-[22px]',
              size === 'xl' ? 'h-[94dvh] sm:h-[min(90dvh,960px)] sm:max-w-6xl' : size === 'sm' ? 'max-h-[92dvh] sm:max-w-md' : 'max-h-[92dvh] sm:max-w-3xl',
              className,
            )}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
