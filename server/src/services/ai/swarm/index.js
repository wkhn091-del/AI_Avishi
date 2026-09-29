/**
 * The swarm: Stash's development team for complex coding requests.
 *
 *   1. The architect (GPT-6 Sol; Opus 5.5 if it fails) plans the project as a JSON blueprint and
 *      writes no code. The server validates it, and the architect fixes what's wrong, once.
 *   2. Micro-agents write every file in parallel, each from the blueprint alone: the file's spec,
 *      the shared contracts, and the exact interfaces of the files it imports. Two lanes on
 *      different providers (DeepSeek Flash and Gemini Flash) share the files, PIPELINE_CONCURRENCY
 *      calls at a time.
 *   3. The QA compiler checks the codebase: its deterministic checks (checks.js) on every file, and
 *      the reviewer (Sonnet 5) on every file that's new or changed. Files with problems go back to
 *      a micro-agent with the error log, up to PIPELINE_QA_ROUNDS times; a fix that adds syntax
 *      errors or cuts the file down is not kept. What's still wrong after that is reported, in the
 *      answer and in QA_REPORT.md.
 *
 * The answer is Markdown with every file in its own code block, so the ZIP, follow-up questions
 * and rebuilding an expired ZIP work as for any other answer.
 */
import { config } from '../../../config.js';
import { AiError, streamChat } from '../llmClient.js';
import { withTags } from '../usageMeter.js';
import { architectRules, languageOf, manifestFiles, parseBlueprint, validateBlueprint } from './blueprint.js';
import { checkProject, syntaxErrors } from './checks.js';
import { fenceFor, reviewFiles, triageFailure, writeFile } from './agents.js';
import { SandboxError, openSandbox, sandboxFor } from './sandbox/index.js';
import { STEP_LABELS, stepsSummary, verifyProject } from './verify.js';
import { createRun } from './runs.js';
import { planPatch } from './patch.js';
import { adoptPreview, borrowPreview, dropPreview } from './preview.js';

const TRUNCATED = /^(length|max_tokens|max_output_tokens)$/i;
const BLUEPRINT_TOKENS = 32_768;
const withoutMedia = (messages) => messages.map((message) => (message.media ? { role: message.role, content: message.content } : message));
const abortError = () => Object.assign(new Error('The request was stopped.'), { name: 'AbortError' });
const linesOf = (code) => code.split('\n').length - (code.endsWith('\n') ? 1 : 0);
// The paths in a blueprint that's still being written: the file tree while it's planned.
const DRAFT_PATH = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
function pathsIn(text) {
  const paths = [];
  for (const match of text.matchAll(DRAFT_PATH)) {
    try {
      const path = JSON.parse(`"${match[1]}"`);
      if (path && !paths.includes(path)) paths.push(path);
    } catch {
      // half an escape at the end of what's arrived so far
    }
  }
  return paths.slice(0, 400);
}
/** What a person can read on a file's card: what's wrong, without the sandbox's folder. */
function snippetOf(issue) {
  if (!issue?.message) return '';
  const lines = issue.message.split('\n').map((line) => line.trim()).filter(Boolean);
  const after = lines[0].includes(' failed: ') ? lines[0].slice(lines[0].indexOf(' failed: ') + 9) : '';
  const telling = after || lines.find((line, index) => index > 0 && /\bERROR\b|Error:|error TS\d|AssertionError|not ok|is not |Cannot |does not provide|Expected/.test(line)) || lines[0];
  const text = telling.replace(/(?:file:\/\/)?\/home\/(?:node|user)\/app\//g, '').replace(/^\[[\w:-]+\]\s*/, '');
  return text.slice(0, 180);
}
// A file card's error: the snippet, and the line it's on (the dashboard labels it).
const issueOf = (issue) => ({ snippet: snippetOf(issue), line: issue?.line ?? null });
/** The request an edit plans for: the conversation's last message from the person. */
function requestOf(conversation) {
  const last = [...conversation].reverse().find((message) => message.role === 'user');
  if (typeof last?.content === 'string') return last.content;
  return Array.isArray(last?.content) ? last.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : '';
}
/** An edit's changes in a few words: "2 קבצים משתנים · קובץ חדש". */
function changesText(patch) {
  const count = (action) => patch.changes.filter((change) => change.action === action).length;
  const [modify, create, remove, packages] = [count('modify'), count('create'), count('delete'), patch.packages.length];
  return (
    [
      modify ? (modify === 1 ? 'קובץ אחד משתנה' : `${modify} קבצים משתנים`) : '',
      create ? (create === 1 ? 'קובץ חדש' : `${create} קבצים חדשים`) : '',
      remove ? (remove === 1 ? 'קובץ אחד נמחק' : `${remove} קבצים נמחקים`) : '',
      packages ? (packages === 1 ? 'package.json משתנה' : `${packages} קובצי package.json משתנים`) : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'בלי שינויים בקבצים'
  );
}
// Hebrew counts: "קובץ אחד" and "בעיה אחת", not "1 קבצים".
const filesText = (count) => (count === 1 ? 'קובץ אחד' : `${count} קבצים`);
const issuesText = (count) => (count === 1 ? 'בעיה אחת' : `${count} בעיות`);
const roundsText = (count) => (count === 1 ? 'סבב תיקון אחד' : `${count} סבבי תיקון`);

/** Runs `work` on every item, at most `limit` at a time; nothing new starts once `signal` aborts. */
export async function pool(items, limit, work, signal) {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next;
      next += 1;
      await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

async function planBlueprint({ architects, system, conversation, signal, effort, maxFiles, onNote, onDraft = () => {} }) {
  const rules = `${system}\n\n${architectRules({ maxFiles })}`;
  const failures = [];
  for (const [index, who] of architects.entries()) {
    if (signal?.aborted) break;
    if (index) onNote(`${architects[index - 1].label} נכשל, ולכן ${who.label} מתכנן`, who);
    const messages = who.vision ? conversation : withoutMedia(conversation);
    let written = 0;
    let draft = '';
    let drafted = 0;
    const call = (history) =>
      withTags({ role: 'architect' }, () =>
        streamChat({
          provider: who.provider,
          model: who.model,
          system: rules,
          messages: history,
          json: true,
          params: { maxTokens: BLUEPRINT_TOKENS, maxOutput: who.maxOutput, effort: effort ?? 'medium' },
          signal,
          onDelta: (delta) => {
            if (delta.type !== 'text') return;
            const before = written;
            written += delta.text.length;
            draft += delta.text;
            if (Math.floor(written / 4_000) > Math.floor(before / 4_000)) onNote(`כותב את התוכנית (${Math.round(written / 1_000)} אלף תווים)`);
            // The file tree while it's being planned: the paths in the JSON so far, a few times a second.
            if (Date.now() - drafted > 400) {
              drafted = Date.now();
              onDraft(pathsIn(draft), written);
            }
          },
        }),
      );
    try {
      let result = await call(messages);
      let parsed = parseBlueprint(result.text);
      let checked = parsed.data ? validateBlueprint(parsed.data, { maxFiles }) : { blueprint: null, errors: [parsed.error] };
      let repaired = false;
      if (!checked.blueprint) {
        onNote(`מתקן ${issuesText(checked.errors.length)} בתוכנית`);
        const cut = TRUNCATED.test(result.finishReason ?? '') ? 'Your blueprint was cut off by the output limit: write a more compact one (shorter specs, fewer files) that still follows every rule.\n\n' : '';
        written = 0;
        draft = '';
        result = await call([
          ...messages,
          { role: 'assistant', content: result.text.slice(0, 120_000) || '{}' },
          { role: 'user', content: `${cut}The blueprint has these problems:\n${checked.errors.map((error) => `- ${error}`).join('\n')}\n\nReturn the complete corrected blueprint as one JSON object.` },
        ]);
        parsed = parseBlueprint(result.text);
        checked = parsed.data ? validateBlueprint(parsed.data, { maxFiles }) : { blueprint: null, errors: [parsed.error] };
        repaired = true;
      }
      if (checked.blueprint) return { blueprint: checked.blueprint, model: who, repaired, fellBack: index > 0 };
      failures.push(`${who.label}: ${checked.errors.slice(0, 3).join(' ')}`);
    } catch (error) {
      if (signal?.aborted) break;
      failures.push(`${who.label}: ${error.log ?? error.message}`);
      console.warn(`[swarm] Blueprint with ${who.label} failed: ${error.log ?? error.message}`);
    }
  }
  if (signal?.aborted) throw abortError();
  throw new AiError('הארכיטקט לא הצליח לבנות תוכנית תקינה לפרויקט. נסו לנסח את הבקשה מחדש, או לפצל אותה לחלקים.', {
    code: 'AI_BLUEPRINT_FAILED',
    log: `No valid blueprint: ${failures.join(' | ')}`,
    detail: failures.join('\n'),
  });
}

/**
 * @param {object} options
 * @param {Array<object>} options.team  the roles from teamFor(): architect, builder, review
 * @param {Function} options.toTarget  a catalog entry → the target a call is made with
 * @param {object} [options.credits]  the turn's credit hold (services/credits.js): the team resizes it to its files
 * @param {object} [options.user]  who asked (req.user): whether the project is built and run in the sandbox
 * @param {object} [options.edit]  a follow-up on a project, `{ version, blueprint, files }`: the architect plans a patch
 * @param {string} [options.artifactId]  the project's id: its live preview's
 * @returns {Promise<{ text: string, team: Array<object>, qa?: object, artifact?: object }>}
 */
export async function runSwarm({ team, system, conversation, emit, signal, route, effort, toTarget, credits = null, user = null, edit = null, artifactId = null }) {
  const settings = config.chat.pipeline;
  const modelsOf = (id) => (team.find((role) => role.id === id)?.models ?? []).map(toTarget);
  const architects = modelsOf('architect');
  const builders = modelsOf('builder');
  const reviewers = modelsOf('review');
  // Two lanes on different providers share the files, so one provider's rate limit doesn't hold up everything.
  const lanes = [builders[0], builders.find((who) => who.provider !== builders[0].provider)].filter(Boolean);
  const modelsFor = (index) => {
    const lane = lanes[index % lanes.length];
    return [lane, ...builders.filter((who) => who !== lane)];
  };
  const lanesLabel = lanes.map((who) => who.label).join(' + ');
  const sandbox = sandboxFor(user);
  // A run whose project ran in the sandbox leaves it up as the project's live preview (preview.js).
  const previewsOn = Boolean(sandbox && artifactId && config.sandbox.preview.enabled);
  // The live dashboard's run: every step below is also a patch to its state (runs.js), streamed over SSE.
  const live = createRun({
    ownerId: user?.id ?? null,
    settings: { mode: edit ? 'edit' : 'build', artifact: artifactId ? { id: artifactId, version: edit ? edit.version + 1 : 1 } : null, preview: previewsOn, concurrency: settings.concurrency, qaRounds: settings.qaRounds, sandboxRounds: sandbox ? config.sandbox.rounds : 0, sandbox: sandbox?.label ?? null, maxFiles: settings.maxFiles, models: { architect: architects[0].label, builders: lanes.map((who) => who.label), reviewer: reviewers[0]?.label ?? null } },
  });
  emit({ type: 'pipeline', runId: live.id });
  const merge = (at, value) => ({ op: 'merge', at, value });
  const fileOp = (path, value) => ({ op: 'upsert', at: ['files'], value: { key: path, path, ...value } });
  const stepOp = (step, value) => ({ op: 'upsert', at: ['sandbox', 'steps'], value: { key: `${step.id}:${step.dir}`, id: step.id, dir: step.dir, label: step.label, ...value } });
  const stepStatus = (step) => (step.cached ? 'cached' : step.skipped ? 'skipped' : step.needsSetup ? 'setup' : step.ok ? 'passed' : 'failed');

  // The timeline, step by step. The fixes come last: while files are fixed, the step they fix stays open above it.
  const rows = [
    { role: 'architect', title: 'תוכנית (Blueprint)', doing: 'מתכנן את הארכיטקטורה ואת המפרט של כל קובץ', model: architects[0].label, state: 'waiting' },
    { role: 'builder', title: 'כתיבת הקבצים', doing: 'כותבים את הקבצים במקביל', model: lanesLabel, state: 'waiting' },
    { role: 'review', title: 'בדיקת QA', doing: 'בודק תחביר, ייבוא, משתנים ומימושים חלקיים', model: reviewers[0] ? `${reviewers[0].label} + קומפיילר` : 'קומפיילר', state: 'waiting' },
    ...(sandbox ? [{ role: 'sandbox', title: 'בנייה והרצה', doing: 'מתקין, בונה ומריץ את הפרויקט בסביבה מבודדת', model: sandbox.label, state: 'waiting' }] : []),
    { role: 'fix', title: 'תיקונים אוטומטיים', doing: 'מתקנים את הקבצים שנמצאו בהם בעיות', model: lanesLabel, state: 'waiting' },
  ];
  const row = Object.fromEntries(rows.map((item) => [item.role, item]));
  const finished = (item) => item.state === 'done' || item.state === 'failed';
  // The fixes' step is left out at the end when nothing needed fixing.
  const snapshot = () =>
    rows
      .filter((item) => item.role !== 'fix' || item.state !== 'waiting' || !rows.every((other) => other.role === 'fix' || finished(other)))
      .map((item) => ({ ...item, ...(item.progress ? { progress: { ...item.progress } } : {}) }));
  let sentAt = 0;
  let timer = null;
  const send = () => {
    timer = null;
    sentAt = Date.now();
    emit({ type: 'team', team: snapshot() });
  };
  // Every change is shown, but at most four times a second (a file finishing is a change).
  const report = (now = false) => {
    if (now || Date.now() - sentAt >= 250) {
      clearTimeout(timer);
      send();
    } else timer ??= setTimeout(send, 250 - (Date.now() - sentAt));
  };
  const finish = () => {
    clearTimeout(timer);
    send();
  };
  let answer = '';
  const say = (text) => {
    answer += text;
    emit({ type: 'text', text });
  };
  const stopped = () => {
    for (const item of rows) if (item.state === 'working') Object.assign(item, { state: 'failed', note: 'נעצר' });
    finish();
    live.finish('stopped');
    return { text: answer, team: snapshot(), runId: live.id };
  };

  // 1. The blueprint.
  let started = Date.now();
  Object.assign(row.architect, { state: 'working' });
  report(true);
  let blueprint;
  let patch = null;
  try {
    const onNote = (note, who) => {
      row.architect.note = note;
      if (who) row.architect.model = who.label;
      report();
      live.patch(merge(['architect'], { note, ...(who ? { model: who.label } : {}) }));
    };
    // A follow-up on a project: the architect plans a patch on its blueprint instead of a new project (patch.js).
    const plan = edit
      ? await planPatch({ architects, system, request: requestOf(conversation), blueprint: edit.blueprint, files: edit.files, signal, effort, maxFiles: settings.maxFiles, onNote })
      : await planBlueprint({
          architects,
          system,
          conversation,
          signal,
          effort,
          maxFiles: settings.maxFiles,
          onNote,
          onDraft: (paths, chars) => live.patch(merge(['architect'], { draft: paths, chars })),
        });
    blueprint = plan.blueprint;
    patch = plan.patch ?? null;
    Object.assign(row.architect, {
      state: 'done',
      model: plan.model.label,
      ms: Date.now() - started,
      note: [
        patch ? changesText(patch) : filesText(blueprint.files.length),
        patch ? '' : blueprint.stack.slice(0, 4).join(', '),
        plan.repaired ? 'תוקנה אחרי בדיקה' : '',
        plan.fellBack ? `${architects[0].label} נכשל, ולכן ${plan.model.label} תכנן` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    });
  } catch (error) {
    if (signal?.aborted) return stopped();
    Object.assign(row.architect, { state: 'failed', ms: Date.now() - started, note: error.message });
    finish();
    live.patch(merge(['architect'], { status: 'failed', note: error.message, ms: Date.now() - started }));
    live.finish('failed', { error: error.message });
    throw error;
  }
  report(true);
  // What the writers write: every file of a new project, or what an edit creates and modifies.
  const planned = patch ? patch.changes.filter((change) => change.action !== 'delete').map((change) => blueprint.files.find((file) => file.path === change.path)).filter(Boolean) : blueprint.files;
  const deleted = new Set(patch ? patch.changes.filter((change) => change.action === 'delete').map((change) => change.path) : []);
  live.patch(
    merge(['architect'], {
      status: 'done',
      model: row.architect.model,
      note: row.architect.note,
      ms: row.architect.ms,
      draft: [],
      title: blueprint.title,
      summary: patch ? patch.summary || blueprint.summary : blueprint.summary,
      stack: blueprint.stack,
      tree: patch
        ? [...patch.packages.map((path) => ({ path, purpose: 'package.json', kind: 'manifest', action: 'modify' })), ...patch.changes.map((change) => ({ path: change.path, purpose: change.purpose, kind: 'file', action: change.action }))]
        : [...blueprint.packages.map((pkg) => ({ path: pkg.path, purpose: 'package.json', kind: 'manifest' })), ...blueprint.files.map((file) => ({ path: file.path, purpose: file.purpose, kind: 'file' }))],
    }),
    merge(['build'], { total: planned.length }),
    merge([], { phase: 'build' }),
    ...planned.map((file) => fileOp(file.path, { purpose: file.purpose, status: 'queued' })),
  );
  const manifests = blueprint.packages.length === 1 ? ' ו-package.json' : blueprint.packages.length ? ` ו-${blueprint.packages.length} קובצי package.json` : '';
  if (patch) say(`## ${blueprint.title}: עדכון\n\n${patch.summary || 'השינוי שביקשת.'}\n\n**השינויים:** ${changesText(patch)}.\n`);
  else say(`## ${blueprint.title}\n\n${blueprint.summary}\n\n${blueprint.stack.length ? `**טכנולוגיות:** ${blueprint.stack.join(' · ')}\n\n` : ''}**מבנה:** ${filesText(blueprint.files.length)}${manifests}.\n`);
  // Credits: the team costs CREDITS_PER_FILE for each file of the blueprint (instead of an answer's price),
  // reserved before any file is written; the chat gives it back if the work fails or is stopped.
  if (credits) {
    try {
      // An edit costs a credit for each file it writes (at least one).
      const charged = patch ? Math.max(1, planned.length) : blueprint.files.length;
      await credits.resize(charged * config.credits.perFile, { what: patch ? `לשינוי הזה (${filesText(charged)})` : `לפרויקט הזה (${filesText(charged)})` });
    } catch (error) {
      Object.assign(row.builder, { state: 'failed', note: 'אין מספיק קרדיטים לכתיבת הקבצים' });
      finish();
      live.patch(merge(['build'], { status: 'failed' }));
      live.finish('failed', { error: error.message });
      throw error;
    }
  }

  // 2. Every file, in parallel (an edit: the files it creates and modifies).
  const plannedPaths = new Set(blueprint.files.map((file) => file.path));
  const byPath = new Map(blueprint.files.map((file) => [file.path, file]));
  // An edit starts from the project as it is, without what it deletes. Its package.json files stay byte for byte
  // unless the patch changes them (a saved blueprint comes back from the database with its keys reordered).
  const files = new Map(edit ? [...edit.files].filter(([path]) => !deleted.has(path)) : []);
  for (const item of manifestFiles(blueprint)) if (!edit || !files.has(item.path) || patch.packages.includes(item.path)) files.set(item.path, item.content);
  started = Date.now();
  Object.assign(row.builder, { state: 'working', progress: { done: 0, total: planned.length } });
  report(true);
  live.patch(merge(['build'], { status: 'working', total: planned.length, active: 0 }));
  let unwritten = 0;
  let active = 0;
  // An edit's writer gets the file as it is and the architect's instructions.
  const changeFor = (path) => {
    const change = patch?.changes.find((item) => item.path === path);
    return change ? { code: edit.files.get(path) ?? null, instructions: change.instructions } : null;
  };
  await pool(
    planned,
    settings.concurrency,
    async (file, index) => {
      const models = modelsFor(index);
      const began = Date.now();
      active += 1;
      live.patch(fileOp(file.path, { status: 'writing', model: models[0].label }), merge(['build'], { active }));
      const result = await writeFile({ blueprint, file, models, maxTokens: settings.fileTokens, signal, change: patch ? changeFor(file.path) : null });
      active -= 1;
      if (result.code) files.set(file.path, result.code);
      else unwritten += 1;
      row.builder.progress.done += 1;
      report();
      live.patch(
        fileOp(file.path, result.code ? { status: 'written', model: result.model.label, lines: linesOf(result.code), ms: Date.now() - began } : { status: 'failed', ms: Date.now() - began }),
        merge(['build'], { active, done: row.builder.progress.done - unwritten, failed: unwritten }),
      );
    },
    signal,
  );
  if (signal?.aborted) return stopped();
  if (planned.length && unwritten === planned.length) {
    Object.assign(row.builder, { state: 'failed', ms: Date.now() - started, note: 'אף קובץ לא נכתב' });
    finish();
    live.patch(merge(['build'], { status: 'failed', ms: Date.now() - started }));
    live.finish('failed', { error: 'סוכני הקבצים לא הצליחו לכתוב את הקבצים.' });
    throw new AiError('סוכני הקבצים לא הצליחו לכתוב את הקבצים. נסו שוב בעוד רגע.', { code: 'AI_SWARM_FAILED', log: 'Every micro-agent failed.' });
  }
  Object.assign(row.builder, { state: 'done', ms: Date.now() - started, note: unwritten ? `${unwritten === 1 ? 'קובץ אחד לא נכתב' : `${unwritten} קבצים לא נכתבו`}, והבדיקה תחזיר ${unwritten === 1 ? 'אותו' : 'אותם'} לכתיבה` : planned.length === 1 ? 'הקובץ נכתב' : `${planned.length} הקבצים נכתבו` });
  report(true);
  live.patch(merge(['build'], { status: 'done', ms: row.builder.ms }));

  const qa = { rounds: 0, fixed: new Set(), added: [], reviewer: null, reviewFailed: false, dropped: 0, remaining: new Map() };
  /**
   * Sends broken files back to the micro-agents with their error log. A fix is kept unless it adds
   * syntax errors or cuts a working file down to an excerpt. Resolves to the files that changed.
   */
  // How many times each file has been sent back, per phase: the dashboard's "attempt 2 of 3".
  const attempts = { qa: new Map(), sandbox: new Map() };
  const fixRound = async (broken, label, offset, phase = 'qa', max = settings.qaRounds) => {
    const before = checkProject(files, blueprint).issues;
    Object.assign(row.fix, { state: 'working', progress: { done: 0, total: broken.length }, note: label });
    report(true);
    const fixing = Date.now();
    const candidates = new Map(files);
    await pool(
      broken,
      settings.concurrency,
      async ([file, list], index) => {
        // Each round starts on the other lane, so a file that one model can't fix gets another model.
        const plan = byPath.get(file);
        const attempt = (attempts[phase].get(file) ?? 0) + 1;
        attempts[phase].set(file, attempt);
        live.patch(fileOp(file, { status: 'fixing', attempt, maxAttempts: max, fixPhase: phase, ...issueOf(list[0]), issues: list.length, model: modelsFor(index + offset)[0].label }));
        const result = plan ? await writeFile({ blueprint, file: plan, models: modelsFor(index + offset), maxTokens: settings.fileTokens, signal, fix: files.has(file) ? { code: files.get(file), issues: list } : null }) : { code: null };
        if (result.code) candidates.set(file, result.code);
        row.fix.progress.done += 1;
        report();
      },
      signal,
    );
    const changed = new Set();
    if (signal?.aborted) return changed;
    const after = checkProject(candidates, blueprint).issues;
    for (const [file] of broken) {
      const next = candidates.get(file);
      const previous = files.get(file);
      if (!next || next === previous) continue;
      const errorsBefore = syntaxErrors(before.get(file));
      if (previous && (syntaxErrors(after.get(file)) > errorsBefore || (!errorsBefore && next.length < previous.length * 0.4))) continue;
      files.set(file, next);
      changed.add(file);
      qa.fixed.add(file);
    }
    live.patch(...broken.map(([file]) => fileOp(file, { status: changed.has(file) ? 'fixed' : 'flagged' })));
    const outcome = broken.length === 1 ? (changed.size ? 'הקובץ תוקן' : 'הקובץ לא תוקן') : `תוקנו ${changed.size} מתוך ${broken.length} קבצים`;
    Object.assign(row.fix, { state: 'done', ms: (row.fix.ms ?? 0) + (Date.now() - fixing), note: `${label}: ${outcome}` });
    report(true);
    return changed;
  };

  // 3. The QA compiler, and back to the agents with the error log.
  started = Date.now();
  Object.assign(row.review, { state: 'working', note: 'בודק את כל הקבצים' });
  report(true);
  live.patch(merge(['qa'], { status: 'working', round: 1, note: 'בודק את כל הקבצים' }), merge([], { phase: 'qa' }));
  let scope = new Set(plannedPaths);
  if (edit) {
    // An edit's reviewer reads what it wrote, and the files that import those (or what it deleted).
    const { dependents } = checkProject(files, blueprint);
    const touched = [...planned.map((file) => file.path), ...deleted];
    scope = new Set([...touched, ...touched.flatMap((file) => [...(dependents.get(file) ?? [])])].filter((file) => files.has(file)));
  }
  let flagged = new Set();
  for (let round = 1; ; round += 1) {
    if (signal?.aborted) return stopped();
    let check = checkProject(files, blueprint);
    if (check.missingPackages.size) {
      // A package a file imports that the plan forgot is added, rather than sending the file back.
      for (const [manifest, names] of check.missingPackages) {
        const pkg = blueprint.packages.find((item) => item.path === manifest);
        for (const name of names) {
          pkg.dependencies[name] = 'latest';
          qa.added.push(name);
        }
        pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
      }
      for (const item of manifestFiles(blueprint)) files.set(item.path, item.content);
      check = checkProject(files, blueprint);
    }
    const issues = new Map([...check.issues].filter(([file, list]) => list.length && plannedPaths.has(file)));
    // The reviewer reads what's new or changed; a file that doesn't parse gets the compiler's fix first.
    const toReview = new Set([...scope].filter((file) => files.has(file) && !syntaxErrors(issues.get(file))));
    if (reviewers.length && toReview.size) {
      row.review.note = round === 1 ? `${reviewers[0].label} סוקר ${toReview.size} קבצים` : `סבב ${round}: סוקר ${toReview.size} קבצים שהשתנו`;
      report();
      const notes = qa.added.length ? `# Packages the server added to package.json (as "latest") because files import them\n${[...new Set(qa.added)].join(', ')}\nReport any that don't exist on npm or are imported wrongly.` : '';
      const review = await reviewFiles({ blueprint, files, only: toReview, models: reviewers, signal, notes });
      if (signal?.aborted) return stopped();
      qa.reviewer ??= review.model;
      qa.dropped += review.dropped;
      if (review.failed) qa.reviewFailed = true;
      for (const [file, list] of review.issues) issues.set(file, [...(issues.get(file) ?? []), ...list]);
    }
    const count = [...issues.values()].reduce((sum, list) => sum + list.length, 0);
    // The dashboard: this round's findings on their files; a file flagged before and clean now is fixed.
    live.patch(
      merge(['qa'], { round, issues: count, flagged: issues.size, note: issues.size ? `סבב ${round}: ${issuesText(count)}` : 'לא נמצאו בעיות' }),
      ...[...flagged].filter((file) => !issues.has(file)).map((file) => fileOp(file, { status: qa.fixed.has(file) ? 'fixed' : 'written' })),
      ...[...issues].map(([file, list]) => fileOp(file, { status: 'flagged', issues: list.length, fixPhase: 'qa', ...issueOf(list[0]) })),
    );
    flagged = new Set(issues.keys());
    if (!issues.size || round > settings.qaRounds) {
      qa.remaining = issues;
      break;
    }
    qa.rounds = round;
    const broken = [...issues];
    row.review.note = `סבב ${round}: ${issuesText(count)} ב${broken.length === 1 ? 'קובץ אחד' : `-${broken.length} קבצים`}`;
    const changed = await fixRound(broken, `סבב ${round} מתוך ${settings.qaRounds}`, round);
    if (signal?.aborted) return stopped();
    // Next round the reviewer reads what changed, and the files that import it.
    const { dependents } = checkProject(files, blueprint);
    scope = new Set([...changed, ...[...changed].flatMap((file) => [...(dependents.get(file) ?? [])])].filter((file) => plannedPaths.has(file)));
  }
  const staticLeft = [...qa.remaining.values()].reduce((sum, list) => sum + list.length, 0);
  Object.assign(row.review, {
    state: staticLeft ? 'failed' : 'done',
    ms: Date.now() - started,
    note: staticLeft ? `${staticLeft === 1 ? 'נותרה' : 'נותרו'} ${issuesText(staticLeft)} ב${qa.remaining.size === 1 ? 'קובץ אחד' : `-${qa.remaining.size} קבצים`}` : qa.rounds ? `כל הבדיקות עברו אחרי ${roundsText(qa.rounds)}` : 'כל הבדיקות עברו',
  });
  report(true);
  live.patch(merge(['qa'], { status: staticLeft ? 'failed' : 'done', remaining: staticLeft, note: row.review.note, ms: row.review.ms }));

  let keep = null; // the sandbox that becomes the project's live preview
  // 4. The sandbox: install, build, type-check, test and start the project for real; its errors go back to the agents.
  const run = { label: sandbox?.label ?? null, ran: false, ok: false, summary: '', reason: '', notes: [], pinned: [], removed: [], rounds: 0, issues: new Map(), unfixable: [], changed: false };
  if (row.sandbox) {
    started = Date.now();
    if (!blueprint.packages.length) {
      Object.assign(row.sandbox, { state: 'done', ms: 0, note: 'אין package.json, ולכן אין מה להתקין או להריץ' });
      live.patch(merge(['sandbox'], { status: 'skipped', reason: 'אין package.json, ולכן אין מה להתקין או להריץ' }));
    }
    else {
      let box = null;
      let installedHash = null;
      let lent = false;
      Object.assign(row.sandbox, { state: 'working', note: 'מכין סביבה מבודדת' });
      live.patch(merge(['sandbox'], { status: 'working' }), merge([], { phase: 'sandbox' }));
      report(true);
      try {
        // An edit updates its live preview's sandbox (no install when package.json didn't change).
        const borrowed = edit && previewsOn ? await borrowPreview(artifactId, user?.id ?? null) : null;
        if (borrowed) {
          ({ box, installedHash } = borrowed);
          lent = true;
          if (deleted.size) await box.removeFiles([...deleted]);
        } else box = await openSandbox({ signal });
        await box.writeFiles(files);
        for (let round = 1; ; round += 1) {
          live.patch(merge(['sandbox'], { round }));
          const result = await verifyProject({
            box,
            files,
            blueprint,
            settings: config.sandbox,
            installedHash,
            signal,
            onStep: ({ done, total, step }) => {
              Object.assign(row.sandbox, { progress: { done, total }, note: `${step.label}${step.dir ? ` (${step.dir})` : ''}` });
              report();
              live.patch(stepOp(step, { status: 'running', round }));
            },
            onStepDone: (step) => live.patch(stepOp(step, { status: stepStatus(step), ms: step.ms ?? 0, counts: step.counts ?? null, timedOut: Boolean(step.timedOut), round })),
            triage: reviewers.length ? ({ step, log, named }) => triageFailure({ blueprint, files, step, log, named, models: reviewers, signal }) : null,
          });
          if (signal?.aborted) return stopped();
          installedHash = result.installedHash;
          Object.assign(run, { ran: true, ok: result.ok, summary: stepsSummary(result.steps), issues: result.issues, unfixable: result.unfixable });
          for (const [field, values] of [['notes', result.notes], ['pinned', result.pinned], ['removed', result.removed]]) run[field] = [...new Set([...run[field], ...values])];
          const fixable = [...result.issues].filter(([file]) => byPath.has(file));
          live.patch(merge(['sandbox'], { summary: run.summary }), ...fixable.map(([file, list]) => fileOp(file, { status: 'flagged', issues: list.length, fixPhase: 'sandbox', ...issueOf(list[0]) })));
          if (result.ok || !fixable.length || round > config.sandbox.rounds) break;
          run.rounds = round;
          row.sandbox.note = `הרצה ${round}: ${run.summary}`;
          const changed = await fixRound(fixable, `הרצה ${round} מתוך ${config.sandbox.rounds}`, round + settings.qaRounds, 'sandbox', config.sandbox.rounds);
          if (signal?.aborted) return stopped();
          if (!changed.size) break; // the same code would fail the same way
          run.changed = true;
          await box.writeFiles(new Map([...changed].map((file) => [file, files.get(file)])));
        }
      } catch (error) {
        if (signal?.aborted) return stopped();
        run.reason = error instanceof SandboxError ? error.message : 'אירעה שגיאה לא צפויה בסביבה המבודדת.';
        console.warn(`[swarm] Sandbox: ${error.log ?? error.message}`);
      } finally {
        // A project that ran keeps its sandbox as the live preview; otherwise the sandbox is closed.
        if (box && previewsOn && run.ran && !signal?.aborted) keep = { box, installedHash };
        else if (lent) await dropPreview(artifactId);
        else await box?.close();
      }
      Object.assign(row.sandbox, { state: run.ran && run.ok ? 'done' : 'failed', ms: Date.now() - started, note: run.reason || run.summary || 'לא הורץ', progress: undefined });
      live.patch(merge(['sandbox'], { status: run.ran && run.ok ? 'done' : run.reason ? 'unavailable' : run.ran ? 'failed' : 'skipped', summary: run.summary, reason: run.reason, pinned: run.pinned, notes: run.notes, ms: row.sandbox.ms }));
    }
    report(true);
  }
  // The live preview: the sandbox stays up with the project's dev server (preview.js).
  let preview = null;
  if (keep) {
    live.patch(merge(['preview'], { status: 'starting', provider: keep.box.label }));
    try {
      preview = await adoptPreview({ id: artifactId, ownerId: user?.id ?? null, box: keep.box, blueprint, installedHash: keep.installedHash, version: edit ? edit.version + 1 : 1, signal });
    } catch (error) {
      if (signal?.aborted) return stopped();
      preview = { status: 'failed', reason: error.message };
    }
    live.patch(merge(['preview'], preview));
  } else if (previewsOn) {
    const reason = run.reason || (blueprint.packages.length ? 'הפרויקט לא הורץ בסביבה המבודדת.' : 'אין בפרויקט package.json, ולכן אין שרת פיתוח להציג.');
    live.patch(merge(['preview'], { status: 'unavailable', reason }));
  }
  // What's left: the static checks again if the sandbox's rounds changed files, and what the sandbox still found.
  if (run.changed) {
    const recheck = checkProject(files, blueprint).issues;
    for (const [file, list] of [...qa.remaining]) {
      const kept = list.filter((issue) => issue.source !== 'compiler');
      if (kept.length) qa.remaining.set(file, kept);
      else qa.remaining.delete(file);
    }
    for (const [file, list] of recheck) if (plannedPaths.has(file) && list.length) qa.remaining.set(file, [...(qa.remaining.get(file) ?? []), ...list]);
  }
  if (run.ran && !run.ok) for (const [file, list] of run.issues) qa.remaining.set(file, [...(qa.remaining.get(file) ?? []), ...list]);
  const unfixable = run.ran && !run.ok ? run.unfixable : [];
  const remaining = [...qa.remaining.values()].reduce((sum, list) => sum + list.length, 0) + unfixable.length;
  const affected = qa.remaining.size + (unfixable.length ? 1 : 0);
  finish();
  live.patch(
    ...[...qa.remaining].map(([file, list]) => fileOp(file, { status: 'broken', issues: list.length, ...issueOf(list[0]) })),
    merge(['result'], { remaining, fixed: qa.fixed.size, rounds: qa.rounds + run.rounds }),
    merge(['package'], { status: 'working' }),
    merge([], { phase: 'package' }),
  );

  // 5. The answer: the QA result, how to run it, and every file.
  const checked = 'תחביר, ייבוא וייצוא בין הקבצים, חבילות, משתנים לא מוגדרים ומימושים חלקיים';
  const rounds = qa.rounds + run.rounds;
  const verdict = remaining
    ? `⚠️ אחרי ${roundsText(rounds)} ${remaining === 1 ? 'נותרה' : 'נותרו'} ${issuesText(remaining)} ב${affected === 1 ? 'קובץ אחד' : `-${affected} קבצים`}. ${remaining === 1 ? 'היא מפורטת' : 'הן מפורטות'} בקובץ QA_REPORT.md בסוף התשובה.`
    : `✓ כל הבדיקות עברו: ${checked}${qa.reviewer ? `, וסקירת קוד של ${qa.reviewer.label}` : ''}.`;
  const sandboxLine = !row.sandbox
    ? ''
    : run.reason
      ? `ההרצה בסביבה המבודדת (${run.label}) לא התאפשרה: ${run.reason}`
      : !run.ran
        ? 'אין package.json, ולכן לא היה מה להתקין או להריץ בסביבה המבודדת.'
        : run.ok
          ? `✓ הפרויקט הותקן, נבנה והורץ בסביבה מבודדת (${run.label}): ${run.summary}.`
          : `⚠️ בסביבה המבודדת (${run.label}): ${run.summary}.`;
  const added = [...new Set(qa.added)];
  const facts = [
    `סבבי תיקון: ${qa.rounds}`,
    run.rounds ? `סבבי תיקון אחרי הרצה: ${run.rounds}` : '',
    qa.fixed.size ? `קבצים שתוקנו: ${qa.fixed.size}` : '',
    added.length ? `חבילות שנוספו ל-package.json: ${added.join(', ')} ${run.pinned.length ? '(הגרסאות נקבעו לפי ההתקנה)' : '(בגרסה latest: כדאי לקבע גרסה)'}` : '',
    run.removed.length ? `חבילות שלא קיימות ב-npm והוסרו: ${run.removed.join(', ')}` : '',
    qa.reviewFailed ? 'סקירת הקוד לא הייתה זמינה בחלק מהבדיקה' : '',
  ].filter(Boolean);
  const staticNote = run.ran ? '' : ' הבדיקה סטטית: היא לא מתקינה את הפרויקט ולא מריצה אותו.';
  const setupNotes = run.notes.length ? `\n\nהערות מהסביבה המבודדת: ${run.notes.join('; ')}.` : '';
  say(`\n### בדיקת איכות\n\n${verdict}\n\n${sandboxLine ? `${sandboxLine}\n\n` : ''}${facts.join(' · ')}.${staticNote}${setupNotes}\n`);
  if (blueprint.run && !edit) {
    const fence = fenceFor(blueprint.run);
    say(`\n### הרצה\n\n${fence}bash\n${blueprint.run}\n${fence}\n`);
  }
  // An edit's answer has the files that changed (its version is the previous one with these).
  const changedPaths = edit ? [...files.keys()].filter((path) => files.get(path) !== edit.files.get(path)) : null;
  say(edit ? '\n### הקבצים שהשתנו\n' : '\n### הקבצים\n');
  if (deleted.size) say(`\n**נמחקו:** ${[...deleted].map((path) => `\`${path}\``).join(', ')}\n`);
  for (const file of changedPaths ?? [...blueprint.packages.map((pkg) => pkg.path), ...planned.map((item) => item.path)]) {
    if (!files.has(file)) continue;
    const code = files.get(file);
    const fence = fenceFor(code);
    say(`\n${fence}${languageOf(file)} ${file}\n${code.endsWith('\n') ? code : `${code}\n`}${fence}\n`);
  }
  if (remaining) {
    const lines = ['# QA report', '', `After ${rounds} automatic fix rounds, these problems were still found. Fix them before running the project.`, ''];
    const item = (issue) => {
      const [first, ...rest] = issue.message.split('\n');
      const where = issue.line ? `Line ${issue.line}: ` : '';
      const source = issue.source === 'review' ? ' (code review)' : issue.source === 'sandbox' ? ' (sandbox)' : '';
      return [`- ${where}${first}${source}`, ...(rest.length ? ['', '  ```', ...rest.map((line) => `  ${line}`), '  ```', ''] : [])];
    };
    for (const [file, list] of qa.remaining) lines.push(`## ${file}`, '', ...list.flatMap(item), '');
    if (unfixable.length) {
      lines.push('## The project', '');
      for (const failure of unfixable) lines.push(`- \`${STEP_LABELS[failure.step] ?? failure.step}\`${failure.dir ? ` in ${failure.dir}` : ''} failed, and the log names no file:`, '', '  ```', ...failure.excerpt.split('\n').map((line) => `  ${line}`), '  ```', '');
    }
    const text = lines.join('\n');
    const fence = fenceFor(text);
    say(`\n${fence}markdown QA_REPORT.md\n${text}\n${fence}\n`);
    route.notice = `הבדיקה האוטומטית לא הצליחה לתקן ${issuesText(remaining)}: ${remaining === 1 ? 'היא מפורטת' : 'הן מפורטות'} בסוף התשובה ובקובץ QA_REPORT.md.`;
  }
  return {
    text: answer,
    team: snapshot(),
    runId: live.id,
    artifact: { blueprint, files, changed: changedPaths, deleted: [...deleted], summary: patch ? patch.summary : blueprint.summary, preview },
    qa: {
      rounds: qa.rounds,
      fixed: [...qa.fixed],
      added,
      remaining,
      reviewer: qa.reviewer?.label ?? null,
      dropped: qa.dropped,
      sandbox: row.sandbox ? { provider: run.label, ran: run.ran, ok: run.ok, summary: run.summary, reason: run.reason, rounds: run.rounds, pinned: run.pinned, removed: run.removed } : null,
    },
  };
}
