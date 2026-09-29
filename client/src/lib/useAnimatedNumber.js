import { useEffect, useRef, useState } from 'react';

/**
 * A number that glides to its new value (an ease-out over `duration` ms) instead of jumping: the credits
 * balance after a charge. With reduced motion, or a value that isn't a number, it just changes.
 */
export function useAnimatedNumber(value, { duration = 900 } = {}) {
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (typeof value !== 'number' || typeof from !== 'number' || from === value || reduced) {
      current.current = value;
      setShown(value);
      return undefined;
    }
    const began = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - began) / duration);
      current.current = Math.round(from + (value - from) * (1 - (1 - progress) ** 3));
      setShown(current.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return shown;
}
