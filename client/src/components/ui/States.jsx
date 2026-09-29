import { motion } from 'framer-motion';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { Button } from './Button.jsx';

/** First-run state: says what the section is for and offers the action that fills it. */
export function EmptyState({ art, title, children, action, footnote }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-[18px] border border-dashed border-line-strong px-6 py-12 sm:px-12 sm:py-16"
    >
      <div className="max-w-xl">
        {art}
        <h2 className="mt-6 font-wide text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-graphite">{children}</p>
        {action && (
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            {action}
            {footnote && <span className="text-[14px] text-mist">{footnote}</span>}
          </div>
        )}
      </div>
    </motion.div>
  );
}

/** A section's data failed to load. */
export function ErrorState({ message, onRetry }) {
  return (
    <div role="alert" className="rounded-[18px] border border-line bg-surface px-6 py-10 sm:px-10">
      <CircleAlert size={22} className="text-danger" aria-hidden="true" />
      <h2 className="mt-4 text-lg font-semibold">טעינת האזור נכשלה</h2>
      <p className="bidi-plain mt-1 max-w-xl text-[15px] leading-relaxed text-graphite" dir="auto">
        {message}
      </p>
      <Button className="mt-6" icon={RefreshCw} onClick={onRetry}>
        ניסיון נוסף
      </Button>
    </div>
  );
}

/** A search matched nothing. */
export function NoResults({ query, onClear }) {
  return (
    <div className="py-16">
      <p className="text-[15px] text-graphite">
        אין תוצאות עבור "<bdi className="text-ink">{query}</bdi>".
      </p>
      <Button variant="ghost" size="sm" className="mt-3 -ms-3" onClick={onClear}>
        ניקוי החיפוש
      </Button>
    </div>
  );
}
