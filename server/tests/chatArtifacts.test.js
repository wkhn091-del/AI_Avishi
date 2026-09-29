// Live previews and edits through the chat. A team answer with the sandbox on leaves its project running, on an
// origin of its own (s-<token>.localhost) that only its owner knows: the proxy serves it, forwards requests and
// WebSockets, and lets only Stash frame it. A follow-up from the project's panel edits the same project: one file
// rewritten, in the same sandbox, and the preview shows the new version. An expired preview comes back on request.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { MEMBER, authHeader, startTestDatabase, tempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const storage = await tempDir('stash-artifacts-');
const cli = path.join(storage.dir, 'docker');
await fs.writeFile(cli, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fixtures', 'fake-docker.mjs')}" "$@"\n`, { mode: 0o755 });
Object.assign(process.env, {
  STORAGE_DIR: storage.dir,
  LOG_REQUESTS: 'false',
  LONG_TERM_MEMORY: 'off',
  ANTHROPIC_API_KEY: 'anthropic-key',
  OPENAI_API_KEY: 'openai-key',
  GEMINI_API_KEY: 'gemini-key',
  DEEPSEEK_API_KEY: 'deepseek-key',
  AI_RETRY_BASE_MS: '5',
  SANDBOX: 'docker',
  SANDBOX_DOCKER_CLI: cli,
  SANDBOX_PREVIEW_READY_SECONDS: '20',
  FAKE_DOCKER_ROOT: path.join(storage.dir, 'containers'),
  FAKE_DOCKER_LOG: path.join(storage.dir, 'docker.log'),
});
for (const name of ['AI_PROVIDER', 'AI_PROVIDERS', 'CHAT_HANDOFF', 'PIPELINE', 'PIPELINE_ARCHITECT', 'PIPELINE_ARCHITECT_FALLBACK', 'PIPELINE_BUILDER', 'PIPELINE_REVIEWER', 'PIPELINE_QA_ROUNDS', 'PIPELINE_CONCURRENCY', 'MOONSHOT_API_KEY', 'SANDBOX_ACCESS', 'SANDBOX_ROUNDS', 'SANDBOX_MAX_RUNS']) delete process.env[name];

const S = (text) => `${text} Every function validates its input and handles errors and edge cases exactly as the contracts say.`;
const BLUEPRINT = {
  name: 'sums',
  title: 'מחשבון סכומים',
  summary: 'ממשק React ושרת Express שמחבר מספרים.',
  stack: ['React 19', 'Vite 7', 'Express 5'],
  architecture: 'A React client lists tasks; an Express server adds numbers.',
  contracts: 'GET /api/tasks → Task[]. GET /api/sum?a&b → { sum: number }.',
  packages: [
    { path: 'client/package.json', type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' }, devDependencies: { vite: '^7.1.0' } },
    { path: 'server/package.json', type: 'module', scripts: { start: 'node index.js', test: 'node --test' }, dependencies: { express: '^5.1.0' } },
  ],
  files: [
    { path: 'client/index.html', purpose: 'The page', imports: [{ from: '/src/main.jsx' }], spec: S('A heading, a root div and the module script.') },
    { path: 'client/src/main.jsx', purpose: 'Mounts the app', imports: [{ from: 'react-dom/client', names: ['createRoot'] }, { from: './App.jsx', names: ['default'] }], spec: S('Mounts App into #root.') },
    { path: 'client/src/App.jsx', purpose: 'The list', imports: [{ from: 'react', names: ['useEffect', 'useState'] }, { from: './api.js', names: ['fetchTasks'] }], exports: [{ name: 'default' }], spec: S('Loads the tasks and lists them.') },
    { path: 'client/src/api.js', purpose: 'The API client', exports: [{ name: 'fetchTasks', signature: 'fetchTasks(): Promise<Task[]>' }], spec: S('GET /api/tasks.') },
    { path: 'server/index.js', purpose: 'The server', imports: [{ from: 'express', names: ['default'] }, { from: './util.js', names: ['add'] }], spec: S('GET /api/sum with add; listens on PORT.') },
    { path: 'server/util.js', purpose: 'Math', exports: [{ name: 'add', signature: 'add(a: number, b: number): number' }], spec: S('add returns the sum of a and b.') },
    { path: 'server/util.test.js', purpose: 'The tests', imports: [{ from: 'node:test' }, { from: 'node:assert/strict' }, { from: './util.js', names: ['add'] }], spec: S('add(2, 3) is 5.') },
  ],
  run: 'npm install --prefix server && npm start --prefix server',
};
const page = (title) => `<!doctype html>\n<html lang="he" dir="rtl">\n  <body><h1>${title}</h1><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>\n</html>\n`;
const CODE = {
  'client/index.html': page('Sums v1'),
  'client/src/main.jsx': "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  'client/src/App.jsx': "import { useEffect, useState } from 'react';\nimport { fetchTasks } from './api.js';\n\nexport default function App() {\n  const [tasks, setTasks] = useState([]);\n  useEffect(() => {\n    fetchTasks().then(setTasks).catch(() => setTasks([]));\n  }, []);\n  return <ul>{tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>;\n}\n",
  'client/src/api.js': "export async function fetchTasks() {\n  const response = await fetch('/api/tasks');\n  if (!response.ok) throw new Error(`HTTP ${response.status}`);\n  return response.json();\n}\n",
  'server/index.js': "import express from 'express';\nimport { add } from './util.js';\n\nconst app = express();\napp.get('/api/sum', (req, res) => res.json({ sum: add(Number(req.query.a), Number(req.query.b)) }));\napp.listen(process.env.PORT ?? 3000);\n",
  'server/util.js': 'export const add = (a, b) => a + b;\n',
  'server/util.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './util.js';\n\ntest('add sums two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
};
const EDITED = { 'client/index.html': page('Sums v2') };
const PATCH = { summary: 'הכותרת תהיה Sums v2.', changes: [{ path: 'client/index.html', action: 'modify', instructions: 'Change the <h1> to "Sums v2".', imports: [{ from: '/src/main.jsx' }] }], packages: [] };

const realFetch = globalThis.fetch;
const calls = [];
const rating = { complexity: 8, category: 'code', kind: 'planning', output: 'massive', reason: 'פרויקט' };
const sse = (events) => new Response(events.map((event) => (typeof event === 'string' ? `${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`)).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const claude = (text) => sse([`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}`, `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 900, output_tokens: 400 } })}`]);
const openai = (text) => sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 500 } }, 'data: [DONE]']);
const gemini = (text) => sse([{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 300 } }]);
const systemOf = (body) => (typeof body.system === 'string' ? body.system : (body.messages?.find((message) => message.role === 'system')?.content ?? body.systemInstruction?.parts?.[0]?.text ?? ''));
const partsText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '');
const textOf = (body) => (body?.contents ?? body?.messages ?? []).map((message) => (message.parts ? message.parts.map((part) => part.text ?? '').join('') : partsText(message.content))).join('\n');
const roleOf = (system) =>
  system.includes('You are the Master Architect') ? 'architect' : system.includes('You are an expert compiler') ? 'builder' : system.includes('You are the QA compiler') ? 'review' : system.includes('A command failed while a generated project') ? 'triage' : null;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
  const system = body ? systemOf(body) : '';
  const role = roleOf(system);
  const prompt = textOf(body);
  calls.push({ role, prompt, href, system });
  const reply = (text) => (href.includes('generativelanguage') ? gemini(text) : href.includes('anthropic') ? claude(text) : openai(text));
  if (role === 'architect') return reply(JSON.stringify(system.includes('Plan it as a patch') ? PATCH : BLUEPRINT));
  if (role === 'builder') {
    const file = /# The file to write: (\S+)/.exec(prompt)?.[1];
    return reply((prompt.includes('# The change to make') ? EDITED[file] : null) ?? CODE[file] ?? 'export {};\n');
  }
  if (role === 'review') return reply(JSON.stringify({ issues: [] }));
  if (href.includes('generativelanguage') && system.includes('You route chat requests')) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(rating) }] } }] });
  return reply('תשובה');
};

const database = await startTestDatabase();
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { closeAllPreviews, sweepPreviews, upgradePreview } = await import('../src/services/ai/swarm/preview.js');
console.warn = () => {};
let server;
let base;
let store;
before(async () => {
  await Promise.all([config.paths.archives, config.paths.files].map((dir) => fs.mkdir(dir, { recursive: true })));
  store = new JsonStore(config.paths.database);
  await store.init();
  server = createApp({ store }).listen(0, '127.0.0.1');
  server.on('upgrade', (req, socket, head) => {
    if (!upgradePreview(req, socket, head)) socket.destroy();
  });
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await closeAllPreviews();
  await new Promise((resolve) => server.close(resolve));
  await store.flush();
  await database.stop?.();
  await storage.cleanup();
});

const api = (route, init = {}) => realFetch(`${base}${route}`, init);
const post = (route, body, user) => api(route, { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? authHeader(user) : {}) }, body: JSON.stringify(body) });
async function send(conversationId, body) {
  const response = await post(`/chat/conversations/${conversationId}/messages`, { workspace: 'premium', effort: 'low', premiumModel: 'auto', ...body });
  const text = await response.text();
  if (!response.ok) return { status: response.status, error: JSON.parse(text).error };
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  return { status: response.status, events, final: events.find((event) => event.type === 'done' || event.type === 'error'), bundle: events.find((event) => event.type === 'bundle')?.bundle };
}
const dockerRuns = async () => (await fs.readFile(process.env.FAKE_DOCKER_LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).filter((line) => JSON.parse(line)[0] === 'run').length;
const tokenOf = (url) => /^http:\/\/s-([0-9a-f]{32})\.localhost:\d+\/$/.exec(url ?? '')?.[1];
/** A request to a preview's origin: this server, with the preview's host name. */
const proxied = (token, { method = 'GET', route = '/', body, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, method, path: route, headers: { host: `s-${token}.localhost:${server.address().port}`, ...headers } }, (reply) => {
      let text = '';
      reply.setEncoding('utf8');
      reply.on('data', (chunk) => (text += chunk));
      reply.on('end', () => resolve({ status: reply.statusCode, headers: reply.headers, text }));
    });
    request.on('error', reject);
    request.end(body);
  });
/** A WebSocket upgrade to a preview's origin: the handshake's answer, then the echo of "ping". */
const upgraded = (token) =>
  new Promise((resolve, reject) => {
    let text = '';
    const socket = net.connect(server.address().port, '127.0.0.1', () =>
      socket.write(`GET /hmr?token=x HTTP/1.1\r\nHost: s-${token}.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`),
    );
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\r\n\r\n') && !text.includes('ping')) socket.write('ping');
      else if (text.endsWith('ping')) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(text);
    }, 8_000);
  });

describe('Live previews and edits (through the chat)', () => {
  test("a team answer leaves its project live on its own origin; a follow-up edits one file in the same sandbox; an expired preview comes back", async () => {
    const conversationId = (await (await post('/chat/conversations', {})).json()).conversation.id;
    const first = await send(conversationId, { content: 'בנה מחשבון סכומים עם React ו-Express' });
    const message = first.final.message;
    assert.equal(first.final.type, 'done');
    assert.deepEqual([message.artifact.id, message.artifact.version, message.artifact.blueprint.title], [message.id, 1, 'מחשבון סכומים']);
    assert.deepEqual([message.pipeline.mode, message.pipeline.artifact], ['build', { id: message.id, version: 1 }]);
    const preview = message.pipeline.preview;
    assert.deepEqual([preview.status, preview.provider, preview.version], ['live', 'Docker', 1]);
    const token = tokenOf(preview.url);
    assert.ok(token, preview.url);
    assert.equal(await dockerRuns(), 1);

    // The proxy: the page, with only Stash allowed to frame it (the app's own frame rules give way).
    const home = await proxied(token);
    assert.equal(home.status, 200);
    assert.match(home.text, /<h1>Sums v1<\/h1>/);
    assert.equal(home.headers['x-frame-options'], undefined);
    assert.match(home.headers['content-security-policy'], /^default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self' http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/);
    assert.doesNotMatch(home.headers['content-security-policy'], /'none'/);
    // Requests go through with their bodies, to the dev server as localhost; WebSockets too (hot reload).
    const echo = JSON.parse((await proxied(token, { method: 'POST', route: '/__echo', body: 'ping', headers: { 'content-type': 'text/plain' } })).text);
    assert.deepEqual(echo, { method: 'POST', host: `localhost:${config.sandbox.preview.port}`, body: 'ping' });
    const socket = await upgraded(token);
    assert.match(socket, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.match(socket, /ping$/);
    const unknown = await proxied('0'.repeat(32));
    assert.deepEqual([unknown.status, /הסתיימה/.test(unknown.text)], [404, true]);

    // The project's files, for the Code tab: its owner's only.
    const artifact = (await (await api(`/chat/conversations/${conversationId}/artifacts/${message.id}`)).json()).artifact;
    assert.deepEqual([artifact.version, artifact.latest, artifact.title, artifact.preview.status, artifact.sandbox], [1, 1, 'מחשבון סכומים', 'live', true]);
    assert.deepEqual(artifact.files.map((file) => file.path).sort(), ['client/index.html', 'client/package.json', 'client/src/App.jsx', 'client/src/api.js', 'client/src/main.jsx', 'server/index.js', 'server/package.json', 'server/util.js', 'server/util.test.js']);
    assert.equal(artifact.files.find((file) => file.path === 'client/index.html').purpose, 'The page');
    assert.equal((await api(`/chat/conversations/${conversationId}/artifacts/${message.id}`, { headers: authHeader(MEMBER) })).status, 404);

    // A follow-up from the project's panel: the architect plans a patch, one file is rewritten, in the same sandbox.
    const from = calls.length;
    const edit = await send(conversationId, { content: 'שנו את הכותרת ל-Sums v2', artifact: { id: message.id } });
    const answer = edit.final.message;
    assert.equal(edit.final.type, 'done');
    assert.deepEqual(
      { id: answer.artifact.id, version: answer.artifact.version, base: answer.artifact.base, changed: answer.artifact.changed, deleted: answer.artifact.deleted, summary: answer.artifact.summary },
      { id: message.id, version: 2, base: 1, changed: ['client/index.html'], deleted: [], summary: 'הכותרת תהיה Sums v2.' },
    );
    const run = answer.pipeline;
    assert.deepEqual([run.mode, run.artifact], ['edit', { id: message.id, version: 2 }]);
    assert.deepEqual(run.architect.tree, [{ path: 'client/index.html', purpose: 'The page', kind: 'file', action: 'modify' }]);
    assert.deepEqual(run.files.map((file) => [file.path, file.status]), [['client/index.html', 'written']]);
    const writers = calls.slice(from).filter((call) => call.role === 'builder');
    assert.deepEqual(writers.map((call) => /# The file to write: (\S+)/.exec(call.prompt)[1]), ['client/index.html']);
    assert.match(writers[0].prompt, /# The current version of this file\n```\n<!doctype html>[\s\S]*Sums v1[\s\S]*# The change to make\nChange the <h1> to "Sums v2"\./);
    assert.ok(calls.slice(from).find((call) => call.role === 'architect').system.includes('# The current blueprint'));
    assert.equal(await dockerRuns(), 1, 'the edit ran in the preview’s sandbox');
    assert.deepEqual(run.sandbox.steps.filter((step) => step.id === 'install').map((step) => step.status), ['cached', 'cached'], 'package.json unchanged: no install');
    assert.deepEqual([run.preview.status, run.preview.version, run.preview.url], ['live', 2, preview.url]);
    assert.match((await proxied(token)).text, /<h1>Sums v2<\/h1>/);
    assert.match(answer.content, /^## מחשבון סכומים: עדכון\n\nהכותרת תהיה Sums v2\.\n\n\*\*השינויים:\*\* קובץ אחד משתנה\./);
    assert.match(answer.content, /### הקבצים שהשתנו\n\n```html client\/index.html\n/);
    assert.doesNotMatch(answer.content, /client\/src\/App\.jsx\n/);
    // Its ZIP is the whole project at version 2.
    const zip = new AdmZip(Buffer.from(await (await realFetch(`http://127.0.0.1:${server.address().port}${edit.bundle.url}`)).arrayBuffer()));
    const entries = Object.fromEntries(zip.getEntries().map((entry) => [entry.entryName.split('/').slice(1).join('/'), entry.getData().toString('utf8')]));
    assert.equal(Object.keys(entries).length, 9);
    assert.match(entries['client/index.html'], /Sums v2/);
    assert.equal(entries['client/src/App.jsx'], CODE['client/src/App.jsx']);
    // Both versions stay readable.
    const latest = (await (await api(`/chat/conversations/${conversationId}/artifacts/${message.id}`)).json()).artifact;
    assert.deepEqual([latest.version, latest.latest, latest.messageId], [2, 2, answer.id]);
    const older = (await (await api(`/chat/conversations/${conversationId}/artifacts/${message.id}?version=1`)).json()).artifact;
    assert.match(older.files.find((file) => file.path === 'client/index.html').content, /Sums v1/);
    // An edit of a project that isn't in the conversation is refused before anything is saved.
    const missing = await send(conversationId, { content: 'x', artifact: { id: 'not-a-project' } });
    assert.deepEqual([missing.status, missing.error.code], [404, 'ARTIFACT_NOT_FOUND']);

    // Fifteen minutes on, the preview is gone; asked to, it comes back in a new sandbox, at the latest version.
    await sweepPreviews(Date.now() + 16 * 60_000);
    assert.equal((await proxied(token)).status, 404);
    const status = async () => (await (await api(`/chat/conversations/${conversationId}/artifacts/${message.id}/preview`)).json()).preview;
    assert.equal((await status()).status, 'expired');
    const revived = (await (await post(`/chat/conversations/${conversationId}/artifacts/${message.id}/preview`, {})).json()).preview;
    assert.equal(revived.status, 'starting');
    let now = revived;
    for (let waited = 0; now.status === 'starting' && waited < 30_000; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      now = await status();
    }
    assert.deepEqual([now.status, now.version], ['live', 2], now.reason);
    assert.equal(await dockerRuns(), 2);
    assert.match((await proxied(tokenOf(now.url))).text, /<h1>Sums v2<\/h1>/);
  });
});
