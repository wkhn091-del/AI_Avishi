/**
 * Live runs of the development team, for the live dashboard (the client's SwarmDashboard).
 *
 * A run holds the dashboard's whole state as plain JSON (the phases, the planned file tree, every file's
 * status and correction attempts, the sandbox's steps, the ZIP and the credits) and changes only through
 * patches, which are exactly what the dashboard receives:
 *   { op: 'merge', at: ['qa'], value: { round: 2 } }                   fields into the object at a path
 *   { op: 'upsert', at: ['files'], value: { key: 'src/App.jsx', … } }  an item into the array at a path, by key
 * GET /api/chat/runs/:id/events streams them as Server-Sent Events: the whole state first (so a page that
 * joins late or reconnects is complete), then every change, then `end`. Only the run's owner can listen.
 * A finished run stays readable for ten minutes, and its final state is saved with the answer, so the
 * dashboard looks the same after a reload.
 */
import { randomUUID } from 'node:crypto';

const KEEP_FINISHED_MS = 10 * 60_000;
const KEEP_RUNNING_MS = 3 * 60 * 60_000; // one that never finished: the server stopped in the middle
const MAX_RUNS = 500;
const runs = new Map();

/** Applies one patch to a state, in place. (The client applies the same patches without mutating.) */
export function applyPatch(state, { op, at = [], value }) {
  let parent = state;
  for (const part of at.slice(0, -1)) parent = parent[part] ??= {};
  const last = at.at(-1);
  if (op === 'merge') Object.assign(last === undefined ? parent : (parent[last] ??= {}), value);
  else if (op === 'upsert') {
    const list = (parent[last] ??= []);
    const index = list.findIndex((item) => item.key === value.key);
    if (index === -1) list.push({ ...value });
    else Object.assign(list[index], value);
  }
  return state;
}

/** A new run's state: every phase waiting, the architect at work. */
export function newPipelineState(id, settings = {}) {
  return {
    version: 1,
    runId: id,
    status: 'running',
    phase: 'architect',
    // build: a new project; edit: a follow-up on one (the architect plans a patch). The artifact: { id, version }.
    mode: settings.mode ?? 'build',
    artifact: settings.artifact ?? null,
    startedAt: Date.now(),
    finishedAt: null,
    settings: { concurrency: 8, qaRounds: 3, sandboxRounds: 0, sandbox: null, models: {}, ...settings },
    architect: { status: 'working', model: settings.models?.architect ?? null, note: '', chars: 0, draft: [], title: '', summary: '', stack: [], tree: [], ms: 0 },
    build: { status: 'waiting', total: 0, done: 0, failed: 0, active: 0, ms: 0 },
    files: [],
    qa: { status: 'waiting', round: 0, rounds: settings.qaRounds ?? 3, reviewer: settings.models?.reviewer ?? null, issues: 0, flagged: 0, remaining: 0, note: '', ms: 0 },
    sandbox: { status: settings.sandbox ? 'waiting' : 'off', provider: settings.sandbox ?? null, round: 0, rounds: settings.sandboxRounds ?? 0, steps: [], summary: '', reason: '', pinned: [], ms: 0 },
    package: { status: 'waiting', bundle: null },
    preview: { status: settings.preview ? 'waiting' : 'off', url: null, expiresAt: null, version: settings.artifact?.version ?? 1, provider: settings.sandbox ?? null, reason: '', refreshedAt: null },
    credits: { status: 'waiting', charged: 0, before: null, after: null, unlimited: false },
    result: { remaining: 0, fixed: 0, rounds: 0 },
    error: null,
  };
}

function prune(now = Date.now()) {
  for (const [id, run] of runs) {
    if ((run.finishedAt && now - run.finishedAt > KEEP_FINISHED_MS) || now - run.createdAt > KEEP_RUNNING_MS) runs.delete(id);
  }
  if (runs.size < MAX_RUNS) return;
  // Still too many: the oldest finished ones go first.
  const finished = [...runs.values()].filter((run) => run.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
  for (const run of finished.slice(0, runs.size - MAX_RUNS + 1)) runs.delete(run.id);
}

function handleOf(run) {
  const patch = (...patches) => {
    if (run.finishedAt || !patches.length) return;
    for (const item of patches) applyPatch(run.state, item);
    run.seq += 1;
    const event = { id: run.seq, patches };
    for (const listener of run.listeners) listener(event);
  };
  return {
    id: run.id,
    get finished() {
      return Boolean(run.finishedAt);
    },
    patch,
    /** Ends the run: its status (done, failed or stopped), and the listeners get `end`. */
    finish(status, value = {}) {
      if (run.finishedAt) return;
      patch({ op: 'merge', at: [], value: { status, phase: status === 'done' ? 'done' : run.state.phase, finishedAt: Date.now(), ...value } });
      run.finishedAt = Date.now();
      for (const listener of run.listeners) listener({ end: true });
      run.listeners.clear();
    },
    snapshot: () => structuredClone(run.state),
  };
}

export function createRun({ ownerId = null, settings = {} } = {}) {
  prune();
  const id = randomUUID();
  const run = { id, ownerId, createdAt: Date.now(), finishedAt: null, seq: 0, listeners: new Set(), state: newPipelineState(id, settings) };
  runs.set(id, run);
  return handleOf(run);
}

/** The run, for its owner (the chat route reports the ZIP and the credits, and finishes it); null otherwise. */
export function findRun(id, ownerId) {
  const run = runs.get(id);
  return run && run.ownerId === ownerId ? handleOf(run) : null;
}

/**
 * Listens to a run: `listener` gets `{ id, snapshot }` at once, then `{ id, patches }` for every change and
 * `{ end: true }` when the run is finished (at once, for one that already is). Returns the function that
 * stops listening, or null when there's no such run for this person.
 */
export function subscribeRun(id, ownerId, listener) {
  const run = runs.get(id);
  if (!run || run.ownerId !== ownerId) return null;
  listener({ id: run.seq, snapshot: structuredClone(run.state) });
  if (run.finishedAt) {
    listener({ end: true });
    return () => {};
  }
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}
