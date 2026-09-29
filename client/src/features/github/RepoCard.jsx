import { Archive, FolderGit2, GitFork, Lock, Star } from 'lucide-react';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { Fingerprint, ListeningBars } from '../projects/Fingerprint.jsx';
import { drawKeyOf } from '../projects/ProjectCard.jsx';
import { colorFor, isLanguage, kindOf } from '../projects/projectVisuals.js';

const MAX_TAGS = 3;

function Badge({ icon: Icon, label }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[12px] text-graphite">
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * A GitHub repository: its fingerprint and Hebrew summary once analysed,
 * GitHub's own description until then, and GitHub's figures underneath.
 */
export function RepoCard({ repo, index = 0, analysis, onOpen }) {
  const meta = repo.github;
  const running = analysis?.status === 'running';
  const kind = repo.analyzed ? kindOf(repo.kind) : null;
  const KindIcon = kind?.icon ?? FolderGit2;
  const tags = repo.tags ?? [];

  return (
    <article className="relative flex h-full flex-col rounded-[14px] border border-line bg-surface p-5 transition-colors hover:border-line-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink">
      {repo.analyzed ? (
        <Fingerprint key={drawKeyOf(repo)} bars={repo.fingerprint} drawKey={drawKeyOf(repo)} delay={Math.min(index, 12) * 55} />
      ) : (
        <ListeningBars active={running} count={32} />
      )}

      <p className="mt-4 flex min-w-0 items-center gap-2 text-[13px] text-graphite">
        <KindIcon size={14} className="shrink-0" aria-hidden="true" />
        <span className="shrink-0">{kind ? kind.label : 'מאגר'}</span>
        <bdi className="min-w-0 truncate text-mist">{meta.fullName}</bdi>
        {meta.private && <Badge icon={Lock} label="פרטי" />}
        {meta.fork && <Badge icon={GitFork} label="פורק" />}
        {meta.archived && <Badge icon={Archive} label="בארכיון" />}
      </p>

      <h3 className="mt-1.5 font-semi-wide text-[19px] leading-snug font-semibold tracking-[-0.01em]" dir="auto">
        <button type="button" onClick={onOpen} className="text-start after:absolute after:inset-0 after:rounded-[14px] focus-visible:outline-none">
          {repo.title}
        </button>
      </h3>
      <p className="mt-2 line-clamp-3 text-[14.5px] leading-relaxed text-graphite" dir="auto">
        {repo.description || 'אין תיאור.'}
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
        {meta.language && (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: colorFor(meta.language) }} aria-hidden="true" />
            <bdi>{meta.language}</bdi>
          </span>
        )}
        <span className="inline-flex items-center gap-1" title="כוכבים">
          <Star size={13} aria-hidden="true" />
          <span className="font-narrow">{meta.stars.toLocaleString('he-IL')}</span>
        </span>
        {!repo.analyzed && <span className="text-mist">{running ? 'בניתוח…' : 'טרם נותח'}</span>}
        <time className="ms-auto" dateTime={meta.pushedAt} title={formatDateTime(meta.pushedAt)}>
          {formatRelative(meta.pushedAt)}
        </time>
      </p>
    </article>
  );
}
