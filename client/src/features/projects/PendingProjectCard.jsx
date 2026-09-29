import { motion } from 'framer-motion';
import { CircleAlert, Clock, LoaderCircle, RefreshCw, Upload, X } from 'lucide-react';
import { Button } from '../../components/ui/Button.jsx';
import { formatBytes } from '../../lib/format.js';
import { ListeningBars } from './Fingerprint.jsx';

const STATES = {
  queued: { icon: Clock, label: () => 'בתור' },
  uploading: { icon: Upload, label: (item) => `בהעלאה ${Math.round(item.progress * 100)}%` },
  analyzing: { icon: LoaderCircle, label: () => 'בניתוח…', spin: true },
  error: { icon: CircleAlert, label: () => 'הוספת הארכיון נכשלה' },
};

/** An archive on its way in. Shows only what is really happening — no invented stages. */
export function PendingProjectCard({ item, onRetry, onDismiss }) {
  const state = STATES[item.state];
  const Icon = state.icon;
  const failed = item.state === 'error';

  return (
    <article
      aria-busy={!failed}
      className="flex h-full flex-col rounded-[14px] border border-dashed border-line-strong bg-surface/60 p-5"
    >
      <ListeningBars active={item.state === 'uploading' || item.state === 'analyzing'} failed={failed} />

      <p className={`mt-4 flex items-center gap-2 text-[13px] ${failed ? 'text-danger' : 'text-graphite'}`} role="status">
        <Icon size={14} className={state.spin ? 'animate-spin' : undefined} aria-hidden="true" />
        {state.label(item)}
      </p>
      <h3 className="mt-1.5 font-semi-wide text-[19px] leading-snug font-semibold break-words">
        <bdi>{item.name}</bdi>
      </h3>

      {failed ? (
        <>
          <p className="bidi-plain mt-2 text-[14.5px] leading-relaxed text-graphite" dir="auto">
            {item.error}
          </p>
          <div className="mt-auto flex gap-2 pt-5">
            <Button size="sm" icon={RefreshCw} onClick={onRetry}>
              ניסיון נוסף
            </Button>
            <Button size="sm" variant="ghost" icon={X} onClick={onDismiss}>
              הסרה
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-auto pt-6">
          <div className="h-1 overflow-hidden rounded-full bg-sunken">
            <motion.div
              className="h-full rounded-full bg-ink"
              initial={false}
              animate={{ width: `${Math.round(item.progress * 100)}%` }}
              transition={{ ease: 'easeOut', duration: 0.25 }}
            />
          </div>
          <p className="mt-2 flex font-narrow text-[13.5px] text-graphite">
            <span>{formatBytes(item.size)}</span>
            {item.state === 'queued' && (
              <button type="button" onClick={onDismiss} className="ms-auto font-sans text-[13px] hover:text-ink">
                ביטול
              </button>
            )}
          </p>
        </div>
      )}
    </article>
  );
}
