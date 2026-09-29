import { Check, Copy, Info, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../../components/ui/Button.jsx';
import { ConfirmButton } from '../../components/ui/ConfirmButton.jsx';
import { displayUrl, formatDateTime, formatRelative } from '../../lib/format.js';

/**
 * A saved link: preview image (or a plate with the site's icon and domain),
 * title, description, and why the preview is missing when it is.
 * The title link stretches over the card; the action buttons sit above it.
 */
export function LinkCard({ link, highlightKey, onCopy, onRefresh, onDelete }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const card = useRef(null);

  // A fresh image URL after "Refresh preview" deserves a fresh attempt.
  useEffect(() => setImageFailed(false), [link.image]);
  useEffect(() => setIconFailed(false), [link.favicon]);

  useEffect(() => {
    if (highlightKey) card.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightKey]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1_600);
    return () => clearTimeout(timer);
  }, [copied]);

  const showImage = link.image && !imageFailed;
  const favicon = link.favicon && !iconFailed ? link.favicon : null;

  return (
    <article
      ref={card}
      className="relative flex h-full flex-col overflow-hidden rounded-[14px] border border-line bg-surface transition-colors hover:border-line-strong has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ink"
    >
      {highlightKey && (
        // CSS animation, not framer-motion: grid items rendered under AnimatePresence initial={false}
        // would skip a motion "initial" state and never show the ring.
        <span key={highlightKey} aria-hidden="true" className="ring-flash pointer-events-none absolute inset-0 z-20 rounded-[14px] ring-2 ring-ink ring-inset" />
      )}

      <div className="relative aspect-[1.91/1] overflow-hidden border-b border-line bg-sunken">
        {showImage ? (
          <img
            src={link.image}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full flex-col items-start justify-end gap-3 p-5">
            <SiteIcon src={favicon} domain={link.domain} size="size-10" onError={() => setIconFailed(true)} />
            <span className="max-w-full truncate font-wide text-[22px] font-bold tracking-[-0.02em]"><bdi>{link.domain}</bdi></span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <p className="flex min-w-0 items-center gap-2 text-[13px] text-graphite">
          {showImage && <SiteIcon src={favicon} domain={link.domain} size="size-4" onError={() => setIconFailed(true)} />}
          <bdi className="truncate">{link.siteName ?? link.domain}</bdi>
        </p>
        <h3 className="mt-1.5 line-clamp-2 text-[16px] leading-snug font-semibold" dir="auto">
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-words after:absolute after:inset-0 focus-visible:outline-none"
          >
            {link.title ?? displayUrl(link.url)}
          </a>
        </h3>
        {link.description && (
          <p className="mt-1.5 line-clamp-2 text-[14px] leading-relaxed text-graphite" dir="auto">
            {link.description}
          </p>
        )}
        {link.metadataStatus !== 'ok' && link.metadataNote && (
          <p className="mt-2 flex gap-1.5 text-[13px] leading-snug text-graphite">
            <Info size={14} className="mt-px shrink-0" aria-hidden="true" />
            {link.metadataNote}
          </p>
        )}

        <div className="relative z-10 mt-auto flex items-center gap-1 pt-4">
          <time className="text-[13px] text-mist" dateTime={link.createdAt} title={formatDateTime(link.createdAt)}>
            {formatRelative(link.createdAt)}
          </time>
          <div className="ms-auto flex items-center gap-0.5">
            <IconButton
              label={copied ? 'הועתק' : 'העתקת הקישור'}
              onClick={async () => {
                if (await onCopy(link.url)) setCopied(true);
              }}
            >
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            </IconButton>
            <IconButton
              label="רענון התצוגה המקדימה"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                await onRefresh(link.id);
                setRefreshing(false);
              }}
            >
              {refreshing ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            </IconButton>
            <ConfirmButton compact label="מחיקת הקישור" confirmLabel="מחיקה" onConfirm={() => onDelete(link.id)} />
          </div>
        </div>
      </div>
    </article>
  );
}

/** The site's icon, or its first letter when there is none. */
function SiteIcon({ src, domain, size, onError }) {
  const plate = size === 'size-10';
  if (src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onError={onError}
        className={plate ? 'size-10 rounded-xl bg-surface object-contain p-1.5' : 'size-4 shrink-0 rounded-sm object-contain'}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={
        plate
          ? 'grid size-10 place-items-center rounded-xl bg-surface font-wide text-lg font-bold uppercase'
          : 'grid size-4 shrink-0 place-items-center rounded-sm bg-sunken text-[10px] font-bold uppercase'
      }
    >
      {domain.replace(/^www\./, '').charAt(0)}
    </span>
  );
}

/** Placeholder while the server fetches the page. */
export function SavingLinkCard({ url }) {
  return (
    <article aria-busy="true" className="flex h-full flex-col overflow-hidden rounded-[14px] border border-dashed border-line-strong bg-surface/60">
      <div className="aspect-[1.91/1] animate-pulse border-b border-dashed border-line-strong bg-sunken" />
      <div className="p-4">
        <p className="flex items-center gap-2 text-[13px] text-graphite" role="status">
          <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
          טעינת תצוגה מקדימה…
        </p>
        <p className="mt-1.5 truncate text-[16px] font-semibold">
          <bdi>{displayUrl(url)}</bdi>
        </p>
      </div>
    </article>
  );
}
