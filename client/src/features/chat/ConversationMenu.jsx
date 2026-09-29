import { MoreHorizontal, Pencil, Share2, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx.js';
import { isolate } from '../../lib/format.js';

const ACTIONS = [
  { id: 'share', label: 'שיתוף', icon: Share2 },
  { id: 'rename', label: 'שינוי שם', icon: Pencil },
  { id: 'delete', label: 'מחיקה', icon: Trash2, danger: true },
];
const GAP = 6; // px between the button and the menu
const MARGIN = 8; // px the menu keeps from the window's edges

/**
 * A conversation's three-dot button and its menu: Share, Rename and Delete in a
 * small popover beside the button, kept inside the window (near the bottom it
 * opens upwards). Arrow keys, Home and End move between the actions; Escape or
 * Tab closes it and returns to the button. A click elsewhere, a scroll or a
 * resize also closes it. `busy` disables Delete while the conversation is
 * being answered.
 */
export function ConversationMenu({ title, onAction, busy, className }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const button = useRef(null);
  const menu = useRef(null);
  const menuId = useId();
  const name = `פעולות לשיחה ${isolate(title)}`;

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return undefined;
    }
    const anchor = button.current.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = menu.current;
    const rtl = getComputedStyle(button.current).direction === 'rtl';
    const left = Math.min(Math.max(MARGIN, rtl ? anchor.left : anchor.right - width), window.innerWidth - width - MARGIN);
    const below = anchor.bottom + GAP + height <= window.innerHeight - MARGIN;
    setPlace({
      left,
      top: below ? anchor.bottom + GAP : Math.max(MARGIN, anchor.top - GAP - height),
      origin: `${rtl ? 'left' : 'right'} ${below ? 'top' : 'bottom'}`,
    });
    const close = () => setOpen(false);
    const outside = (event) => {
      if (!menu.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open]);

  // Once placed, the first action takes focus, so the keyboard lands in the menu.
  useEffect(() => {
    if (place) menu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [place]);

  const dismiss = () => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event) => {
    const items = [...menu.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
    if (target !== undefined) {
      event.preventDefault();
      items[(target + items.length) % items.length]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-open={open || undefined}
        onClick={() => setOpen((value) => !value)}
        className={cx('grid size-8 shrink-0 place-items-center rounded-full text-graphite transition-colors hover:bg-sunken hover:text-ink data-open:bg-sunken data-open:text-ink', className)}
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={name}
            onKeyDown={onKeyDown}
            style={{ top: place?.top ?? 0, left: place?.left ?? 0, visibility: place ? 'visible' : 'hidden', transformOrigin: place?.origin }}
            className="menu-pop fixed z-[60] w-52 rounded-2xl border border-line bg-surface p-1.5 shadow-[0_14px_36px_-10px_rgb(13_16_22/0.32),0_2px_6px_rgb(13_16_22/0.08)] dark:shadow-[0_14px_36px_-10px_rgb(0_0_0/0.7)]"
          >
            {ACTIONS.map((action) => {
              const disabled = action.id === 'delete' && busy;
              return (
                <Fragment key={action.id}>
                  {action.danger && <div role="separator" className="mx-2 my-1 h-px bg-line" />}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={disabled}
                    onClick={() => {
                      dismiss();
                      onAction(action.id);
                    }}
                    className={cx(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start text-[14.5px] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      action.danger ? 'text-danger hover:bg-danger/10 focus-visible:bg-danger/10' : 'text-ink hover:bg-sunken focus-visible:bg-sunken',
                    )}
                  >
                    <action.icon size={16} className="shrink-0" aria-hidden="true" />
                    <span className="min-w-0">
                      {action.label}
                      {disabled && <span className="block text-[12px] text-graphite">אפשר למחוק כשהתשובה תסתיים</span>}
                    </span>
                  </button>
                </Fragment>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
