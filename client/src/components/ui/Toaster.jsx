import { AnimatePresence, motion } from 'framer-motion';
import { Check, CircleAlert, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../lib/cx.js';
import { nextClientId } from '../../lib/ids.js';

const ToastContext = createContext(null);

const TONES = {
  success: { icon: Check, className: 'text-ok', duration: 3_500 },
  info: { icon: Info, className: 'text-graphite', duration: 4_500 },
  error: { icon: CircleAlert, className: 'text-danger', duration: 7_000 },
};

/** Confirmation and error messages, bottom-right (bottom-centre on phones). */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (message, tone) => {
      const id = nextClientId('toast');
      setToasts((list) => [...list.slice(-3), { id, message, tone }]);
      timers.current.set(id, setTimeout(() => dismiss(id), TONES[tone].duration));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const api = useMemo(
    () => ({
      success: (message) => show(message, 'success'),
      info: (message) => show(message, 'info'),
      error: (message) => show(message, 'error'),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => {
            const { icon: Icon, className } = TONES[toast.tone];
            return (
              <motion.div
                key={toast.id}
                layout
                role={toast.tone === 'error' ? 'alert' : 'status'}
                initial={{ opacity: 0, y: 20, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                transition={{ type: 'spring', stiffness: 460, damping: 34 }}
                className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-line bg-surface py-3 pe-2 ps-4 shadow-[0_12px_40px_-12px_rgb(13_16_22/0.35)]"
              >
                <Icon size={18} className={cx('mt-0.5 shrink-0', className)} aria-hidden="true" />
                <p className="bidi-plain flex-1 text-[14.5px] leading-snug" dir="auto">
                  {toast.message}
                </p>
                <button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  aria-label="סגירה"
                  className="-my-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-mist hover:bg-sunken hover:text-ink"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

/** @returns {{ success: (m: string) => void, info: (m: string) => void, error: (m: string) => void, dismiss: (id: string) => void }} */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>.');
  return context;
}
