/**
 * Live previews: the Preview tab of a generated project (an artifact). When the development team's sandbox run
 * ends, its sandbox isn't thrown away: the project's dev server starts in it (Vite's or Next's, or a server's
 * npm start) and Stash shows it on an origin of its own, http://s-<token>.localhost:<port>/, the way static live
 * previews get theirs (middleware/previewHost.js). The separate origin keeps the generated app away from Stash:
 * it can't read the dashboard's storage or cookies, it never reaches the API, and only Stash may frame it. The
 * token is the key: 128 random bits, given only to the project's owner, dead with the preview. Nothing in the
 * sandbox is opened to the network: requests reach the port inside it through `docker exec` (Docker) or E2B's
 * private endpoint, whose access token stays on the server.
 *
 * A preview lives SANDBOX_PREVIEW_MINUTES (15) after it was made, edited or last used, and
 * SANDBOX_PREVIEW_MAX_MINUTES (60) at most; SANDBOX_MAX_PREVIEWS run at once (the one unused longest makes room),
 * one per project. An edit borrows its preview's sandbox and gives it back through adoptPreview, with the dev
 * server restarted on the new files.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { config } from '../../../config.js';
import { SandboxError } from './sandbox/errors.js';
import { openSandbox } from './sandbox/index.js';
import { SERVER_PACKAGES, stepsSummary, verifyProject } from './verify.js';

const HOST = /^s-([0-9a-f]{32})\.localhost$/i;
// Hop-by-hop headers, and the ones the proxy sets itself.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host']);
const ENV_FILE = '[ -f .env ] || [ ! -f .env.example ] || cp .env.example .env;';
const e2bAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const previews = new Map(); // artifact id → preview
const tokens = new Map(); // token → preview
let sweeper = null;

const settings = () => config.sandbox.preview;
const minutes = (count) => count * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const abortError = () => Object.assign(new Error('The request was stopped.'), { name: 'AbortError' });
const depsOf = (pkg) => ({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
const dirOf = (pkg) => pkg.path.split('/').slice(0, -1).join('/');
export const previewUrlOf = (token) => `http://s-${token}.localhost:${config.port}/`;

/**
 * What runs for a preview: the package whose page is shown, on the preview port, and the servers beside it. A
 * Vite (or Next) package runs its dev server; without one, a server's npm start does, with PORT set to the
 * preview port. Null when nothing in the project serves a page.
 */
export function planPreview(blueprint, port = settings().port) {
  const packages = blueprint.packages ?? [];
  const servers = packages.filter((pkg) => pkg.scripts?.start && (SERVER_PACKAGES.some((name) => name in depsOf(pkg)) || /^(node|tsx|ts-node)\s/.test(pkg.scripts.start)));
  const vite = packages.find((pkg) => pkg.scripts?.dev && ('vite' in depsOf(pkg) || /\bvite\b/.test(pkg.scripts.dev)));
  const next = vite ? null : packages.find((pkg) => pkg.scripts?.dev && 'next' in depsOf(pkg));
  const page = vite ?? next ?? servers[0];
  if (!page) return null;
  const web = vite
    ? { dir: dirOf(vite), command: `npm run dev -- --host 0.0.0.0 --port ${port} --strictPort`, kind: 'vite' }
    : next
      ? { dir: dirOf(next), command: `npm run dev -- --hostname 0.0.0.0 --port ${port}`, kind: 'next' }
      : { dir: dirOf(page), command: 'npm start', env: { PORT: String(port) }, kind: 'server' };
  return { port, web, services: servers.filter((pkg) => pkg !== page).map((pkg) => ({ dir: dirOf(pkg), command: 'npm start' })) };
}

function infoOf(preview) {
  const on = ['live', 'updating', 'starting'].includes(preview.status);
  return {
    status: preview.status,
    url: on ? previewUrlOf(preview.token) : null,
    expiresAt: on ? new Date(preview.expiresAt).toISOString() : null,
    version: preview.version,
    provider: preview.provider,
    reason: preview.reason ?? '',
    refreshedAt: preview.refreshedAt ? new Date(preview.refreshedAt).toISOString() : null,
  };
}

/** What a project's page shows about its preview; only its owner learns anything. */
export function previewInfo(id, ownerId) {
  const preview = previews.get(id);
  return preview && preview.ownerId === ownerId ? infoOf(preview) : { status: 'expired', url: null, expiresAt: null, version: null, provider: null, reason: '', refreshedAt: null };
}

function touch(preview, now = Date.now()) {
  preview.touchedAt = now;
  preview.expiresAt = Math.min(preview.hardExpiresAt, now + minutes(settings().minutes));
  // E2B ends a sandbox at its own timeout: keep it a little past the preview's end (at most once a minute).
  if (preview.box && now - (preview.extendedAt ?? 0) > 60_000) {
    preview.extendedAt = now;
    Promise.resolve(preview.box.extend?.(preview.expiresAt - now + 120_000)).catch(() => {});
  }
}

function register(preview) {
  previews.set(preview.id, preview);
  tokens.set(preview.token, preview);
  if (!sweeper) {
    sweeper = setInterval(() => sweepPreviews().catch(() => {}), 30_000);
    sweeper.unref?.();
  }
}

function forget(preview) {
  if (previews.get(preview.id) === preview) previews.delete(preview.id);
  if (tokens.get(preview.token) === preview) tokens.delete(preview.token);
}

export async function closePreview(id) {
  const preview = previews.get(id);
  if (!preview) return;
  forget(preview);
  await preview.box?.close().catch(() => {});
}

/** Ends the previews whose time is up (and forgets failed ones after ten minutes). Runs every 30 seconds. */
export async function sweepPreviews(now = Date.now()) {
  for (const preview of [...previews.values()]) {
    if (preview.status === 'updating' || preview.status === 'starting') continue;
    if (preview.status === 'failed' ? now - preview.touchedAt > minutes(10) : now >= preview.expiresAt) await closePreview(preview.id);
  }
}

export async function closeAllPreviews() {
  clearInterval(sweeper);
  sweeper = null;
  await Promise.all([...previews.keys()].map((id) => closePreview(id)));
}

/** At most SANDBOX_MAX_PREVIEWS with a sandbox: the one unused longest makes room. */
async function makeRoom(keep) {
  const others = [...previews.values()].filter((preview) => preview !== keep && preview.box);
  const excess = others.length + 1 - settings().max;
  if (excess <= 0) return;
  const idle = others.filter((preview) => preview.status === 'live').sort((a, b) => a.touchedAt - b.touchedAt);
  for (const preview of idle.slice(0, excess)) await closePreview(preview.id);
}

const processesOf = (plan) => [...plan.services.map((service, index) => ({ id: `service-${index}`, ...service })), { id: 'web', ...plan.web }];

async function stopProcesses(preview) {
  for (const item of processesOf(preview.plan)) await preview.box.stop(item.id).catch(() => {});
}

async function startProcesses(preview) {
  // E2B's endpoint reaches Vite with its own host name, which Vite refuses unless it's allowed.
  const base = { BROWSER: 'none', ...(preview.box.label === 'E2B' ? { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: '.e2b.app' } : {}) };
  for (const item of processesOf(preview.plan)) await preview.box.background(item.id, `${ENV_FILE} ${item.command}`, { cwd: item.dir, env: { ...base, ...(item.env ?? {}) } });
}

/** An HTTP request to the dev server inside the preview's sandbox. */
function upstream(preview, { method, path, headers }, onReply) {
  const { port } = preview.plan;
  const target = preview.box.target(port);
  if (target.connect) return http.request({ method, path, headers: { ...headers, host: `localhost:${port}` }, createConnection: () => target.connect() }, onReply);
  return https.request({ method, path, host: target.host, port: 443, servername: target.host, agent: e2bAgent, headers: { ...headers, host: target.host, ...target.headers } }, onReply);
}

// Time limits are timers of their own: a relayed connection (Docker) isn't a socket, so it never times out by itself.
function limit(request, ms) {
  const timer = setTimeout(() => request.destroy(new Error('The dev server did not answer.')), ms);
  const clear = () => clearTimeout(timer);
  request.once('response', (reply) => reply.once('end', clear).once('close', clear));
  request.once('error', clear);
  request.once('close', () => request.res || clear());
  return request;
}

function probe(preview) {
  return new Promise((resolve, reject) => {
    const request = upstream(preview, { method: 'GET', path: '/', headers: { accept: 'text/html' } }, (reply) => {
      reply.resume();
      resolve(reply.statusCode ?? 0);
    });
    limit(request, 8_000).on('error', reject);
    request.end();
  });
}

async function tailOf(preview) {
  const text = String(await preview.box.log('web').catch(() => '')).trim();
  return text ? `\n${text.split('\n').slice(-6).join('\n')}` : '';
}

async function waitReady(preview, signal) {
  const deadline = Date.now() + settings().readySeconds * 1000;
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw abortError();
    const status = await probe(preview).catch(() => 0);
    // E2B's endpoint answers 502 until something listens on the port.
    if (status && status < 500) return;
    if (attempt % 3 === 2 && !(await preview.box.alive('web'))) throw new SandboxError(`שרת הפיתוח נעצר בזמן העלייה.${await tailOf(preview)}`, 'The dev server exited while starting.');
    if (Date.now() > deadline) throw new SandboxError(`שרת הפיתוח לא ענה תוך ${settings().readySeconds} שניות.${await tailOf(preview)}`, 'The dev server did not answer in time.');
    await sleep(attempt < 5 ? 400 : 1000);
  }
}

async function fail(preview, reason) {
  Object.assign(preview, { status: 'failed', reason, touchedAt: Date.now() });
  tokens.delete(preview.token);
  const { box } = preview;
  preview.box = null;
  await box?.close().catch(() => {});
}

/**
 * Makes a sandbox a project's live preview, or restarts the preview it already is (after an edit): starts the dev
 * server and the servers beside it, and waits until the page answers. Resolves to what the dashboard shows; a
 * preview that can't start closes its sandbox and says why.
 */
export async function adoptPreview({ id, ownerId, box, blueprint, installedHash = null, version = 1, signal }) {
  const plan = planPreview(blueprint);
  let preview = previews.get(id);
  if (preview && preview.box !== box) {
    await closePreview(id);
    preview = null;
  }
  if (!plan) {
    if (preview) forget(preview);
    await box.close();
    return { status: 'unavailable', url: null, expiresAt: null, version, provider: box.label, reason: 'אין בפרויקט דף להצגה: לא נמצא בו שרת פיתוח (סקריפט dev של Vite או Next) או שרת עם npm start.', refreshedAt: null };
  }
  box.detach?.();
  const now = Date.now();
  preview ??= { id, ownerId, token: randomBytes(16).toString('hex'), box, createdAt: now, hardExpiresAt: now + minutes(settings().maxMinutes) };
  Object.assign(preview, { plan, version, installedHash, status: 'starting', reason: '', provider: box.label });
  touch(preview, now);
  register(preview);
  await makeRoom(preview);
  try {
    await stopProcesses(preview);
    await startProcesses(preview);
    await waitReady(preview, signal);
  } catch (error) {
    await fail(preview, error instanceof SandboxError ? error.message : 'שרת הפיתוח לא עלה.');
    if (error.name === 'AbortError') throw error;
    return infoOf(preview);
  }
  Object.assign(preview, { status: 'live', refreshedAt: Date.now() });
  touch(preview);
  return infoOf(preview);
}

/**
 * An edit takes its project's live preview sandbox: the dev server stops (the page says it's updating), the new
 * files are checked in the same sandbox, and adoptPreview gives it back. Null when there's no live preview.
 */
export async function borrowPreview(id, ownerId) {
  const preview = previews.get(id);
  if (!preview?.box || preview.ownerId !== ownerId || preview.status !== 'live') return null;
  preview.status = 'updating';
  touch(preview);
  await stopProcesses(preview);
  return { box: preview.box, installedHash: preview.installedHash };
}

/** An edit that couldn't finish leaves its sandbox between two versions: the preview ends. */
export const dropPreview = (id) => closePreview(id);

/**
 * Brings back a preview that ended: a new sandbox with the project's files, npm install, and the dev server. Runs
 * in the background; previewInfo() follows it (starting, then live or failed).
 */
export function revivePreview({ id, ownerId, blueprint, files, version }) {
  const current = previews.get(id);
  if (current && current.ownerId === ownerId && ['starting', 'live', 'updating'].includes(current.status)) return infoOf(current);
  const plan = planPreview(blueprint);
  if (!plan) return { status: 'unavailable', url: null, expiresAt: null, version, provider: null, reason: 'אין בפרויקט דף להצגה.', refreshedAt: null };
  if (current) forget(current);
  const now = Date.now();
  const preview = { id, ownerId, token: randomBytes(16).toString('hex'), box: null, plan, version, status: 'starting', reason: '', provider: config.sandbox.provider === 'e2b' ? 'E2B' : 'Docker', createdAt: now, hardExpiresAt: now + minutes(settings().maxMinutes) };
  touch(preview, now);
  register(preview);
  (async () => {
    let box = null;
    try {
      box = await openSandbox();
      await box.writeFiles(files);
      const result = await verifyProject({ box, files, blueprint, settings: config.sandbox, only: ['install'] });
      if (!result.ok) throw new SandboxError(`ההתקנה נכשלה: ${stepsSummary(result.steps)}`, 'The install failed.');
      if (previews.get(id) !== preview) return void (await box.close());
      preview.box = box;
      await adoptPreview({ id, ownerId, box, blueprint, installedHash: result.installedHash, version });
    } catch (error) {
      if (previews.get(id) === preview && preview.status === 'starting') await fail(preview, error instanceof SandboxError ? error.message : 'לא הצלחתי להפעיל את התצוגה החיה מחדש.');
      else await box?.close().catch(() => {});
    }
  })();
  return infoOf(preview);
}

// Only Stash may frame a preview: its own CSP's frame-ancestors (and X-Frame-Options) give way to this one.
const ancestors = () => ["'self'", 'http://localhost:*', 'http://127.0.0.1:*', 'https://localhost:*', ...config.allowedHosts.flatMap((host) => [`http://${host}:*`, `https://${host}:*`])].join(' ');
function framed(policy) {
  const kept = String(policy ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^frame-ancestors\b/i.test(part));
  return [...kept, `frame-ancestors ${ancestors()}`].join('; ');
}

function notice(res, status, message, refresh = 0) {
  res
    .status(status)
    .type('html')
    .set('Cache-Control', 'no-store')
    .set('Content-Security-Policy', `frame-ancestors ${ancestors()}`)
    .send(
      `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>Stash</title>\n<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:16px system-ui,sans-serif;color:#5a6273;background:#eef0f3"><p>${message}</p></body></html>`,
    );
}

function forward(preview, req, res) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name)) headers[name] = value;
  Object.assign(headers, { 'x-forwarded-host': req.headers.host ?? '', 'x-forwarded-proto': 'http' });
  const request = upstream(preview, { method: req.method, path: req.originalUrl, headers }, (reply) => {
    const out = {};
    for (const [name, value] of Object.entries(reply.headers)) if (!HOP.has(name) && name !== 'x-frame-options' && name !== 'content-security-policy') out[name] = value;
    out['content-security-policy'] = framed(reply.headers['content-security-policy']);
    res.writeHead(reply.statusCode ?? 502, out);
    reply.pipe(res);
  });
  limit(request, 120_000).on('error', () => (res.headersSent ? res.destroy() : notice(res, 502, 'השרת של הפרויקט לא ענה. נסו לרענן בעוד רגע.')));
  req.pipe(request);
}

/** Every request to a preview's origin (s-<token>.localhost) goes to the dev server in its sandbox, and nowhere else. */
export function sandboxPreviewHost() {
  return (req, res, next) => {
    const match = HOST.exec(req.hostname ?? '');
    if (!match) return next();
    const preview = tokens.get(match[1].toLowerCase());
    if (!preview) return notice(res, 404, 'התצוגה החיה הזאת הסתיימה. אפשר להפעיל אותה מחדש מהפרויקט בצ׳אט.');
    if (preview.status !== 'live') return notice(res, 503, preview.status === 'updating' ? 'מעדכן את התצוגה עם השינויים…' : 'התצוגה החיה עולה…', 2);
    touch(preview);
    forward(preview, req, res);
  };
}

/** A WebSocket to a preview's origin (Vite's hot reload), piped to the dev server as it is. False: not a preview's. */
export function upgradePreview(req, socket, head) {
  const match = HOST.exec(String(req.headers.host ?? '').replace(/:\d+$/, ''));
  if (!match) return false;
  const preview = tokens.get(match[1].toLowerCase());
  if (preview?.status !== 'live') {
    socket.destroy();
    return true;
  }
  touch(preview);
  const { port } = preview.plan;
  const target = preview.box.target(port);
  const other = target.connect ? target.connect() : tls.connect({ host: target.host, port: 443, servername: target.host });
  const headers = { ...req.headers, host: target.connect ? `localhost:${port}` : target.host, ...(target.headers ?? {}) };
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) for (const item of [value].flat()) lines.push(`${name}: ${item}`);
  other.write(`${lines.join('\r\n')}\r\n\r\n`);
  if (head?.length) other.write(head);
  other.pipe(socket);
  socket.pipe(other);
  const close = () => {
    socket.destroy();
    other.destroy();
  };
  for (const stream of [other, socket]) {
    stream.on('error', close);
    stream.on('close', close);
  }
  return true;
}
