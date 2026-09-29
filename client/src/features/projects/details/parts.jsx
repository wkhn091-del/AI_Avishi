import { CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/ui/Button.jsx';
import { cx } from '../../../lib/cx.js';

/** Centred spinner with a label while tab content loads. */
export function Loading({ label = 'טוען…' }) {
  return (
    <div className="grid h-full min-h-40 place-items-center p-6" role="status">
      <span className="flex items-center gap-2 text-[14px] text-graphite">
        <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}

/**
 * Centred message with an icon and optional actions: errors, empty states, files without a code view.
 * `detail` is a provider's own (English) text, shown on its own left-to-right line.
 */
export function Notice({ icon: Icon = CircleAlert, title, tone = 'neutral', actions, detail, children }) {
  return (
    <div className="grid h-full min-h-48 place-items-center p-6">
      <div className="max-w-md text-center">
        <span className={cx('mx-auto grid size-11 place-items-center rounded-2xl bg-sunken', tone === 'error' ? 'text-danger' : 'text-graphite')}>
          <Icon size={20} aria-hidden="true" />
        </span>
        {title && <h3 className="mt-4 text-[16px] font-semibold">{title}</h3>}
        {children && (
          <p className="bidi-plain mt-1.5 text-[14.5px] leading-relaxed text-graphite" dir="auto">
            {children}
          </p>
        )}
        {detail && (
          <TechnicalDetail center className="mt-2">
            {detail}
          </TechnicalDetail>
        )}
        {actions && <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * A provider's or tool's own message (usually English), kept apart from the
 * Hebrew text so the two never share a sentence: left-to-right and monospace.
 */
export function TechnicalDetail({ center = false, className, children }) {
  return (
    <p dir="ltr" className={cx('font-mono text-[12.5px] leading-relaxed break-words text-mist', center ? 'text-center' : 'text-left', className)}>
      {children}
    </p>
  );
}

export function RetryButton({ onClick }) {
  return (
    <Button size="sm" icon={RefreshCw} onClick={onClick}>
      ניסיון נוסף
    </Button>
  );
}
