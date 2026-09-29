import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx.js';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DURATION = 300; // ms, the length of the slide below

/**
 * A side drawer for phones and tablets. It slides in from the start edge (the
 * right on a Hebrew page) over a dimmed page, which stops scrolling and can't
 * be focused meanwhile. Escape and the backdrop close it; focus moves to the
 * element marked `data-autofocus` (or the drawer), stays inside, and goes back
 * to what opened it.
 */
export function Drawer({ open, onClose, labelledBy, className, children }) {
  const panel = useRef(null);
  const closeRef = useRef(onClose);
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // Mount, paint the closed position, then slide in; on close, slide out and unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), DURATION);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !mounted) return undefined;
    const returnTo = document.activeElement;
    const root = document.getElementById('root');
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    if (root) root.inert = true;
    const frame = requestAnimationFrame(() => (panel.current?.querySelector('[data-autofocus]') ?? panel.current)?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      if (root) root.inert = false;
      if (returnTo?.isConnected) returnTo.focus?.();
    };
  }, [open, mounted]);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeRef.current();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...panel.current.querySelectorAll(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!mounted) return null;
  const offscreen = document.documentElement.dir === 'rtl' ? '100%' : '-100%';
  return createPortal(
    <div className="fixed inset-0 z-40">
      <div
        aria-hidden="true"
        onClick={() => closeRef.current()}
        className={cx('absolute inset-0 bg-scrim/45 transition-opacity duration-300 motion-reduce:transition-none', shown ? 'opacity-100' : 'opacity-0')}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ transform: shown ? 'none' : `translateX(${offscreen})` }}
        className={cx(
          'absolute inset-y-0 start-0 flex w-[min(86vw,340px)] flex-col bg-paper shadow-[0_0_48px_rgb(13_16_22/0.28)] outline-none',
          'transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
