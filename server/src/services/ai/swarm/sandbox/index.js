/**
 * The sandbox the swarm builds and runs a generated project in (SANDBOX=docker or e2b; off by
 * default). Running code a model wrote is only safe behind a real isolation boundary, so there is
 * no "local" mode: Docker (self-hosted) or E2B (hosted microVMs). By default only admins
 * (ADMIN_EMAILS) get it; SANDBOX_ACCESS=everyone opens it to every signed-in person. At most
 * SANDBOX_MAX_RUNS projects use it at once; the next one waits up to two minutes for a turn.
 */
import { config } from '../../../../config.js';
import { DockerSandbox } from './docker.js';
import { E2BSandbox } from './e2b.js';
import { SandboxError } from './errors.js';

export { SandboxError } from './errors.js';
const WAIT_MS = 120_000;
let active = 0;
const waiting = [];

/** Whether this person's projects are built and run in the sandbox: `{ provider, label }`, or null. */
export function sandboxFor(user) {
  const settings = config.sandbox;
  if (settings.provider === 'off') return null;
  if (settings.access !== 'everyone' && !user?.isAdmin) return null;
  return { provider: settings.provider, label: settings.provider === 'e2b' ? 'E2B' : 'Docker' };
}

function acquire(signal) {
  if (active < config.sandbox.maxRuns) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(entry), 1);
      reject(new SandboxError('הסביבה המבודדת עסוקה בפרויקטים אחרים. נסו שוב בעוד כמה דקות.', 'All sandbox slots were busy.'));
    }, WAIT_MS);
    entry.resolve = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      const index = waiting.indexOf(entry);
      if (index !== -1) waiting.splice(index, 1);
      reject(Object.assign(new Error('The request was stopped.'), { name: 'AbortError' }));
    });
    waiting.push(entry);
  });
}
function release() {
  const next = waiting.shift();
  if (next) next.resolve();
  else active = Math.max(0, active - 1);
}

/** Opens a sandbox (waiting for a free slot); close() gives the slot back. */
export async function openSandbox({ signal } = {}) {
  const settings = config.sandbox;
  await acquire(signal);
  try {
    // A sandbox may become a live preview afterwards, so it lives long enough for one.
    const lifetime = settings.lifetimeSeconds + (settings.preview.enabled ? settings.preview.maxMinutes * 60 : 0);
    const box = settings.provider === 'e2b' ? await E2BSandbox.open(settings.e2b, lifetime) : await DockerSandbox.open(settings.docker, lifetime);
    let closed = false;
    let released = false;
    const giveBack = () => {
      if (released) return;
      released = true;
      release();
    };
    const close = box.close.bind(box);
    box.close = async () => {
      if (closed) return;
      closed = true;
      try {
        await close();
      } finally {
        giveBack();
      }
    };
    // A live preview keeps the sandbox but gives back its slot: previews have their own limit (preview.js).
    box.detach = giveBack;
    return box;
  } catch (error) {
    release();
    throw error;
  }
}
