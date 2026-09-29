import { SwarmDashboard } from './swarm/SwarmDashboard.jsx';
import { Bot, Brain, Check, ChevronDown, Circle, CircleAlert, CircleCheck, Clapperboard, Globe, Copy, Download, FileArchive, Film, FolderGit2, LoaderCircle, Music, Palette, RefreshCw, Siren, Sparkles, TimerReset, X } from 'lucide-react';
import { Suspense, lazy, useEffect, useState } from 'react';
import { Button, IconButton } from '../../components/ui/Button.jsx';
import { directionOf } from '../../lib/bidi.js';
import { copyText } from '../../lib/clipboard.js';
import { cx } from '../../lib/cx.js';
import { formatBytes, formatTokens, formatUsd } from '../../lib/format.js';
import { TechnicalDetail } from '../projects/details/parts.jsx';
import { resourceUrl } from '../../lib/api.js';

const ChatMarkdown = lazy(() => import('./ChatMarkdown.jsx'));

/** The composer's generators: the chip, the placeholder, and the waiting text. */
export const TOOLS = Object.freeze({
  image: { label: 'יצירת תמונה', icon: Palette, placeholder: 'תארו את התמונה…', pending: 'יוצר תמונה' },
  video: { label: 'יצירת וידאו', icon: Clapperboard, placeholder: 'תארו את הסרטון…', pending: 'יוצר סרטון' },
  music: { label: 'יצירת מוזיקה', icon: Music, placeholder: 'תארו את המוזיקה…', pending: 'יוצר מוזיקה' },
});
const seconds = (ms) => (ms / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1 });
export const EFFORT_LABELS = { low: 'נמוך', medium: 'בינוני', high: 'גבוה', extra: 'גבוה במיוחד', max: 'מקסימלי' };

function Markdown({ text }) {
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap" dir="auto">{text}</p>}>
      <ChatMarkdown text={text} />
    </Suspense>
  );
}

const LTR_RUN = /(@[\w.-]+\/[\w.-]+(?::[^\s,)]+)?|https?:\/\/[^\s)]+)/g;

/** Repository mentions and links stay left-to-right inside Hebrew text (so "@owner/repo" keeps its @ in front). */
function withLtrRuns(text) {
  return text.split(LTR_RUN).map((part, index) =>
    index % 2 ? (
      <bdi key={index} dir="ltr" className="font-medium">
        {part}
      </bdi>
    ) : (
      part
    ),
  );
}

export function UserMessage({ message }) {
  const repos = message.context?.github ?? [];
  const files = message.attachments ?? [];
  const ToolIcon = TOOLS[message.tool]?.icon;
  return (
    <li className="flex flex-col items-end gap-1.5">
      {ToolIcon && (
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-graphite">
          <ToolIcon size={14} aria-hidden="true" />
          {TOOLS[message.tool].label}
        </span>
      )}
      {files.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {files.map((file) =>
            file.kind === 'image' ? (
              <a key={file.id} href={resourceUrl(file.url)} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl border border-line">
                <img src={resourceUrl(file.url)} alt={file.name} className="h-24 max-w-44 object-cover" />
              </a>
            ) : (
              <a key={file.id} href={resourceUrl(file.url)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-[13px] text-graphite hover:text-ink">
                <Film size={16} aria-hidden="true" />
                <bdi dir="auto" className="max-w-40 truncate">{file.name}</bdi>
                <span className="text-mist">{formatBytes(file.size)}</span>
              </a>
            ),
          )}
        </div>
      )}
      <div className="max-w-[85%] rounded-2xl rounded-ee-md bg-sunken px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap" dir={directionOf(message.content)}>
        {withLtrRuns(message.content)}
      </div>
      {repos.map((repo) => (
        <span key={repo.fullName} className="inline-flex max-w-[85%] flex-wrap items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[12px] text-graphite" title={repo.error ?? repo.included?.join(', ')}>
          <FolderGit2 size={12} aria-hidden="true" />
          <span>הקשר מ-GitHub:</span>
          <bdi dir="ltr" className="font-medium text-ink">{repo.fullName}</bdi>
          <span className={repo.error ? 'text-danger' : undefined}>{repo.error ? 'לא נקרא' : `${repo.included.length === 1 ? 'קובץ אחד' : `${repo.included.length} קבצים`} ועץ הקבצים`}</span>
        </span>
      ))}
    </li>
  );
}

const ROLE_NAMES = { answer: 'תשובה', continuation: 'המשך', thinking: 'חשיבה', expert: 'מומחה', synthesis: 'איחוד', router: 'ניתוב', memory: 'זיכרון', architect: 'תוכנית', frontend: 'ממשק', backend: 'צד שרת', review: 'בדיקה', research: 'חיפוש ברשת', recall: 'שליפה מהזיכרון', learning: 'למידה' };
const costText = (usage) => (usage.cost === 0 ? 'חינם' : `${usage.estimated ? '~' : ''}${formatUsd(usage.cost)}`);

/** Every model call behind the answer, for the tooltip on its cost. */
function usageTitle(usage) {
  return (usage.calls ?? [])
    .map((call) => `${ROLE_NAMES[call.role] ?? call.role}: ${call.label} · ${formatTokens(call.input)} קלט, ${formatTokens(call.output)} פלט${typeof call.cost === 'number' ? ` · ${formatUsd(call.cost)}` : ''}${call.estimated ? ' (הערכה)' : ''}`)
    .join('\n');
}

function MetaLine({ message }) {
  const usage = message.usage;
  const tokens = usage ? (usage.input ?? 0) + (usage.output ?? 0) : 0;
  return (
    <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12.5px] text-mist">
      {message.label ? (
        <bdi dir="ltr" className="font-medium text-graphite">{message.label}</bdi>
      ) : (
        <>
          {message.providerName && <span className="font-medium text-graphite">{message.providerName}</span>}
          {message.model && <bdi dir="ltr">{message.model}</bdi>}
        </>
      )}
      {message.effort && message.effort !== 'medium' && <span>מאמץ {EFFORT_LABELS[message.effort]}</span>}
      {message.continuations?.length > 0 && (
        <span title={message.continuations.map((item) => item.label).join(', ')}>
          {message.continuations.length === 1 ? 'המשך אוטומטי ב-' : `${message.continuations.length} המשכים אוטומטיים ב-`}
          <bdi dir="ltr">{message.continuations[0].label}</bdi>
        </span>
      )}
      {message.ms ? <span>{seconds(message.ms)} שניות</span> : null}
      {tokens > 0 && (
        <span title={usageTitle(usage) || undefined}>
          <bdi dir="ltr">{formatTokens(tokens)}</bdi> טוקנים
          {typeof usage.cost === 'number' && (
            <>
              {' · '}
              <bdi dir="ltr">{costText(usage)}</bdi>
            </>
          )}
        </span>
      )}
      {usage?.saved >= 0.0001 && (
        <span>
          נחסכו <bdi dir="ltr">{formatUsd(usage.saved)}</bdi>
        </span>
      )}
    </p>
  );
}

function RouteLine({ route }) {
  if (!route) return null;
  let text = null;
  if (route.mode === 'auto') {
    text = (
      <>
        ניתוב אוטומטי: מורכבות {route.complexity}/10, {route.categoryLabel}. נבחר <bdi dir="ltr">{route.label}</bdi>
        {route.tier === 'massiveCode' ? ', כי נדרש הרבה קוד' : ''}
        {route.by === 'heuristic' ? ' (דירוג מובנה).' : '.'}
      </>
    );
  } else if (route.mode === 'brainstorm') {
    text = (
      <>
        סיעור מוחות: כל המודלים החינמיים, והאיחוד על ידי <bdi dir="ltr">{route.label}</bdi>.
      </>
    );
  } else if (route.mode === 'pipeline') {
    text = (
      <>
        צוות פיתוח: מורכבות {route.complexity}/10, {route.categoryLabel}. ארכיטקט מתכנן, סוכנים כותבים את הקבצים במקביל, ובדיקת QA מחזירה לתיקון את מה שנשבר
        {route.by === 'heuristic' ? ' (דירוג מובנה).' : '.'}
      </>
    );
  } else if (route.mode === 'emergency') {
    text = (
      <>
        מצב חירום: <bdi dir="ltr">{route.label}</bdi>
      </>
    );
  }
  return (
    <>
      {text && (
        <p className={cx('mt-1 inline-flex items-center gap-1.5 text-[12.5px]', route.mode === 'emergency' ? 'font-medium text-danger' : 'text-graphite')} title={route.reason ?? undefined}>
          {route.mode === 'emergency' && <Siren size={13} aria-hidden="true" />}
          <span>{text}</span>
        </p>
      )}
      {route.handoff && (
        <p className="mt-1 text-[12.5px] text-graphite">
          העברה חסכונית ({route.handoff.reason}): <bdi dir="ltr">{route.handoff.to}</bdi> במקום <bdi dir="ltr">{route.handoff.from}</bdi>.
        </p>
      )}
      {route.notice && <p className="mt-1 text-[12.5px] text-mist">{route.notice}</p>}
    </>
  );
}

/** The web researcher's part of an answer: the search while it runs, then the sources, or why it failed. */
function Research({ research }) {
  if (research.state === 'searching') {
    return (
      <p className="mt-2 flex w-fit max-w-full items-center gap-2 rounded-full bg-sunken px-3 py-1.5 text-[13px] text-graphite" role="status">
        <LoaderCircle size={14} className="shrink-0 animate-spin text-ink" aria-hidden="true" />
        <span className="min-w-0 truncate">
          מחפש ברשת:{' '}
          <bdi dir="auto" className="font-medium text-ink">
            {research.query}
          </bdi>
        </span>
      </p>
    );
  }
  if (research.state === 'failed') return <p className="mt-2 text-[12.5px] text-mist">החיפוש ברשת נכשל: {research.error}</p>;
  if (!research.results?.length) return <p className="mt-2 text-[12.5px] text-mist">החיפוש ברשת לא מצא תוצאות.</p>;
  return (
    <details className="group mt-2.5 rounded-2xl border border-line bg-sunken/40 px-3.5 py-2.5">
      <summary className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-graphite">
        <Globe size={14} className="shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium text-ink">מקורות מהרשת ({research.results.length})</span>
        <span className="min-w-0 truncate text-mist">
          <bdi dir="auto">{research.query}</bdi>
        </span>
        <ChevronDown size={14} className="ms-auto shrink-0 text-mist transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <ol className="mt-2 space-y-1.5">
        {research.results.map((source, index) => (
          <li key={source.url} className="flex gap-2 text-[13.5px] leading-snug">
            <span className="shrink-0 text-mist">[{index + 1}]</span>
            <span className="min-w-0">
              <a href={source.url} target="_blank" rel="noreferrer noopener" className="font-medium text-ink underline-offset-2 hover:underline">
                <bdi dir="auto">{source.title}</bdi>
              </a>
              <span className="text-mist">
                {' · '}
                <bdi dir="ltr">{source.domain}</bdi>
              </span>
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** The long-term memories an answer was given, folded under the route line. */
function Recalled({ memories }) {
  return (
    <details className="group mt-1 text-[12.5px] text-graphite">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1.5">
        <Brain size={13} aria-hidden="true" />
        {memories.length === 1 ? 'נעזר בדבר אחד שלמדתי עליך' : `נעזר ב-${memories.length} דברים שלמדתי עליך`}
        <ChevronDown size={13} className="text-mist transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <ul className="mt-1.5 list-disc space-y-1 ps-5 text-[13px] text-ink">
        {memories.map((memory) => (
          <li key={memory.id} dir="auto">
            {memory.project && <span className="text-mist">({memory.project}) </span>}
            {memory.content}
          </li>
        ))}
      </ul>
    </details>
  );
}

const TEAM_STATES = {
  waiting: { icon: Circle, className: 'text-mist' },
  working: { icon: LoaderCircle, className: 'animate-spin text-ink' },
  done: { icon: CircleCheck, className: 'text-ok' },
  failed: { icon: CircleAlert, className: 'text-danger' },
};

/** The development team at work: who plans, builds and reviews, and where each one stands. */
function Team({ team, streaming }) {
  // The last step at work is the one to show: while files are being fixed, the QA check is still open above it.
  const current = streaming ? team.findLast((member) => member.state === 'working') : null;
  return (
    <>
      <ol className="mt-2.5 space-y-2 rounded-2xl border border-line bg-sunken/40 px-3.5 py-3" aria-label="צוות הפיתוח">
        {team.map((member) => {
          const state = TEAM_STATES[member.state] ?? TEAM_STATES.waiting;
          const working = member === current;
          return (
            <li key={member.role} className="flex items-start gap-2.5 text-[13.5px] leading-snug">
              <state.icon size={15} className={cx('mt-0.5 shrink-0', state.className, member.state === 'working' && !streaming && 'animate-none')} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className={member.state === 'waiting' ? 'text-mist' : 'text-ink'}>
                  {working ? (
                    <>
                      <bdi dir="ltr" className="font-semibold">
                        {member.model}
                      </bdi>{' '}
                      {member.doing}…
                    </>
                  ) : (
                    <>
                      {member.title}: <bdi dir="ltr">{member.model}</bdi>
                    </>
                  )}
                </span>
                {member.note && <span className="block text-[12.5px] text-graphite">{member.note}</span>}
                {member.progress && member.state === 'working' ? <TeamStepProgress {...member.progress} /> : null}
              </span>
              {member.ms && member.state !== 'working' ? <span className="shrink-0 text-[12px] text-mist">{seconds(member.ms)} שניות</span> : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** How far a step that works on many files has come: a thin bar and "12 מתוך 40". */
function TeamStepProgress({ done, total }) {
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <span className="mt-1.5 flex items-center gap-2" role="progressbar" aria-label="התקדמות השלב" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
        <span className="block h-full rounded-full bg-ink transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </span>
      <span className="shrink-0 text-[12px] text-mist tabular-nums">
        {done} מתוך {total}
      </span>
    </span>
  );
}

/**
 * While the team works: who is working now, right under the text being written.
 * The answer scrolls as it grows, so this stays in view when the timeline doesn't.
 */
function TeamProgress({ team }) {
  const index = team.findLastIndex((member) => member.state === 'working');
  if (index === -1) return null;
  const member = team[index];
  return (
    <p className="mt-3 flex w-fit max-w-full items-center gap-2 rounded-full bg-sunken px-3 py-1.5 text-[13px] text-graphite" role="status">
      <LoaderCircle size={14} className="shrink-0 animate-spin text-ink" aria-hidden="true" />
      <span className="min-w-0 truncate">
        <bdi dir="ltr" className="font-semibold text-ink">
          {member.model}
        </bdi>{' '}
        {member.doing}…{member.progress ? <span className="tabular-nums"> ({member.progress.done}/{member.progress.total})</span> : null}
      </span>
      <span className="shrink-0 text-mist">
        שלב {index + 1} מתוך {team.length}
      </span>
    </p>
  );
}

function RetryNotice({ retry }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((retry.at + retry.waitMs - now) / 1000));
  return (
    <p className="mt-2 inline-flex items-center gap-2 rounded-full bg-sunken px-3 py-1 text-[13px] text-graphite" role="status">
      <TimerReset size={14} aria-hidden="true" />
      המודל עמוס כרגע. ניסיון {retry.attempt} מתוך {retry.attempts}
      {left > 0 ? ` בעוד ${left} שניות…` : '…'}
    </p>
  );
}

function Thinking({ text, streaming }) {
  return (
    <details className="mt-2 rounded-xl border border-line px-3 py-2" open={streaming || undefined}>
      <summary className="cursor-pointer text-[13px] font-medium text-graphite select-none">{streaming ? 'המודל חושב…' : 'תהליך החשיבה'}</summary>
      <div className="bidi-plain mt-2 max-h-72 overflow-y-auto text-[13.5px] leading-relaxed whitespace-pre-wrap text-graphite" dir={directionOf(text)}>
        {text.trim()}
      </div>
    </details>
  );
}

function Experts({ experts, streaming }) {
  return (
    <details className="mt-2 rounded-xl border border-line px-3 py-2" open={streaming || undefined}>
      <summary className="cursor-pointer text-[13px] font-medium text-graphite select-none">תשובות המומחים ({experts.length})</summary>
      <ul className="mt-2 space-y-3">
        {experts.map((expert, index) => (
          <li key={`${expert.provider}-${index}`} className="rounded-lg bg-sunken/50 px-3 py-2">
            <p className="flex items-center gap-2 text-[12.5px] text-graphite">
              {expert.ok ? <Check size={13} aria-hidden="true" /> : <X size={13} className="text-danger" aria-hidden="true" />}
              <bdi dir="ltr" className="font-medium text-ink">{expert.label}</bdi>
              {expert.ms ? <span className="text-mist">{seconds(expert.ms)} שניות</span> : null}
            </p>
            {expert.ok ? (
              <div className="mt-1.5 max-h-80 overflow-y-auto text-[14px]">
                <Markdown text={expert.text} />
              </div>
            ) : (
              <>
                <p className="bidi-plain mt-1 text-[13px] text-danger" dir={directionOf(expert.error)}>{expert.error}</p>
                {expert.detail && <TechnicalDetail className="mt-1">{expert.detail}</TechnicalDetail>}
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function BundleCard({ bundle }) {
  return (
    <div className="mt-3 rounded-2xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-sunken text-ink">
          <FileArchive size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold">הקוד ארוז בקובץ ZIP</p>
          <p className="text-[12.5px] text-graphite">
            {bundle.files.length} קבצים, {formatBytes(bundle.size)}
          </p>
        </div>
        <Button as="a" href={resourceUrl(bundle.url)} download size="sm" icon={Download}>
          הורדת <bdi dir="ltr">{bundle.name}</bdi>
        </Button>
      </div>
      <ul dir="ltr" className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-left font-mono text-[12px] text-graphite">
        {bundle.files.map((file) => (
          <li key={file.path}>{file.path}</li>
        ))}
      </ul>
    </div>
  );
}

function CopyAnswer({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // the browser refused clipboard access
    }
  };
  return (
    <IconButton label={copied ? 'הועתק' : 'העתקת התשובה'} onClick={copy}>
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
    </IconButton>
  );
}

/** An answer: model and routing, stages, thinking, expert answers, the text, the ZIP, and errors. */
export function AssistantMessage({ message, streaming = false, stage = null, retry = null, isLast = false, onRegenerate }) {
  if (message.media) return <MediaAnswer message={message} />;
  const { content, reasoning, error, stopped, experts, bundle } = message;
  const emergency = message.route?.mode === 'emergency';
  return (
    <li className="flex gap-3">
      <span className={cx('mt-0.5 grid size-8 shrink-0 place-items-center rounded-full text-paper', emergency ? 'bg-danger' : 'bg-ink')} aria-hidden="true">
        {emergency ? <Siren size={15} /> : <Bot size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <MetaLine message={message} />
        <RouteLine route={message.route} />
        {message.recalled?.length > 0 && <Recalled memories={message.recalled} />}
        {message.research && <Research research={message.research} />}
        {message.pipeline ? <SwarmDashboard pipeline={message.pipeline} bundle={message.bundle ?? null} /> : message.team?.length > 0 && <Team team={message.team} streaming={streaming} />}
        {streaming && stage && !content && (
          <p className="mt-2 inline-flex items-center gap-2 text-[13px] text-graphite" role="status">
            <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
            {stage.label}…
          </p>
        )}
        {retry && <RetryNotice retry={retry} />}
        {reasoning && <Thinking text={reasoning} streaming={streaming && !content} />}
        {experts?.length > 0 && <Experts experts={experts} streaming={streaming && !content} />}
        {content && (
          <div className="mt-1.5">
            <Markdown text={content} />
          </div>
        )}
        {streaming && !content && !reasoning && !retry && !stage && message.research?.state !== 'searching' && <p className="mt-2 text-[14px] text-mist">כותב…</p>}
        {streaming && content && <span className="typing-caret" aria-hidden="true" />}
        {streaming && message.team?.length > 0 && <TeamProgress team={message.team} />}
        {bundle && !message.pipeline && <BundleCard bundle={bundle} />}
        {stopped && <p className="mt-2 text-[13px] text-mist">התשובה נעצרה.</p>}
        {error && (
          <div className="mt-2 rounded-xl border border-line bg-sunken/60 px-4 py-3" role="alert">
            <p className="bidi-plain text-[14px] leading-relaxed text-danger" dir="auto">
              {error.message}
            </p>
            {error.detail && <TechnicalDetail className="mt-1.5 whitespace-pre-line">{error.detail}</TechnicalDetail>}
            {isLast && onRegenerate && (
              <Button size="sm" icon={RefreshCw} className="mt-3" onClick={onRegenerate}>
                ניסיון נוסף
              </Button>
            )}
          </div>
        )}
        {!streaming && (content || (isLast && !error)) && (
          <div className="mt-1 flex items-center gap-0.5 text-graphite">
            {content && <CopyAnswer text={content} />}
            {isLast && onRegenerate && (
              <IconButton label="תשובה חדשה" onClick={onRegenerate}>
                <RefreshCw size={15} aria-hidden="true" />
              </IconButton>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** An image, a video or music made with the chat's generators. */
function MediaAnswer({ message }) {
  const { media } = message;
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-ink text-paper" aria-hidden="true">
        <Sparkles size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2.5 text-[12.5px] text-mist">
          <span className="font-medium text-graphite">Pollinations</span>
          <bdi dir="ltr">{media.model}</bdi>
          {message.ms ? <span>{seconds(message.ms)} שניות</span> : null}
        </p>
        <div className="mt-2">
          {media.kind === 'image' && (
            <a href={resourceUrl(media.url)} target="_blank" rel="noopener noreferrer" className="inline-block overflow-hidden rounded-2xl border border-line">
              <img src={resourceUrl(media.url)} alt={media.prompt} className="block max-h-[min(60vh,480px)] w-auto max-w-full" />
            </a>
          )}
          {media.kind === 'video' && (
            <video src={resourceUrl(media.url)} controls playsInline preload="metadata" className="max-h-[min(60vh,480px)] max-w-full rounded-2xl border border-line bg-black" />
          )}
          {media.kind === 'music' && <audio src={resourceUrl(media.url)} controls preload="metadata" className="w-full max-w-md" />}
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <a
            href={resourceUrl(`${media.url}?download=1`)}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px] text-graphite transition-colors hover:bg-sunken hover:text-ink"
          >
            <Download size={15} aria-hidden="true" />
            הורדה
            <span className="text-mist">{formatBytes(media.size)}</span>
          </a>
        </div>
      </div>
    </li>
  );
}

/** The placeholder while a generator works, with the time so far. */
export function MediaPending({ live }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const tool = TOOLS[live.kind];
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-ink text-paper" aria-hidden="true">
        <Sparkles size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-graphite">Pollinations</p>
        <div
          role="status"
          className={cx(
            'mt-2 grid animate-pulse place-items-center rounded-2xl border border-line bg-sunken text-graphite motion-reduce:animate-none',
            live.kind === 'music' ? 'h-16 w-full max-w-md' : live.kind === 'video' ? 'aspect-video w-full max-w-md' : 'aspect-square w-full max-w-64',
          )}
        >
          <span className="flex items-center gap-2 text-[13.5px]">
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            {tool.pending}… {Math.max(0, Math.round((now - live.started) / 1_000))} שניות
          </span>
        </div>
        {live.kind !== 'image' && <p className="mt-1.5 text-[12.5px] text-mist">סרטונים ומוזיקה יכולים לקחת כמה דקות.</p>}
      </div>
    </li>
  );
}
