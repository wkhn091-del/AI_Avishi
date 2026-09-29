import { WandSparkles } from 'lucide-react';
import { formatBytes, formatDateTime, formatRelative, isolate, pluralize } from '../../lib/format.js';
import { Fingerprint } from './Fingerprint.jsx';
import { colorFor, isLanguage, kindOf } from './projectVisuals.js';

const MAX_TAGS = 3;

/** Key for the fingerprint entrance: changes when the project is re-analysed. */
export const drawKeyOf = (project) => `${project.id}:${project.summary?.generatedAt ?? ''}`;

/**
 * One project in the grid. The whole card opens the details dialog (the title
 * button stretches over it), so there is exactly one tab stop per card.
 */
export function ProjectCard({ project, index = 0, onOpen }) {
  const kind = kindOf(project.kind);
  const KindIcon = kind.icon;
  const tags = project.tags ?? [];

  return (
    <article className="relative flex h-full flex-col rounded-[14px] border border-line bg-surface p-5 transition-colors hover:border-line-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink">
      <Fingerprint key={drawKeyOf(project)} bars={project.fingerprint} drawKey={drawKeyOf(project)} delay={Math.min(index, 12) * 55} />

      <p className="mt-4 flex items-center gap-2 text-[13px] text-graphite">
        <KindIcon size={14} aria-hidden="true" />
        {kind.label}
        {project.summary?.source === 'ai' && (
          <span className="ms-auto inline-flex items-center gap-1" title={`הסיכום נכתב על ידי ${isolate(project.summary.model)}`}>
            <WandSparkles size={13} aria-hidden="true" />
            <span className="sr-only">הסיכום נכתב על ידי AI</span>
          </span>
        )}
      </p>

      <h3 className="mt-1.5 font-semi-wide text-[19px] leading-snug font-semibold tracking-[-0.01em]" dir="auto">
        <button
          type="button"
          onClick={onOpen}
          className="text-start after:absolute after:inset-0 after:rounded-[14px] focus-visible:outline-none"
        >
          {project.title}
        </button>
      </h3>
      <p className="mt-2 line-clamp-3 text-[14.5px] leading-relaxed text-graphite" dir="auto">
        {project.description}
      </p>

      {tags.length > 0 && (
        <ul className="mt-4 flex flex-wrap justify-start gap-1.5" aria-label="תגיות">
          {tags.slice(0, MAX_TAGS).map((tag) => (
            <li key={tag} className="inline-flex items-center gap-1.5 rounded-md bg-sunken px-2 py-0.5 text-[12.5px] font-medium">
              {isLanguage(tag) && <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorFor(tag) }} aria-hidden="true" />}
              <bdi>{tag}</bdi>
            </li>
          ))}
          {tags.length > MAX_TAGS && <li className="px-1 py-0.5 text-[12.5px] text-mist">+{tags.length - MAX_TAGS}</li>}
        </ul>
      )}

      <p className="mt-auto flex items-center gap-4 pt-5 text-[13.5px] text-graphite tabular-nums">
        <span>{pluralize(project.stats.fileCount, 'קובץ אחד', 'קבצים')}</span>
        <span className="font-narrow">{formatBytes(project.stats.totalBytes)}</span>
        <time className="ms-auto" dateTime={project.createdAt} title={formatDateTime(project.createdAt)}>
          {formatRelative(project.createdAt)}
        </time>
      </p>
    </article>
  );
}
