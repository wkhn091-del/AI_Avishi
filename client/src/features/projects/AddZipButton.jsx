import { motion } from 'framer-motion';
import { useRef, useState } from 'react';

/** The equalizer bars borrow the fingerprint's language colours. */
const BARS = [
  { color: '#2f74d0', rest: 0.55 },
  { color: '#e2b31f', rest: 0.95 },
  { color: '#8b5cf6', rest: 0.7 },
  { color: '#e4572e', rest: 1 },
  { color: '#2a9d8f', rest: 0.5 },
];

const barVariants = {
  rest: (i) => ({ scaleY: BARS[i].rest, transition: { type: 'spring', stiffness: 320, damping: 16 } }),
  // Hover: one quick bounce across the bars.
  hover: (i) => ({
    scaleY: [BARS[i].rest, 1, 0.3, BARS[i].rest],
    transition: { duration: 0.55, delay: i * 0.045, ease: 'easeInOut' },
  }),
  // Uploads in progress: the bars keep playing until the queue is empty.
  busy: (i) => ({
    scaleY: [0.3, 1, 0.45, 0.85, 0.3],
    transition: { duration: 1 + i * 0.13, repeat: Infinity, ease: 'easeInOut', delay: i * 0.07 },
  }),
};

/**
 * Primary action of the Projects section: opens a file picker for one or
 * more .zip files. A mini equalizer bounces on hover, keeps playing while
 * archives are being uploaded or analysed, and each click sends out a ring.
 */
export function AddZipButton({ onFiles, busy = false }) {
  const input = useRef(null);
  const [pulses, setPulses] = useState(0);

  return (
    <>
      <motion.button
        type="button"
        onClick={() => {
          setPulses((count) => count + 1);
          input.current?.click();
        }}
        initial="rest"
        animate={busy ? 'busy' : 'rest'}
        whileHover="hover"
        whileTap={{ scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="relative inline-flex h-10 shrink-0 items-center gap-3 rounded-full bg-ink pe-5 ps-4 text-[14.5px] font-semibold text-on-ink"
      >
        <span className="flex h-4 items-end gap-[3px]" aria-hidden="true">
          {BARS.map((bar, index) => (
            <motion.span
              key={bar.color}
              custom={index}
              variants={barVariants}
              className="block h-4 w-[3px] origin-bottom rounded-full"
              style={{ backgroundColor: bar.color }}
            />
          ))}
        </span>
        הוספת ZIP
        {pulses > 0 && (
          <motion.span
            key={pulses}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full border-2 border-ink"
            initial={{ opacity: 0.55, scale: 1 }}
            animate={{ opacity: 0, scale: 1.35 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          />
        )}
      </motion.button>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = ''; // allow picking the same file again
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
