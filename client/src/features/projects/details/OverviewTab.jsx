import { Check, FileCode2, FileText, Folder, RefreshCw, ScanSearch, WandSparkles, X } from 'lucide-react';
import { Fragment, useState } from 'react';
import { TechnicalDetail } from './parts.jsx';
import { Button } from '../../../components/ui/Button.jsx';
import { formatBytes, formatDateTime, formatRelative, isolate, pluralize } from '../../../lib/format.js';
import { Fingerprint, ListeningBars } from '../Fingerprint.jsx';
import { drawKeyOf } from '../ProjectCard.jsx';
import { CATEGORY_LABELS, colorFor, isLanguage } from '../projectVisuals.js';
import { EditForm } from './EditForm.jsx';

/** The project at a glance: fingerprint, summary, figures, entry points, contents and README. */
export function OverviewTab({ project: p, busy, editing, draft, setDraft, formError, onSubmit, onAnalyze }) {
  if (p.source === 'github' && !p.analyzed) return <RepoAnalysisPending project={p} onAnalyze={onAnalyze} />;
  const tagSet = new Set((p.tags ?? []).map((tag) => tag.toLowerCase()));
  // Detected technologies the (editable) tags don't mention, e.g. after tags were removed.
  const alsoDetected = (p.techStack ?? []).filter((tech) => !tagSet.has(tech.toLowerCase()));

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="px-5 pt-6 pb-7 sm:px-8">
        <div className="max-w-4xl">
          {busy === 'reanalyze' ? (
            <ListeningBars active height={56} count={64} />
          ) : (
            <Fingerprint key={drawKeyOf(p)} bars={p.fingerprint} replay height={56} />
          )}
          <Legend project={p} />

          {editing ? (
            <>
              <h3 className="mt-7 font-wide text-[20px] font-bold tracking-[-0.01em]">עריכת פרטים</h3>
              <EditForm draft={draft} setDraft={setDraft} error={formError} onSubmit={onSubmit} />
            </>
          ) : (
            <>
              <p className="mt-6 max-w-[70ch] text-[15.5px] leading-relaxed text-graphite" dir="auto">
                {p.description}
              </p>
              {p.tags?.length > 0 && (
                <ul className="mt-4 flex flex-wrap justify-start gap-1.5" aria-label="תגיות">
                  {p.tags.map((tag) => (
                    <Chip key={tag} label={tag} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      <div className="border-t border-line px-5 py-7 sm:px-8">
        <div className="max-w-5xl space-y-9">
          <Facts project={p} />
          {p.source === 'github' && <RepoDetails meta={p.github} />}
          {alsoDetected.length > 0 && (
            <Block title="זוהו גם">
              <ul className="flex flex-wrap justify-start gap-1.5">
                {alsoDetected.map((tech) => (
                  <Chip key={tech} label={tech} />
                ))}
              </ul>
            </Block>
          )}
          <div className="grid gap-8 sm:grid-cols-2">
            <Block title="נקודות כניסה">
              <PathList paths={p.entryPoints ?? []} empty="לא זוהו" />
            </Block>
            <Block title="נקראו לצורך הסיכום">
              <PathList paths={p.keyFiles ?? []} empty="לא נמצאו README או קובצי תצורה" />
            </Block>
          </div>
          {p.topLevel?.length > 0 && (
            <Block title="תוכן הארכיון">
              <Outline items={p.topLevel} />
            </Block>
          )}
          {p.readmeExcerpt && (
            <Block title="README">
              <pre
                className="max-h-80 overflow-auto rounded-xl bg-sunken px-5 py-4 font-sans text-[14px] leading-relaxed break-words whitespace-pre-wrap"
                dir="auto"
              >
                {p.readmeExcerpt}
              </pre>
            </Block>
          )}
          <SummarySource project={p} />
        </div>
      </div>
    </div>
  );
}

function Chip({ label }) {
  return (
    <li className="inline-flex items-center gap-1.5 rounded-md bg-sunken px-2.5 py-1 text-[13px] font-medium">
      {isLanguage(label) && <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorFor(label) }} aria-hidden="true" />}
      <bdi>{label}</bdi>
    </li>
  );
}

function Block({ title, children }) {
  return (
    <section>
      <h3 className="mb-3 text-[14px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Colour key for the fingerprint: languages with their share, then non-code categories. */
function Legend({ project }) {
  const neutrals = [...new Set(project.fingerprint.map(([category]) => category))].filter((category) => CATEGORY_LABELS[category]);
  if (!project.languages.length && !neutrals.length) return null;
  const swatch = (color) => <span className="size-2 rounded-[2px]" style={{ backgroundColor: color }} aria-hidden="true" />;
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-graphite" aria-label="שפות">
      {project.languages.map((language) => (
        <li key={language.name} className="inline-flex items-center gap-1.5">
          {swatch(colorFor(language.name))}
          <bdi>{language.name}</bdi>
          <span className="font-narrow text-ink">{language.share}%</span>
        </li>
      ))}
      {neutrals.map((category) => (
        <li key={category} className="inline-flex items-center gap-1.5">
          {swatch(colorFor(category))}
          {CATEGORY_LABELS[category]}
        </li>
      ))}
    </ul>
  );
}

function Facts({ project }) {
  const { stats } = project;
  const github = project.source === 'github' ? project.github : null;
  const items = github
    ? [
        ['קבצים', stats.fileCount.toLocaleString('he-IL')],
        ['גודל', formatBytes(stats.totalBytes)],
        ['כוכבים', github.stars.toLocaleString('he-IL')],
        ['עדכון אחרון', formatRelative(github.pushedAt), formatDateTime(github.pushedAt), true],
      ]
    : [
        ['קבצים', stats.fileCount.toLocaleString('he-IL')],
        ['גודל לא דחוס', formatBytes(stats.totalBytes)],
        ['גודל ה-ZIP', formatBytes(project.archive.size)],
        ['נוסף', formatRelative(project.createdAt), formatDateTime(project.createdAt), true],
      ];
  return (
    <div>
      <dl className="grid grid-cols-2 gap-y-6 rounded-xl border border-line px-2 py-5 sm:grid-cols-4">
        {items.map(([label, value, title, isText]) => (
          <div key={label} className="flex min-w-0 flex-col items-center gap-2 px-2 text-center">
            <dt className="text-[13px] text-graphite">{label}</dt>
            <dd className={`text-[22px] leading-none font-semibold ${isText ? '' : 'font-narrow'}`} title={title}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {stats.ignoredEntries > 0 && (
        <p className="mt-4 text-[13.5px] text-graphite">
          דילגנו על {pluralize(stats.ignoredEntries, 'קובץ אחד', 'קבצים')} בתיקיות של תלויות, בנייה ומערכת, כמו{' '}
          <bdi>node_modules</bdi>.
        </p>
      )}
      {stats.truncated && <p className="mt-1 text-[13.5px] text-graphite">ארכיון גדול מאוד: נקראו רק 50,000 הרשומות הראשונות.</p>}
    </div>
  );
}

const website = (value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`);
const linkClass = 'font-medium underline decoration-line-strong underline-offset-4 hover:decoration-current';

function RepoDetails({ meta }) {
  const rows = [
    ['מאגר', <a key="repo" href={meta.htmlUrl} target="_blank" rel="noopener noreferrer" className={linkClass}><bdi dir="ltr">{meta.fullName}</bdi></a>],
    meta.homepage && ['אתר', <a key="site" href={website(meta.homepage)} target="_blank" rel="noopener noreferrer" className={linkClass}><bdi dir="ltr">{meta.homepage}</bdi></a>],
    ['ענף ברירת מחדל', <bdi key="branch" dir="ltr">{meta.defaultBranch}</bdi>],
    ['נראות', meta.private ? 'פרטי' : 'ציבורי'],
    meta.fork && ['סוג', 'פורק של מאגר אחר'],
    meta.archived && ['מצב', 'בארכיון (לקריאה בלבד)'],
  ].filter(Boolean);
  return (
    <Block title="פרטי המאגר">
      <dl className="grid gap-x-8 gap-y-2 text-[14.5px] sm:grid-cols-[max-content_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-graphite">{label}</dt>
            <dd className="min-w-0 truncate">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </Block>
  );
}

/** A GitHub repository before its first analysis (it starts when the dialog opens). */
function RepoAnalysisPending({ project, onAnalyze }) {
  const failed = project.analysisState?.status === 'error';
  return (
    <div className="h-full overflow-y-auto overscroll-contain px-5 py-8 sm:px-8">
      <div className="max-w-3xl">
        <ListeningBars active={!failed} failed={failed} height={56} count={64} />
        {failed ? (
          <>
            <h3 className="mt-7 text-[17px] font-semibold">ניתוח המאגר נכשל</h3>
            <p className="bidi-plain mt-1.5 text-[15px] leading-relaxed text-danger" dir="auto">
              {project.analysisState.error}
            </p>
            {onAnalyze && (
              <Button className="mt-5" icon={RefreshCw} onClick={onAnalyze}>
                ניסיון נוסף
              </Button>
            )}
          </>
        ) : (
          <>
            <h3 className="mt-7 text-[17px] font-semibold">מנתחים את המאגר…</h3>
            <p className="mt-1.5 text-[15px] leading-relaxed text-graphite">
              Stash קורא מ-GitHub את ה-README ואת קובצי התצורה וכותב סיכום בעברית. בינתיים אפשר כבר לעיין בקבצים ובתצוגה המקדימה.
            </p>
          </>
        )}
        {project.description && (
          <p className="mt-6 text-[14.5px] leading-relaxed text-graphite">
            התיאור ב-GitHub:{' '}
            <span className="text-ink" dir="auto">
              {project.description}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

function PathList({ paths, empty }) {
  if (!paths.length) return <p className="text-[14px] text-mist">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {paths.map((path) => (
        <li key={path} className="flex items-start gap-2 font-narrow text-[14.5px] break-all">
          <FileCode2 size={14} className="mt-1 shrink-0 text-mist" aria-hidden="true" />
          <bdi dir="ltr">{path}</bdi>
        </li>
      ))}
    </ul>
  );
}

/** Top-level folders and files with their weight; the largest bar is the largest item. */
function Outline({ items }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, 10);
  const largest = Math.max(1, ...items.map((item) => item.bytes));
  return (
    <>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {visible.map((item) => (
          <li key={`${item.type}:${item.name}`} className="grid grid-cols-[minmax(0,1fr)_auto_56px_64px] items-center gap-4 px-4 py-2.5">
            <span className="flex min-w-0 items-center gap-2.5 text-[14.5px]">
              {item.type === 'dir' ? (
                <Folder size={15} className="shrink-0 text-graphite" aria-hidden="true" />
              ) : (
                <FileText size={15} className="shrink-0 text-mist" aria-hidden="true" />
              )}
              <bdi dir="ltr" className="truncate">
                {item.name}
                {item.type === 'dir' && '/'}
              </bdi>
            </span>
            <span className="text-[13.5px] text-graphite">{item.type === 'dir' ? pluralize(item.fileCount, 'קובץ אחד', 'קבצים') : ''}</span>
            <span className="h-1 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
              <span className="block h-full rounded-full bg-graphite" style={{ width: `${Math.max(3, (item.bytes / largest) * 100)}%` }} />
            </span>
            <span className="text-end font-narrow text-[13.5px]">{formatBytes(item.bytes)}</span>
          </li>
        ))}
      </ul>
      {items.length > 10 && (
        <Button variant="ghost" size="sm" className="mt-2 -ms-3" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'הצגת פחות' : `הצגת כל ${items.length}`}
        </Button>
      )}
    </>
  );
}

function SummarySource({ project }) {
  const { summary } = project;
  const byAi = summary?.source === 'ai';
  const Icon = byAi ? WandSparkles : ScanSearch;
  return (
    <div className="flex gap-2.5 rounded-xl border border-line px-4 py-3 text-[13.5px] leading-relaxed text-graphite">
      <Icon size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p>
          {byAi && summary.ensemble
            ? `הכותרת והתיאור נכתבו במקביל על ידי ${summary.ensemble.members.filter((member) => member.ok).length} מודלים${summary.ensemble.synthesizer ? ` ואוחדו על ידי ${summary.ensemble.synthesizer.name}` : ''}, ${formatRelative(summary.generatedAt)}.`
            : byAi
              ? `הכותרת והתיאור נכתבו על ידי ${isolate(summary.model)}, ${formatRelative(summary.generatedAt)}.`
              : 'הכותרת והתיאור נלקחו מקובץ ה-README ומקובצי התצורה (סיכום מובנה).'}
          {project.edited && ' הם נערכו מאז.'}
        </p>
        {summary?.ensemble && (
          <ul className="flex flex-wrap gap-1.5" aria-label="המודלים באנסמבל">
            {summary.ensemble.members.map((member) => (
              <li
                key={member.provider}
                title={member.ok ? member.model : member.message}
                className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[12px] text-graphite"
              >
                {member.ok ? <Check size={11} aria-hidden="true" /> : <X size={11} className="text-danger" aria-hidden="true" />}
                {member.name}
              </li>
            ))}
          </ul>
        )}
        {summary?.ensemble?.members
          .filter((member) => !member.ok && member.detail)
          .map((member) => (
            <TechnicalDetail key={member.provider}>{`${member.name}: ${member.detail}`}</TechnicalDetail>
          ))}
        {summary?.note && (
          <p className="bidi-plain" dir="auto">
            בקשת ה-AI נכשלה: <span className="text-ink">{summary.note}</span>
          </p>
        )}
        {summary?.detail && <TechnicalDetail>{summary.detail}</TechnicalDetail>}
      </div>
    </div>
  );
}
