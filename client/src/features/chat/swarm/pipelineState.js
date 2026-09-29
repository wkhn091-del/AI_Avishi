/**
 * A development-team run on the client: the same state the server keeps (server/src/services/ai/swarm/runs.js),
 * changed by the same two patches, applied here without mutating so that React sees every change:
 *   merge   fields into the object at a path
 *   upsert  an item into the array at a path, matched by its key
 */
export function applyPatch(state, { op, at = [], value }) {
  const root = { ...state };
  let parent = root;
  for (const part of at.slice(0, -1)) {
    const next = parent[part];
    parent[part] = Array.isArray(next) ? [...next] : { ...(next ?? {}) };
    parent = parent[part];
  }
  const last = at.at(-1);
  if (op === 'merge') {
    if (last === undefined) Object.assign(parent, value);
    else parent[last] = { ...(parent[last] ?? {}), ...value };
  } else if (op === 'upsert') {
    const list = [...(parent[last] ?? [])];
    const index = list.findIndex((item) => item.key === value.key);
    if (index === -1) list.push({ ...value });
    else list[index] = { ...list[index], ...value };
    parent[last] = list;
  }
  return root;
}
export const applyPatches = (state, patches) => patches.reduce(applyPatch, state);

// The colors of the work: blue planning, yellow writing, orange self-correcting, green passing. Whole class
// names, so Tailwind finds them.
export const TONE = Object.freeze({
  plan: { text: 'text-plan', dot: 'bg-plan', soft: 'bg-plan/10', border: 'border-plan/40', rail: 'bg-plan' },
  gen: { text: 'text-gen', dot: 'bg-gen', soft: 'bg-gen/10', border: 'border-gen/50', rail: 'bg-gen' },
  fix: { text: 'text-fix', dot: 'bg-fix', soft: 'bg-fix/10', border: 'border-fix/45', rail: 'bg-fix' },
  pass: { text: 'text-pass', dot: 'bg-pass', soft: 'bg-pass/10', border: 'border-pass/40', rail: 'bg-pass' },
  danger: { text: 'text-danger', dot: 'bg-danger', soft: 'bg-danger/10', border: 'border-danger/40', rail: 'bg-danger' },
  idle: { text: 'text-mist', dot: 'bg-line-strong', soft: 'bg-sunken', border: 'border-line', rail: 'bg-line' },
});

export const shortModel = (label) => String(label ?? '').split(' ')[0];
export const secondsText = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} שניות`;
export const filesText = (count) => (count === 1 ? 'קובץ אחד' : `${count} קבצים`);
const fixing = (state) => state.files.some((file) => file.status === 'fixing');
/** An edit's plan in a few words: "2 קבצים משתנים · קובץ חדש". */
export function changesText(tree = []) {
  const count = (action) => tree.filter((item) => item.kind === 'file' && item.action === action).length;
  const [modify, create, remove] = [count('modify'), count('create'), count('delete')];
  return (
    [
      modify ? (modify === 1 ? 'קובץ אחד משתנה' : `${modify} קבצים משתנים`) : '',
      create ? (create === 1 ? 'קובץ חדש' : `${create} קבצים חדשים`) : '',
      remove ? (remove === 1 ? 'קובץ אחד נמחק' : `${remove} קבצים נמחקים`) : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'שינוי ב-package.json'
  );
}

/** What's happening now, for the header: a word or two and its color. */
export function activityOf(state) {
  if (state.status === 'failed') return { label: 'נכשל', tone: 'danger' };
  if (state.status === 'stopped') return { label: 'נעצר', tone: 'idle' };
  if (state.status === 'done') return state.result?.remaining ? { label: 'הושלם עם בעיות', tone: 'fix' } : { label: 'הושלם', tone: 'pass' };
  if (fixing(state)) return { label: 'מתקן את עצמו', tone: 'fix', pulse: true };
  if (state.phase === 'architect') return { label: 'מתכנן', tone: 'plan', pulse: true };
  if (state.phase === 'build') return { label: `כותב ${state.build.done}/${state.build.total}`, tone: 'gen', pulse: true };
  if (state.phase === 'qa') return { label: 'בודק את הקוד', tone: 'plan', pulse: true };
  if (state.preview?.status === 'starting') return { label: 'מפעיל תצוגה חיה', tone: 'gen', pulse: true };
  if (state.phase === 'sandbox') return { label: `מריץ ב-${state.sandbox.provider}`, tone: 'gen', pulse: true };
  return { label: 'אורז', tone: 'pass', pulse: true };
}

/** The four phases the dashboard shows: their status (waiting, active, done, attention, failed), color and summary. */
export function phasesOf(state) {
  const { architect, build, qa, sandbox, files } = state;
  const stopped = state.status === 'failed' || state.status === 'stopped';
  // An edit (a follow-up on a project) plans changes; a run with a live preview ends with it running.
  const editing = state.mode === 'edit';
  const live = state.preview && state.preview.status !== 'off';
  const loop = files.filter((file) => file.fixPhase && ['flagged', 'fixing', 'fixed', 'broken'].includes(file.status)).length;
  const plan = {
    id: 'plan',
    title: editing ? 'תוכנית השינויים' : 'תוכנית',
    tone: 'plan',
    status: architect.status === 'done' ? 'done' : architect.status === 'failed' ? 'failed' : 'active',
    summary: architect.status === 'done' ? `${editing ? changesText(architect.tree) : filesText(architect.tree.filter((item) => item.kind === 'file').length)} · ${architect.model}` : architect.status === 'failed' ? architect.note : `${architect.model ?? ''} כותב תוכנית${architect.draft.length ? ` · ${filesText(architect.draft.length)} עד עכשיו` : ''}`,
  };
  const writing = {
    id: 'build',
    title: editing ? 'כתיבת השינויים' : 'כתיבה במקביל',
    tone: 'gen',
    status: build.status === 'working' ? 'active' : build.status === 'done' ? 'done' : build.status === 'failed' ? 'failed' : 'waiting',
    summary: build.status === 'waiting' ? `עד ${state.settings.concurrency} קבצים במקביל` : `${build.done}/${build.total} קבצים${build.failed ? ` · ${build.failed} לא נכתבו` : ''}${build.ms ? ` · ${secondsText(build.ms)}` : ''}`,
  };
  const checking = qa.status === 'working' || sandbox.status === 'working' || fixing(state);
  const trouble = qa.status === 'failed' || sandbox.status === 'failed' || sandbox.status === 'unavailable';
  const verify = {
    id: 'verify',
    title: 'בדיקה ותיקון',
    tone: fixing(state) ? 'fix' : trouble ? 'fix' : checking ? (state.phase === 'sandbox' ? 'gen' : 'plan') : 'pass',
    status: qa.status === 'waiting' ? 'waiting' : checking && !stopped ? 'active' : trouble ? 'attention' : qa.status === 'done' ? 'done' : 'waiting',
    summary:
      qa.status === 'waiting'
        ? `קומפיילר, סקירת קוד${sandbox.status === 'off' ? '' : ` והרצה ב-${sandbox.provider}`}`
        : [qa.status === 'working' ? `סבב ${qa.round}` : qa.remaining ? `נותרו ${qa.remaining} בעיות` : 'הקוד נקי', loop ? `${filesText(loop)} בתיקון עצמי` : '', sandbox.summary || (sandbox.status === 'working' ? `מריץ ב-${sandbox.provider}` : '')].filter(Boolean).join(' · '),
  };
  const ship = {
    id: 'ship',
    title: live ? (editing ? 'עדכון התצוגה' : 'תצוגה חיה') : 'אריזה',
    tone: 'pass',
    status: state.package.status === 'done' ? 'done' : state.package.status === 'failed' ? 'failed' : state.package.status === 'working' && !stopped ? 'active' : 'waiting',
    summary:
      live && state.preview.status === 'live'
        ? `פעילה · גרסה ${state.preview.version ?? 1}${state.package.bundle ? ' · ZIP' : ''}`
        : live && state.preview.status === 'starting'
          ? 'מפעיל את שרת הפיתוח…'
          : state.package.bundle
            ? `ZIP · ${filesText(state.package.bundle.files ?? 0)}`
            : state.package.status === 'working'
              ? 'אורז ל-ZIP…'
              : live
                ? 'תצוגה חיה, קוד ו-ZIP'
                : 'ZIP להורדה',
  };
  if (stopped) for (const phase of [plan, writing, verify, ship]) if (phase.status === 'active') phase.status = 'failed';
  return [plan, writing, verify, ship];
}
