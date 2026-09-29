import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx.js';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DURATION = 320; // ms, the length of the CSS transitions below
const onPhone = () => !window.matchMedia('(min-width: 640px)').matches;

/**
 * A sheet for pickers and menus.
 *
 * On a phone it is a bottom sheet, as in native apps: it slides up from the
 * bottom edge, and dragging the handle or the title down, or flicking it,
 * closes it; a short drag springs back. From 640px wide it is a centred dialog
 * that fades and scales in, with a close button. Both are CSS transitions on
 * `translate`, `scale` and `opacity` (no movement with reduced motion). Escape
 * and the backdrop close it; focus moves in, stays inside, and goes back to
 * what opened it.
 */
export function BottomSheet({ open, onClose, id, title, children }) {
  const panel = useRef(null);
  const backdrop = useRef(null);
  const drag = useRef(null);
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  // Mount, paint the closed state, then switch to the open one so the transition runs; on close, run it back and unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      for (const element of [panel.current, backdrop.current]) element?.removeAttribute('style');
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
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll(FOCUSABLE)];
        if (!items.length) return;
        const [first, last] = [items[0], items.at(-1)];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    const frame = requestAnimationFrame(() => panel.current?.querySelector('[data-autofocus]')?.focus() ?? panel.current?.querySelector(FOCUSABLE)?.focus());
    return () => {
      document.removeEventListener('keydown', onKey, true);
      cancelAnimationFrame(frame);
      returnTo?.focus?.();
    };
  }, [open, mounted, onClose]);

  // Dragging (phones only): the sheet follows the finger down, resists going up, and closes past 90px or on a flick.
  const onPointerDown = (event) => {
    if (!onPhone() || event.button > 0 || event.target.closest('button')) return;
    drag.current = { pointer: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: event.timeStamp, velocity: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    panel.current.style.transition = 'none';
    backdrop.current.style.transition = 'none';
  };
  const onPointerMove = (event) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    const offset = event.clientY - state.startY;
    const y = offset > 0 ? offset : offset / 5;
    if (event.timeStamp > state.lastTime) state.velocity = (event.clientY - state.lastY) / (event.timeStamp - state.lastTime);
    state.lastY = event.clientY;
    state.lastTime = event.timeStamp;
    panel.current.style.translate = `0 ${y}px`;
    backdrop.current.style.opacity = String(Math.max(0, 1 - Math.max(0, y) / panel.current.offsetHeight));
  };
  const onPointerEnd = (event) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    drag.current = null;
    panel.current.style.transition = '';
    backdrop.current.style.transition = '';
    if (event.clientY - state.startY > 90 || state.velocity > 0.5) {
      panel.current.style.translate = '0 100%';
      backdrop.current.style.opacity = '0';
      onClose();
    } else {
      panel.current.style.translate = '';
      backdrop.current.style.opacity = '';
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div
        ref={backdrop}
        className={cx('absolute inset-0 bg-ink/35 transition-opacity duration-300 ease-out motion-reduce:transition-none', shown ? 'opacity-100' : 'opacity-0')}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={cx(
          'relative flex max-h-[86dvh] w-full max-w-lg flex-col rounded-t-[26px] bg-surface pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-10px_40px_-12px_rgb(13_16_22/0.35)]',
          'transition-[translate,scale,opacity] duration-[320ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
          'sm:max-h-[min(80dvh,720px)] sm:rounded-[26px] sm:pb-3 sm:shadow-[0_24px_64px_-20px_rgb(13_16_22/0.45)]',
          shown ? 'translate-y-0 sm:scale-100 sm:opacity-100' : 'translate-y-full sm:translate-y-3 sm:scale-95 sm:opacity-0',
        )}
      >
        <div
          className="relative shrink-0 touch-none select-none sm:touch-auto sm:select-auto"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div className="flex justify-center pt-2.5 pb-1 sm:hidden" aria-hidden="true">
            <span className="h-1.5 w-10 rounded-full bg-line-strong" />
          </div>
          <h2 id={`${id}-title`} className="px-12 pt-1.5 pb-3 text-center text-[17px] font-semibold sm:pt-5">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגירה"
            className="absolute end-3 top-3 hidden size-9 place-items-center rounded-full text-graphite transition-colors hover:bg-sunken hover:text-ink sm:grid"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
