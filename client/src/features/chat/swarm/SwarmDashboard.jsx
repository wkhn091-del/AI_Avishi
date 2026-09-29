/**
 * The development team, live: the run's four phases (plan, parallel writing, checking and self-correction,
 * packaging) in the colors of the work (blue planning, yellow writing, orange self-correcting, green
 * passing). The state comes from useSwarmPipeline: live over Server-Sent Events while the answer is being
 * written, and the run's saved final state afterwards.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Circle, Download, FileCode2, Folder, History, LoaderCircle, Minus, Package, TriangleAlert, Wrench, X } from 'lucide-react';
import { cx } from '../../../lib/cx.js';
import { useAnimatedNumber } from '../../../lib/useAnimatedNumber.js';
import { TONE, activityOf, filesText, phasesOf, secondsText, shortModel } from './pipelineState.js';
import { useSwarmPipeline } from './useSwarmPipeline.js';
import { ArtifactPanel } from './ArtifactPanel.jsx';
import { useArtifacts } from './artifactContext.js';
import { resourceUrl } from '../../../lib/api.js';

const clock = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const bytesText = (size) => (size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);
const creditsText = (count) => (count === 1 ? 'קרדיט אחד' : `${count} קרדיטים`);

function Elapsed({ state }) {
  const running = state.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return (
    <span className="text-[12.5px] text-mist tabular-nums" dir="ltr" title="זמן העבודה">
      {clock((state.finishedAt ?? now) - state.startedAt)}
    </span>
  );
}

function Header({ state, connection }) {
  const activity = activityOf(state);
  const tone = TONE[activity.tone];
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
      <div className="min-w-0">
        <p className="text-[12.5px] font-semibold text-graphite">
          {state.mode === 'edit' ? `צוות פיתוח · עדכון לגרסה ${state.artifact?.version ?? ''}` : 'צוות פיתוח'} · {state.status === 'running' ? 'בזמן אמת' : 'סיכום העבודה'}
        </p>
        <p className="truncate text-[15.5px] font-bold">{state.architect.title || 'פרויקט חדש'}</p>
      </div>
      <div className="flex items-center gap-2">
        {connection === 'reconnecting' && <span className="text-[12px] text-mist">מתחבר מחדש…</span>}
        <span role="status" aria-live="polite" className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-semibold transition-colors duration-500', tone.soft, tone.border, tone.text)}>
          <span className={cx('size-2 rounded-full', tone.dot, activity.pulse && 'motion-safe:animate-pulse')} aria-hidden="true" />
          {activity.label}
        </span>
        <Elapsed state={state} />
      </div>
    </header>
  );
}

function PhaseMark({ phase, index }) {
  const tone = TONE[phase.status === 'failed' ? 'danger' : phase.status === 'waiting' ? 'idle' : phase.tone];
  return (
    <span
      className={cx(
        'grid size-7 shrink-0 place-items-center rounded-full border-2 text-[12.5px] font-bold transition-colors duration-500',
        phase.status === 'waiting' ? 'border-line bg-surface text-mist' : phase.status === 'active' ? cx(tone.border, tone.soft, tone.text) : cx('border-transparent text-white', tone.dot),
      )}
      aria-hidden="true"
    >
      {phase.status === 'done' ? <Check size={14} strokeWidth={3} /> : phase.status === 'failed' ? <X size={14} strokeWidth={3} /> : phase.status === 'attention' ? <TriangleAlert size={13} strokeWidth={2.5} /> : phase.status === 'active' ? <span className={cx('size-2 rounded-full motion-safe:animate-pulse', tone.dot)} /> : index + 1}
    </span>
  );
}

function Stepper({ phases }) {
  return (
    <ol className="grid grid-cols-4 gap-2 px-4 pb-1 pt-3" aria-label="שלבי העבודה">
      {phases.map((phase, index) => {
        const tone = TONE[phase.status === 'failed' ? 'danger' : phase.status === 'waiting' ? 'idle' : phase.tone];
        return (
          <li key={phase.id} className="min-w-0" aria-current={phase.status === 'active' ? 'step' : undefined}>
            <span className={cx('block h-1.5 rounded-full transition-colors duration-700', phase.status === 'waiting' ? 'bg-line' : tone.rail, phase.status === 'active' && 'motion-safe:animate-pulse')} />
            <span className="mt-1.5 flex items-center gap-1.5">
              <PhaseMark phase={phase} index={index} />
              <span className={cx('truncate text-[12.5px] font-semibold', phase.status === 'waiting' ? 'text-mist' : 'text-ink')}>{phase.title}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Panel({ phase, index, open, onToggle, children }) {
  return (
    <section className="border-t border-line">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-start transition-colors hover:bg-sunken/60">
        <PhaseMark phase={phase} index={index} />
        <span className="shrink-0 text-[14px] font-semibold">{phase.title}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-graphite">{phase.summary}</span>
        <ChevronDown size={16} className={cx('shrink-0 text-mist transition-transform duration-300', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <div className={cx('grid transition-[grid-template-rows] duration-300 ease-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <div className="px-4 pb-4 pt-1">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** The planned files as a tree: folders first, each file with what it's for. */
// An edit's plan: what happens to each file.
const ACTION_LOOK = {
  create: { label: 'חדש', className: 'bg-pass/15 text-pass' },
  modify: { label: 'שינוי', className: 'bg-gen/20 text-ink' },
  delete: { label: 'נמחק', className: 'bg-danger/10 text-danger' },
};

function FileTree({ entries, planning }) {
  const rows = useMemo(() => {
    const root = { folders: new Map(), files: [] };
    for (const entry of entries) {
      const parts = entry.path.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
        node = node.folders.get(part);
      }
      node.files.push({ ...entry, name: parts.at(-1) });
    }
    const flat = [];
    const walk = (node, depth, prefix) => {
      for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
        flat.push({ id: `${prefix}${name}/`, name, depth, folder: true });
        walk(child, depth + 1, `${prefix}${name}/`);
      }
      for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) flat.push({ id: file.path, name: file.name, depth, purpose: file.kind === 'manifest' ? '' : file.purpose, manifest: file.kind === 'manifest', action: file.action });
    };
    walk(root, 0, '');
    return flat;
  }, [entries]);
  return (
    <ul dir="ltr" aria-label="עץ הקבצים" className="max-h-80 overflow-auto rounded-xl border border-plan/25 bg-plan/5 px-3 py-2 font-mono text-[12.5px] leading-6">
      {rows.map((row) => (
        <li key={row.id} className="tree-in flex min-w-0 items-center gap-1.5 whitespace-nowrap" style={{ paddingLeft: `${row.depth * 16}px` }}>
          {row.folder ? <Folder size={14} className="shrink-0 text-plan" aria-hidden="true" /> : <FileCode2 size={14} className={cx('shrink-0', row.manifest ? 'text-gen' : 'text-graphite')} aria-hidden="true" />}
          <span className={cx('shrink-0', row.folder && 'font-semibold', row.action === 'delete' && 'text-mist line-through')}>
            {row.name}
            {row.folder ? '/' : ''}
          </span>
          {row.action && <span className={cx('shrink-0 rounded-full px-1.5 font-sans text-[10.5px] leading-4 font-semibold', ACTION_LOOK[row.action].className)}>{ACTION_LOOK[row.action].label}</span>}
          {row.purpose && (
            <bdi className="min-w-0 truncate font-sans text-[11.5px] text-mist" title={row.purpose}>
              {row.purpose}
            </bdi>
          )}
        </li>
      ))}
      {planning && <li className="my-1 h-4 w-28 rounded bg-plan/20 motion-safe:animate-pulse" aria-hidden="true" />}
    </ul>
  );
}

function ArchitectView({ architect }) {
  const planning = architect.status === 'working';
  const entries = planning ? architect.draft.map((path) => ({ path })) : architect.tree;
  return (
    <div className="space-y-3">
      <p className="text-[13.5px] leading-6 text-graphite">
        {planning ? (
          <>
            <bdi className="font-semibold text-plan">{architect.model}</bdi> כותב את התוכנית כ-JSON, בלי קוד
            {architect.chars ? ` · ${Math.round(architect.chars / 1000)} אלף תווים` : ''}
          </>
        ) : (
          architect.summary || architect.note
        )}
      </p>
      {!planning && architect.stack?.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="טכנולוגיות">
          {architect.stack.map((item) => (
            <li key={item} className="rounded-full bg-plan/10 px-2.5 py-0.5 text-[12px] font-medium text-plan">
              <bdi>{item}</bdi>
            </li>
          ))}
        </ul>
      )}
      {entries.length ? (
        <FileTree entries={entries} planning={planning} />
      ) : (
        <div className="space-y-2 rounded-xl border border-plan/25 bg-plan/5 p-3" aria-label="התוכנית נכתבת">
          {[36, 52, 44].map((width) => (
            <span key={width} className="block h-3 rounded bg-plan/20 motion-safe:animate-pulse" style={{ width: `${width}%` }} />
          ))}
        </div>
      )}
      {!planning && architect.note && <p className="text-[12px] text-mist">{architect.note}</p>}
    </div>
  );
}

const FILE_LOOK = {
  queued: { icon: Circle, icon_: 'text-line-strong', card: 'border-line bg-surface', text: 'בתור' },
  writing: { icon: LoaderCircle, icon_: 'text-gen motion-safe:animate-spin', card: 'border-gen/60 bg-gen/10 motion-safe:animate-pulse', text: 'נכתב עכשיו' },
  written: { icon: Check, icon_: 'text-pass', card: 'border-line bg-surface', text: 'נכתב' },
  flagged: { icon: TriangleAlert, icon_: 'text-fix', card: 'border-fix/45 bg-fix/5', text: 'נמצאה בעיה' },
  fixing: { icon: Wrench, icon_: 'text-fix motion-safe:animate-pulse', card: 'border-fix bg-fix/10 ring-2 ring-fix/25', text: 'מתקן את עצמו' },
  fixed: { icon: Check, icon_: 'text-pass', card: 'border-pass/45 bg-pass/5', text: 'תוקן' },
  broken: { icon: X, icon_: 'text-danger', card: 'border-danger/40 bg-danger/5', text: 'נותרה בעיה' },
  failed: { icon: X, icon_: 'text-danger', card: 'border-danger/40 bg-danger/5', text: 'לא נכתב' },
};

function metaOf(file) {
  if (file.status === 'writing') return `${shortModel(file.model)} כותב…`;
  if (file.status === 'fixing') return `${shortModel(file.model)} מתקן…`;
  if (file.status === 'flagged') return `${file.issues === 1 ? 'בעיה אחת' : `${file.issues} בעיות`} · ממתין לתיקון`;
  if (file.status === 'fixed') return `תוקן בניסיון ${file.attempt}${file.fixPhase === 'sandbox' ? ' · אחרי הרצה' : ''}`;
  if (file.status === 'written') return `${file.lines} שורות · ${shortModel(file.model)}`;
  return FILE_LOOK[file.status]?.text ?? '';
}

function FileCard({ file }) {
  const look = FILE_LOOK[file.status] ?? FILE_LOOK.queued;
  const slash = file.path.lastIndexOf('/');
  return (
    <li className={cx('relative min-w-0 rounded-xl border px-2.5 pb-2 pt-2.5 transition-colors duration-500', look.card)} title={`${file.path}: ${look.text}`}>
      {file.status === 'fixing' && (
        <span className="absolute -top-2.5 start-2 whitespace-nowrap rounded-full bg-fix px-2 py-0.5 text-[10.5px] font-bold text-white shadow-sm">
          מתקן את עצמו · ניסיון {file.attempt}/{file.maxAttempts}
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        <look.icon size={14} className={cx('shrink-0', look.icon_)} aria-hidden="true" />
        <bdi dir="ltr" className="min-w-0 truncate font-mono text-[12.5px] font-semibold">
          {file.path.slice(slash + 1)}
        </bdi>
      </span>
      <span dir="ltr" className="block truncate text-start font-mono text-[11px] text-mist">
        {slash === -1 ? './' : file.path.slice(0, slash + 1)}
      </span>
      {file.snippet && ['flagged', 'fixing', 'broken'].includes(file.status) && (
        <span className="mt-1 block rounded-md bg-fix/10 px-1.5 py-1" title={file.snippet}>
          {file.line && <span className="block text-[10.5px] font-semibold text-fix">שורה {file.line}</span>}
          <span dir="ltr" className="line-clamp-2 block text-left font-mono text-[10.5px] leading-4 text-fix">
            {file.snippet}
          </span>
        </span>
      )}
      <span className="mt-0.5 block truncate text-[11px] text-mist">{metaOf(file)}</span>
    </li>
  );
}

function FileGrid({ files, label }) {
  return (
    <ul aria-label={label} className="grid grid-cols-2 gap-x-1.5 gap-y-3 pt-2 sm:grid-cols-3 xl:grid-cols-4">
      {files.map((file) => (
        <FileCard key={file.path} file={file} />
      ))}
    </ul>
  );
}

function BuildView({ state }) {
  const { build, files, settings } = state;
  const shown = Math.min(settings.concurrency, 16);
  const finished = build.done + build.failed;
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span className="text-graphite">
          <b className="text-ink tabular-nums">{build.done}</b> מתוך {filesText(build.total)} נכתבו{build.failed ? ` · ${build.failed} לא נכתבו` : ''}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[12px] text-mist" title={`עד ${settings.concurrency} קבצים במקביל (PIPELINE_CONCURRENCY)`}>
          <span className="inline-flex gap-0.5" aria-hidden="true">
            {Array.from({ length: shown }, (_, index) => (
              <span key={index} className={cx('h-3 w-1.5 rounded-full transition-colors duration-300', index < build.active ? 'bg-gen motion-safe:animate-pulse' : 'bg-line')} />
            ))}
          </span>
          <span className="tabular-nums">
            {build.active}/{settings.concurrency} במקביל
          </span>
        </span>
      </div>
      <span className="block h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-label="הקבצים שנכתבו" aria-valuemin={0} aria-valuemax={build.total} aria-valuenow={finished}>
        <span className={cx('block h-full rounded-full transition-[width,background-color] duration-500', build.status === 'done' ? 'bg-pass' : 'bg-gen')} style={{ width: `${build.total ? (finished / build.total) * 100 : 0}%` }} />
      </span>
      <FileGrid files={files} label="הקבצים" />
    </div>
  );
}

const STEP_LOOK = {
  running: { icon: LoaderCircle, icon_: 'text-gen motion-safe:animate-spin', text: 'רץ…' },
  passed: { icon: Check, icon_: 'text-pass', text: 'עבר' },
  failed: { icon: X, icon_: 'text-danger', text: 'נכשל' },
  cached: { icon: Check, icon_: 'text-mist', text: 'מההרצה הקודמת' },
  skipped: { icon: Minus, icon_: 'text-mist', text: 'דולג' },
  setup: { icon: TriangleAlert, icon_: 'text-fix', text: 'דורש הגדרות' },
};

function VerifyView({ state }) {
  const { qa, sandbox, files } = state;
  const loop = files.filter((file) => file.fixPhase && ['flagged', 'fixing', 'fixed', 'broken'].includes(file.status));
  const qaTone = qa.status === 'working' ? 'plan' : qa.status === 'failed' ? 'fix' : qa.status === 'done' ? 'pass' : 'idle';
  const boxTone = sandbox.status === 'working' ? 'gen' : sandbox.status === 'done' ? 'pass' : ['failed', 'unavailable'].includes(sandbox.status) ? 'fix' : 'idle';
  const card = (tone) => cx('rounded-xl border px-3 py-2.5 transition-colors duration-500', TONE[tone].border, TONE[tone].soft);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className={card(qaTone)}>
          <p className="text-[13px] font-semibold">בדיקת קוד</p>
          <p className="text-[12px] text-graphite">קומפיילר{qa.reviewer ? <> + <bdi>{qa.reviewer}</bdi></> : ''}</p>
          <p className={cx('mt-1 text-[12.5px] font-medium', TONE[qaTone].text)}>{qa.status === 'waiting' ? 'ממתין' : qa.note || (qa.remaining ? `נותרו ${qa.remaining} בעיות` : 'עבר')}</p>
        </div>
        <div className={card(boxTone)}>
          <p className="text-[13px] font-semibold">הרצה בסביבה מבודדת</p>
          <p className="text-[12px] text-graphite">{sandbox.provider ? <bdi>{sandbox.provider}</bdi> : 'Docker או E2B'}</p>
          <p className={cx('mt-1 text-[12.5px] font-medium', TONE[boxTone].text)}>
            {sandbox.status === 'off' ? 'כבויה: הבדיקה סטטית' : sandbox.status === 'waiting' ? 'ממתינה לבדיקת הקוד' : sandbox.status === 'working' ? `רצה${sandbox.round > 1 ? `, סבב ${sandbox.round}` : ''}…` : sandbox.status === 'done' ? 'נבנה והורץ בהצלחה' : sandbox.status === 'skipped' ? 'אין מה להריץ' : sandbox.reason || 'נמצאו שגיאות'}
          </p>
        </div>
      </div>
      {sandbox.steps.length > 0 && (
        <ul aria-label="שלבי ההרצה" className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {sandbox.steps.map((step) => {
            const look = STEP_LOOK[step.status] ?? STEP_LOOK.running;
            return (
              <li key={step.key} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                <look.icon size={15} className={cx('shrink-0', look.icon_)} aria-hidden="true" />
                <span className="font-semibold">{step.label}</span>
                {step.dir && (
                  <bdi dir="ltr" className="font-mono text-[12px] text-mist">
                    {step.dir}
                  </bdi>
                )}
                <span className="min-w-0 flex-1 truncate text-graphite">
                  {look.text}
                  {step.counts ? ` · ${step.counts.passed} בדיקות עברו${step.counts.failed ? `, ${step.counts.failed} נכשלו` : ''}` : ''}
                  {step.timedOut ? ' · חרג מהזמן' : ''}
                </span>
                {step.ms > 0 && <span className="shrink-0 text-[12px] text-mist tabular-nums">{secondsText(step.ms)}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {sandbox.status === 'off' && <p className="text-[12.5px] leading-5 text-mist">ההרצה בסביבה מבודדת כבויה, ולכן הקוד נקרא ונבדק אבל לא מותקן ולא מורץ.</p>}
      {sandbox.pinned?.length > 0 && (
        <p className="text-[12px] text-mist">
          גרסאות שנקבעו לפי ההתקנה: <bdi dir="ltr">{sandbox.pinned.join(', ')}</bdi>
        </p>
      )}
      {loop.length > 0 && (
        <div>
          <p className="text-[13px] font-semibold text-fix">תיקון עצמי</p>
          <FileGrid files={loop} label="קבצים בתיקון עצמי" />
        </div>
      )}
    </div>
  );
}

function CreditsLine({ credits, animate }) {
  const charged = credits?.status === 'done' && !credits.unlimited && typeof credits.after === 'number';
  const [target, setTarget] = useState(charged && animate ? credits.before : (credits?.after ?? null));
  useEffect(() => {
    if (!charged) return undefined;
    // After a beat, the balance counts down from what it was to what's left.
    const timer = setTimeout(() => setTarget(credits.after), animate ? 450 : 0);
    return () => clearTimeout(timer);
  }, [charged, animate, credits?.after]);
  const shown = useAnimatedNumber(target, { duration: 1100 });
  if (credits?.status !== 'done') return null;
  if (credits.unlimited) return <p className="text-[12.5px] text-mist">ללא חיוב בקרדיטים: מנהל מערכת.</p>;
  if (!charged) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      <span className="text-graphite">חויבו {creditsText(credits.charged)} ({filesText(credits.charged)} בתוכנית)</span>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 font-semibold tabular-nums" aria-label={`היתרה: ${creditsText(credits.after)}`}>
        יתרה <bdi dir="ltr">{shown}</bdi>
        <span aria-hidden="true">🪙</span>
      </span>
      {typeof credits.before === 'number' && (
        // A row, not text: the order stays "from → to", read from the right.
        <span className="inline-flex items-center gap-1 text-[12px] text-mist tabular-nums" aria-label={`מ-${credits.before} ל-${credits.after}`}>
          <span>{credits.before}</span>
          <span aria-hidden="true">←</span>
          <span>{credits.after}</span>
        </span>
      )}
    </p>
  );
}

function ShipView({ state, fallbackBundle, animate }) {
  const artifacts = useArtifacts();
  const bundle = state.package.bundle ?? fallbackBundle ?? null;
  if (state.status === 'failed') return <p className="text-[13.5px] text-danger">{state.error ?? 'העבודה נעצרה בגלל שגיאה.'}</p>;
  if (state.status === 'stopped') return <p className="text-[13.5px] text-graphite">העבודה נעצרה לפני שהפרויקט נארז.</p>;
  // The project's latest version gets the live panel (preview, code, edits); an older one says where it went.
  const artifact = state.status === 'done' && artifacts && state.artifact ? state.artifact : null;
  const latest = artifact ? artifacts.heads.get(artifact.id) : null;
  const head = artifact && (latest === undefined || latest <= artifact.version);
  return (
    <div className="space-y-3">
      {head ? (
        <ArtifactPanel artifact={artifact} preview={state.preview} bundle={bundle} />
      ) : artifact && (
        <p className="flex items-center gap-1.5 text-[13px] text-graphite">
          <History size={14} className="shrink-0 text-mist" aria-hidden="true" />
          גרסה {artifact.version} של הפרויקט · עודכנה בהמשך השיחה (הקוד שלה בקובץ ה-ZIP).
        </p>
      )}
      {head ? null : state.package.status !== 'done' || !bundle ? (
        <p className="flex items-center gap-2 text-[13.5px] text-graphite">
          <LoaderCircle size={15} className="text-pass motion-safe:animate-spin" aria-hidden="true" />
          אורז את הפרויקט ל-ZIP…
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-pass/40 bg-pass/10 px-3 py-3 transition-colors duration-500">
          <Package size={22} className="shrink-0 text-pass" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold">הפרויקט מוכן</p>
            <p className="truncate text-[12.5px] text-graphite">
              {bundle.name && (
                <>
                  <bdi dir="ltr">{bundle.name}</bdi> ·{' '}
                </>
              )}
              {filesText(bundle.files ?? 0)}
              {bundle.size ? ` · ${bytesText(bundle.size)}` : ''}
            </p>
          </div>
          {bundle.url && (
            <a href={resourceUrl(bundle.url)} download className="inline-flex h-9 items-center gap-1.5 rounded-full bg-pass px-4 text-[14px] font-semibold text-white transition hover:brightness-110">
              <Download size={16} aria-hidden="true" />
              הורדת הפרויקט
            </a>
          )}
        </div>
      )}
      {state.result?.remaining > 0 && (
        <p className="text-[13px] text-fix">{state.result.remaining === 1 ? 'נותרה בעיה אחת' : `נותרו ${state.result.remaining} בעיות`} שהתיקון העצמי לא פתר: הן מפורטות ב-QA_REPORT.md שבקובץ.</p>
      )}
      <CreditsLine credits={state.credits} animate={animate} />
    </div>
  );
}

export function SwarmDashboard({ pipeline, bundle = null }) {
  const { state, connection } = useSwarmPipeline(pipeline);
  const [manual, setManual] = useState({});
  if (!state) {
    return (
      <section aria-label="צוות הפיתוח בזמן אמת" className="mt-3 rounded-2xl border border-plan/30 bg-plan/5 px-4 py-3">
        <p className="flex items-center gap-2 text-[13.5px] text-plan">
          <LoaderCircle size={15} className="motion-safe:animate-spin" aria-hidden="true" />
          {connection === 'closed' ? 'פרטי העבודה יופיעו כשהתשובה תישמר.' : 'מתחבר לצוות הפיתוח…'}
        </p>
      </section>
    );
  }
  const phases = phasesOf(state);
  const running = state.status === 'running';
  // Open: the phase at work, what needs attention, and at the end the download.
  const isOpen = (phase) => manual[phase.id] ?? (phase.status === 'active' || phase.status === 'attention' || (!running && phase.id === 'ship'));
  const toggle = (phase) => setManual((current) => ({ ...current, [phase.id]: !isOpen(phase) }));
  const views = {
    plan: <ArchitectView architect={state.architect} />,
    build: <BuildView state={state} />,
    verify: <VerifyView state={state} />,
    ship: <ShipView state={state} fallbackBundle={bundle} animate={running || connection !== 'closed'} />,
  };
  return (
    <section aria-label="צוות הפיתוח בזמן אמת" className="mt-3 overflow-hidden rounded-2xl border border-line bg-surface">
      <Header state={state} connection={connection} />
      <Stepper phases={phases} />
      <div className="mt-2">
        {phases.map((phase, index) => (
          <Panel key={phase.id} phase={phase} index={index} open={isOpen(phase)} onToggle={() => toggle(phase)}>
            {views[phase.id]}
          </Panel>
        ))}
      </div>
    </section>
  );
}
