/**
 * The signed-in person, and signing out. `compact` is the round avatar of the top bar; otherwise a
 * row with the name and email, for the bottom of the conversation list.
 */
import { ChevronsUpDown, LogOut, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx.js';
import { useAuth } from './AuthProvider.jsx';

function Avatar({ user, size = 32 }) {
  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
  return user.avatarUrl ? (
    <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span aria-hidden="true" className="grid shrink-0 place-items-center rounded-full bg-ink font-semibold text-on-ink" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {initial}
    </span>
  );
}

export function UserMenu({ compact = false }) {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const first = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    first.current?.focus();
    const close = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!user) return null;
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? `החשבון של ${user.name || user.email}` : undefined}
        className={cx(
          'flex items-center rounded-full text-start transition-colors',
          compact ? 'p-0.5 hover:ring-2 hover:ring-line-strong' : 'w-full gap-2.5 rounded-xl px-2 py-1.5 hover:bg-sunken',
        )}
      >
        <Avatar user={user} size={compact ? 30 : 32} />
        {!compact && (
          <>
            <span className="min-w-0 flex-1">
              {user.name && <span className="block truncate text-[14px] font-medium text-ink">{user.name}</span>}
              <span className={cx('block truncate', user.name ? 'text-[12.5px] text-mist' : 'text-[13.5px] text-ink')}>
                <bdi dir="ltr">{user.email}</bdi>
              </span>
            </span>
            <ChevronsUpDown size={15} className="shrink-0 text-mist" aria-hidden="true" />
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="החשבון"
          className={cx(
            'absolute z-40 w-64 overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-[0_18px_40px_-16px_rgb(13_16_22/0.4)]',
            compact ? 'end-0 top-full mt-2' : 'bottom-full start-0 mb-2',
          )}
        >
          <div className="px-3 pt-2 pb-2.5">
            <div className="truncate text-[13.5px] font-medium text-ink">
              <bdi dir="ltr">{user.email}</bdi>
            </div>
            <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-mist">
              {user.isAdmin && <ShieldCheck size={13} aria-hidden="true" />}
              {user.isAdmin ? 'מנהל מערכת' : 'חשבון אישי'}
            </span>
          </div>
          <div className="my-1 h-px bg-line" />
          <button
            ref={first}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              signOut();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[14px] text-ink hover:bg-sunken focus:bg-sunken focus:outline-none"
          >
            <LogOut size={16} aria-hidden="true" />
            התנתקות
          </button>
        </div>
      )}
    </div>
  );
}
