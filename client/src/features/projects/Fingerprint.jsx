import { useEffect, useState } from 'react';
import { cx } from '../../lib/cx.js';
import { colorFor } from './projectVisuals.js';

const BAR = 3;
const GAP = 2;
const STEP = BAR + GAP;
const MAX_BARS = 64;
const WIDTH = MAX_BARS * STEP - GAP;

/** drawKeys that have already played their entrance, so tab switches don't replay it. */
const drawn = new Set();

/**
 * A project's codebase fingerprint — Stash's signature element.
 * One bar per slice of files in path order: colour = dominant language (or
 * docs, data, assets), height = log-scaled size. Bars keep a fixed width, so a
 * small project draws a short strip; its length is part of the information.
 *
 * On a right-to-left page the strip is mirrored (index.css) so it reads from the right.
 *
 * The bars rise from the baseline once per `drawKey` (first load, and again
 * after a re-analysis produces a new key). `replay` always plays it.
 *
 * @param {{ bars: Array<[string, number]>, drawKey?: string, replay?: boolean, height?: number, delay?: number, className?: string }} props
 */
export function Fingerprint({ bars, drawKey, replay = false, height = 40, delay = 0, className }) {
  const [draw] = useState(() => replay || (drawKey ? !drawn.has(drawKey) : false));

  useEffect(() => {
    if (drawKey) drawn.add(drawKey);
  }, [drawKey]);

  const top = height - 3;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      className={cx('fp-svg block w-full overflow-visible', draw && 'fp-draw', className)}
      style={{ height, '--fp-delay': `${delay}ms` }}
      aria-hidden="true"
    >
      {bars.map(([category, level], index) => {
        const barHeight = Math.max(2, (level / 10) * top);
        return (
          <rect
            key={index}
            className="fp-bar"
            x={index * STEP}
            y={top - barHeight}
            width={BAR}
            height={barHeight}
            rx={1}
            style={{ fill: colorFor(category), '--i': index }}
          />
        );
      })}
      <Baseline height={height} />
    </svg>
  );
}

/** Placeholder bars for work in progress: they pulse while `active` (uploading or analysing). */
export function ListeningBars({ active = false, failed = false, height = 40, count = 40 }) {
  const top = height - 3;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      className={cx('fp-svg block w-full', active && 'fp-listen')}
      style={{ height }}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => {
        const barHeight = ((3 + ((index * 7) % 6)) / 10) * top;
        return (
          <rect
            key={index}
            className="fp-bar"
            x={index * STEP}
            y={top - barHeight}
            width={BAR}
            height={barHeight}
            rx={1}
            style={{ fill: failed ? 'var(--color-danger)' : 'var(--fp-other)', opacity: failed ? 0.45 : 1, '--i': index }}
          />
        );
      })}
      <Baseline height={height} />
    </svg>
  );
}

function Baseline({ height }) {
  return (
    <line
      x1="0"
      x2={WIDTH}
      y1={height - 0.5}
      y2={height - 0.5}
      stroke="var(--color-line-strong)"
      strokeWidth="1"
      vectorEffect="non-scaling-stroke"
    />
  );
}
