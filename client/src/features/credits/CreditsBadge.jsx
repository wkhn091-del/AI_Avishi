import { useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx.js';
import { useAnimatedNumber } from '../../lib/useAnimatedNumber.js';
import { useCredits } from './CreditsProvider.jsx';

const LOW = 5;

/**
 * The balance in the top bar ("50 🪙"): amber when it runs low, red when it's gone. A charge counts the
 * number down, with the change ("−7") rising above it. A click explains it.
 */
export function CreditsBadge({ className }) {
  const credits = useCredits();
  const { balance, unlimited } = credits;
  const shown = useAnimatedNumber(unlimited ? null : balance, { duration: 1100 });
  const [delta, setDelta] = useState(null);
  const previous = useRef(balance);
  useEffect(() => {
    const before = previous.current;
    previous.current = balance;
    if (typeof before !== 'number' || typeof balance !== 'number' || before === balance) return undefined;
    setDelta({ amount: balance - before, key: Date.now() });
    const timer = setTimeout(() => setDelta(null), 1800);
    return () => clearTimeout(timer);
  }, [balance]);
  if (!credits.enabled) return null;
  const empty = !unlimited && balance === 0;
  const low = !unlimited && balance !== null && balance <= LOW;
  const label = unlimited ? 'קרדיטים ללא הגבלה' : balance === 1 ? 'קרדיט אחד' : `${balance ?? 0} קרדיטים`;
  return (
    <button
      type="button"
      onClick={credits.open}
      title={label}
      aria-label={`${label}: פרטים ושדרוג`}
      className={cx(
        'inline-flex h-9 shrink-0 items-center rounded-full border px-3 text-[14.5px] font-semibold tabular-nums transition-colors',
        empty ? 'border-danger/35 bg-danger/10 text-danger' : low ? 'border-warn/35 bg-warn/10 text-warn' : 'border-line bg-surface text-ink hover:bg-sunken',
        className,
      )}
    >
      <bdi dir="ltr" className="inline-flex items-center gap-1.5">
        <span className="relative">
          {unlimited ? '∞' : (shown ?? '…')}
          {delta && (
            <span key={delta.key} aria-hidden="true" className={cx('credit-delta pointer-events-none absolute -top-5 left-1/2 text-[12px] font-bold', delta.amount < 0 ? 'text-danger' : 'text-pass')}>
              {delta.amount < 0 ? `−${-delta.amount}` : `+${delta.amount}`}
            </span>
          )}
        </span>
        <span aria-hidden="true" className="text-[15px] leading-none">
          🪙
        </span>
      </bdi>
    </button>
  );
}
