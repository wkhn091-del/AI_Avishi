import { motion } from 'framer-motion';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { ConfirmButton } from '../../components/ui/ConfirmButton.jsx';
import { cx } from '../../lib/cx.js';
import { formatBytes, formatDateTime, formatRelative } from '../../lib/format.js';
import { extensionOf, fileTypeOf } from './fileTypes.js';
import { resourceUrl } from '../../lib/api.js';

const downloadUrl = (file) => resourceUrl(`/api/files/${file.id}/download`);
const cardFocus = 'has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ink';

/** Extension in expanded type on a tint of the file type's colour; compact = icon only (list rows). */
export function TypeGlyph({ extension, compact = false }) {
  const type = fileTypeOf(extension);
  const Icon = type.icon;
  const label = (extension ?? '').toUpperCase().slice(0, 4);
  const style = {
    backgroundColor: `color-mix(in oklab, ${type.color} 13%, var(--color-surface))`,
    color: `color-mix(in oklab, ${type.color} 80%, var(--color-ink))`,
  };
  if (compact) {
    return (
      <span className="grid size-full place-items-center" style={style}>
        <Icon size={18} aria-hidden="true" />
      </span>
    );
  }
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5" style={style}>
      {label ? (
        <span className="font-wide text-[26px] leading-none font-extrabold tracking-[-0.02em]">{label}</span>
      ) : (
        <Icon size={30} strokeWidth={1.5} aria-hidden="true" />
      )}
      <span className="text-[12px] font-medium opacity-80">{type.label}</span>
    </div>
  );
}

/** Image thumbnail from the server, or the type glyph. */
function Preview({ file, compact }) {
  const [failed, setFailed] = useState(false);
  if (file.previewable && !failed) {
    return (
      <img
        src={resourceUrl(`/api/files/${file.id}/preview`)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="size-full bg-sunken object-cover"
      />
    );
  }
  return <TypeGlyph extension={file.extension} compact={compact} />;
}

/** Grid view. The name is the download link and stretches over the tile. */
export function FileTile({ file, onDelete }) {
  return (
    <article
      title={`${file.originalName}\nנוסף ${formatDateTime(file.createdAt)}`}
      className={cx('relative flex h-full flex-col overflow-hidden rounded-[14px] border border-line bg-surface transition-colors hover:border-line-strong', cardFocus)}
    >
      <div className="aspect-[4/3] overflow-hidden border-b border-line">
        <Preview file={file} />
      </div>
      <div className="flex flex-1 flex-col px-3.5 pt-3 pb-2.5">
        <h3 className="line-clamp-2 text-[14px] leading-snug font-medium break-words">
          <a href={downloadUrl(file)} download className="after:absolute after:inset-0 focus-visible:outline-none">
            <bdi>{file.originalName}</bdi>
          </a>
        </h3>
        <div className="relative z-10 mt-auto flex items-center gap-2 pt-2">
          <span className="font-narrow text-[13px] text-graphite">{formatBytes(file.size)}</span>
          <ConfirmButton compact label="מחיקת הקובץ" confirmLabel="מחיקה" onConfirm={() => onDelete(file)} className="-me-1.5 ms-auto" />
        </div>
      </div>
    </article>
  );
}

export const LIST_COLUMNS = 'grid-cols-[40px_minmax(0,1fr)_auto] sm:grid-cols-[40px_minmax(0,1fr)_130px_76px_120px_auto]';

/** List view row. */
export function FileRow({ file, onDelete }) {
  const type = fileTypeOf(file.extension);
  return (
    <div className={cx('grid items-center gap-3 px-3 py-2 sm:gap-4 sm:px-4', LIST_COLUMNS)}>
      <span className="size-10 overflow-hidden rounded-lg">
        <Preview file={file} compact />
      </span>
      <span className="min-w-0">
        <a href={downloadUrl(file)} download className="block truncate text-[14.5px] font-medium hover:underline" title={file.originalName}>
          <bdi>{file.originalName}</bdi>
        </a>
        <span className="flex gap-3 text-[13px] text-graphite tabular-nums sm:hidden">
          <span>{formatBytes(file.size)}</span>
          <span>{formatRelative(file.createdAt)}</span>
        </span>
      </span>
      <span className="hidden truncate text-[13.5px] text-graphite sm:block">{type.label}</span>
      <span className="hidden text-end font-narrow text-[14px] sm:block">{formatBytes(file.size)}</span>
      <time className="hidden text-end text-[14px] text-graphite sm:block" dateTime={file.createdAt} title={formatDateTime(file.createdAt)}>
        {formatRelative(file.createdAt)}
      </time>
      <span className="flex items-center gap-0.5 justify-self-end">
        <a
          href={downloadUrl(file)}
          download
          aria-label={`הורדת ${file.originalName}`}
          title="הורדה"
          className="inline-flex size-8 items-center justify-center rounded-full text-graphite transition-colors hover:bg-sunken hover:text-ink"
        >
          <Download size={16} aria-hidden="true" />
        </a>
        <ConfirmButton compact label="מחיקת הקובץ" confirmLabel="מחיקה" onConfirm={() => onDelete(file)} />
      </span>
    </div>
  );
}

function Progress({ upload }) {
  const percent = Math.round(upload.progress * 100);
  return (
    <>
      <div className="h-1 overflow-hidden rounded-full bg-sunken">
        <motion.div className="h-full rounded-full bg-ink" initial={false} animate={{ width: `${percent}%` }} transition={{ ease: 'easeOut', duration: 0.25 }} />
      </div>
      <p className="mt-1.5 text-[13px] text-graphite tabular-nums" role="status">
        {upload.state === 'queued' ? `בתור, ${formatBytes(upload.size)}` : `${percent}% מתוך ${formatBytes(upload.size)}`}
      </p>
    </>
  );
}

/** Grid placeholder for a file being uploaded. */
export function UploadTile({ upload }) {
  return (
    <article aria-busy="true" className="flex h-full flex-col overflow-hidden rounded-[14px] border border-dashed border-line-strong bg-surface/60">
      <div className="aspect-[4/3] overflow-hidden border-b border-dashed border-line-strong opacity-60">
        <TypeGlyph extension={extensionOf(upload.name)} />
      </div>
      <div className="px-3.5 pt-3 pb-3">
        <p className="mb-2.5 line-clamp-2 text-[14px] leading-snug font-medium break-words">
          <bdi>{upload.name}</bdi>
        </p>
        <Progress upload={upload} />
      </div>
    </article>
  );
}

/** List placeholder for a file being uploaded. */
export function UploadRow({ upload }) {
  return (
    <div className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3 px-3 py-2 sm:gap-4 sm:px-4" aria-busy="true">
      <span className="size-10 overflow-hidden rounded-lg opacity-60">
        <TypeGlyph extension={extensionOf(upload.name)} compact />
      </span>
      <span className="min-w-0 max-w-md">
        <span className="mb-1.5 block truncate text-[14.5px] font-medium">
          <bdi>{upload.name}</bdi>
        </span>
        <Progress upload={upload} />
      </span>
    </div>
  );
}
