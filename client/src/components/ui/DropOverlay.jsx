import { AnimatePresence, motion } from 'framer-motion';

/** Full-page target shown while files are dragged over the window. */
export function DropOverlay({ visible, icon: Icon, title, hint }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-paper/75 p-6 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            initial={{ scale: 0.94, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className="flex w-full max-w-xl flex-col items-center gap-3 rounded-[28px] border-2 border-dashed border-graphite bg-surface/90 px-8 py-14 text-center"
          >
            <Icon size={34} strokeWidth={1.6} aria-hidden="true" />
            <p className="font-wide text-2xl font-semibold tracking-tight">{title}</p>
            <p className="text-[15px] text-graphite">{hint}</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
