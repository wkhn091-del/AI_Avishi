// The sandbox through the chat. An admin's project is installed, built, tested and started in Docker (a stand-in
// CLI: fixtures/fake-docker.mjs): errors a parser can't see (a top-level await the build target rejects, a test
// that fails) go back to the micro-agents, and the answer and the ZIP show the result, with the added package
// pinned to the version that was installed. A member's project gets the static checks only, and a Docker that
// isn't running is reported in the answer, which still arrives.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { MEMBER, authHeader, startTestDatabase, tempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const storage = await tempDir('stash-sandbox-chat-');
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
  // With live previews off, the sandbox ends with the run (previews: chatArtifacts.test.js).
  SANDBOX_PREVIEW: 'off',
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
    { path: 'client/index.html', purpose: 'The page', imports: [{ from: '/src/main.jsx' }], spec: S('A root div and the module script.') },
    { path: 'client/src/main.jsx', purpose: 'Mounts the app', imports: [{ from: 'react-dom/client', names: ['createRoot'] }, { from: './App.jsx', names: ['default'] }], spec: S('Mounts App into #root.') },
    { path: 'client/src/App.jsx', purpose: 'The list', imports: [{ from: 'react', names: ['useEffect', 'useState'] }, { from: './api.js', names: ['fetchTasks'] }], exports: [{ name: 'default' }], spec: S('Loads the tasks with fetchTasks and lists them.') },
    { path: 'client/src/api.js', purpose: 'The API client', exports: [{ name: 'fetchTasks', signature: 'fetchTasks(): Promise<Task[]>' }], spec: S('GET /api/tasks.') },
    { path: 'server/index.js', purpose: 'The server', imports: [{ from: 'express', names: ['default'] }, { from: './util.js', names: ['add'] }], spec: S('GET /api/sum with add; listens on PORT.') },
    { path: 'server/util.js', purpose: 'Math', exports: [{ name: 'add', signature: 'add(a: number, b: number): number' }], spec: S('add returns the sum of a and b.') },
    { path: 'server/util.test.js', purpose: 'The tests', imports: [{ from: 'node:test' }, { from: 'node:assert/strict' }, { from: './util.js', names: ['add'] }], spec: S('add(2, 3) is 5.') },
  ],
  run: 'npm install --prefix server && npm start --prefix server',
};
const APP_FIRST = "import { fetchTasks } from './api.js';\n\nconst tasks = await fetchTasks();\n\nexport default function App() {\n  return <ul>{tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>;\n}\n";
const APP_FIXED = "import { useEffect, useState } from 'react';\nimport { fetchTasks } from './api.js';\n\nexport default function App() {\n  const [tasks, setTasks] = useState([]);\n  useEffect(() => {\n    fetchTasks().then(setTasks).catch(() => setTasks([]));\n  }, []);\n  return <ul>{tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>;\n}\n";
const CODE = {
  'client/index.html': () => '<!doctype html>\n<html lang="he" dir="rtl">\n  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>\n</html>\n',
  'client/src/main.jsx': () => "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  'client/src/App.jsx': (fixed) => (fixed ? APP_FIXED : APP_FIRST),
  'client/src/api.js': () => "export async function fetchTasks() {\n  const response = await fetch('/api/tasks');\n  if (!response.ok) throw new Error(`HTTP ${response.status}`);\n  return response.json();\n}\n",
  'server/index.js': () => "import express from 'express';\nimport cors from 'cors';\nimport { add } from './util.js';\n\nconst app = express();\napp.use(cors());\napp.get('/api/sum', (req, res) => res.json({ sum: add(Number(req.query.a), Number(req.query.b)) }));\napp.listen(process.env.PORT ?? 3000);\n",
  'server/util.js': (fixed) => `export const add = (a, b) => ${fixed ? 'a + b' : 'a - b'};\n`,
  'server/util.test.js': () => "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './util.js';\n\ntest('add sums two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
};

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
  calls.push({ role, prompt, href });
  const reply = (text) => (href.includes('generativelanguage') ? gemini(text) : href.includes('anthropic') ? claude(text) : openai(text));
  if (role === 'architect') return reply(JSON.stringify(BLUEPRINT));
  if (role === 'builder') {
    const file = /# The file to write: (\S+)/.exec(prompt)?.[1];
    return reply(CODE[file]?.(prompt.includes('What the QA compiler found')) ?? 'export {};\n');
  }
  if (role === 'review') return reply(JSON.stringify({ issues: [] }));
  if (role === 'triage') return reply(JSON.stringify({ issues: [{ path: 'server/util.js', message: 'add subtracts: it must return a + b, as the test and the spec say.' }] }));
  if (href.includes('generativelanguage') && system.includes('You route chat requests')) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(rating) }] } }] });
  return reply('תשובה');
};

const database = await startTestDatabase();
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
console.warn = () => {};
let server;
let base;
let store;
before(async () => {
  await Promise.all([config.paths.archives, config.paths.files].map((dir) => fs.mkdir(dir, { recursive: true })));
  store = new JsonStore(config.paths.database);
  await store.init();
  server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.flush();
  await storage.cleanup();
});

const api = (route, init = {}) => realFetch(`${base}${route}`, init);
const post = (route, body, user) => api(route, { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? authHeader(user) : {}) }, body: JSON.stringify(body) });
async function ask(content, user) {
  const id = (await (await post('/chat/conversations', {}, user)).json()).conversation.id;
  const response = await post(`/chat/conversations/${id}/messages`, { workspace: 'premium', effort: 'low', premiumModel: 'auto', content }, user);
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  return { events, final: events.find((event) => event.type === 'done' || event.type === 'error'), bundle: events.find((event) => event.type === 'bundle')?.bundle };
}
const dockerLog = async () => (await fs.readFile(process.env.FAKE_DOCKER_LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

describe('The sandbox (through the chat)', () => {
  test("an admin's project is installed, built, tested and started; its real errors are fixed in one round", async () => {
    const from = calls.length;
    const result = await ask('בנה מחשבון סכומים עם React ו-Express');
    const message = result.final.message;
    assert.equal(result.final.type, 'done');
    assert.deepEqual(message.team.map((row) => [row.role, row.state]), [['architect', 'done'], ['builder', 'done'], ['review', 'done'], ['sandbox', 'done'], ['fix', 'done']]);
    const sandbox = message.team.find((row) => row.role === 'sandbox');
    assert.equal(sandbox.model, 'Docker');
    assert.equal(sandbox.note, 'התקנה (client) ✓ · התקנה (server) ✓ · בנייה (client) ✓ · בדיקות (server) ✓ (1 עברו) · הפעלת השרת (server) ✓');
    assert.equal(message.team.find((row) => row.role === 'fix').note, 'הרצה 1 מתוך 2: תוקנו 2 מתוך 2 קבצים');
    const progress = result.events.filter((event) => event.type === 'team').map((event) => event.team.find((row) => row.role === 'sandbox')?.progress).filter(Boolean);
    assert.ok(progress.some((item) => item.total === 5), 'the steps are counted while they run');

    // The static checks passed: what went back came from the sandbox, the failing test through the triage.
    const fixes = calls.slice(from).filter((call) => call.role === 'builder' && call.prompt.includes('What the QA compiler found'));
    assert.deepEqual(fixes.map((call) => /# The file to write: (\S+)/.exec(call.prompt)[1]).sort(), ['client/src/App.jsx', 'server/util.js']);
    const appFix = fixes.find((call) => call.prompt.includes('# The file to write: client/src/App.jsx')).prompt;
    assert.match(appFix, /- line 3: \[build\] `npm run build` \(client\) failed:\n✗ Build failed in 90ms\nerror during build:\n\[vite:esbuild\] Transform failed with 1 error:\n\/home\/node\/app\/client\/src\/App\.jsx:3:14: ERROR: Top-level await is not available/);
    const triage = calls.slice(from).filter((call) => call.role === 'triage');
    assert.equal(triage.length, 1);
    assert.match(triage[0].prompt, /# The command that failed \(in server\)\nnpm test/);
    assert.match(triage[0].prompt, /not ok 1 - add sums two numbers/);
    assert.match(triage[0].prompt, /## server\/util\.test\.js[\s\S]*## server\/util\.js/, 'the test and what it imports');
    assert.match(fixes.find((call) => call.prompt.includes('# The file to write: server/util.js')).prompt, /\[test\] `npm test` \(server\) failed: add subtracts: it must return a \+ b/);

    // The answer and the ZIP.
    assert.match(message.content, /✓ כל הבדיקות עברו: .*, וסקירת קוד של Sonnet 5\./);
    assert.match(message.content, /✓ הפרויקט הותקן, נבנה והורץ בסביבה מבודדת \(Docker\): התקנה \(client\) ✓ · .* · הפעלת השרת \(server\) ✓\./);
    assert.match(message.content, /סבבי תיקון: 0 · סבבי תיקון אחרי הרצה: 1 · קבצים שתוקנו: 2 · חבילות שנוספו ל-package\.json: cors \(הגרסאות נקבעו לפי ההתקנה\)\./);
    assert.doesNotMatch(message.content, /הבדיקה סטטית|QA_REPORT/);
    const zip = new AdmZip(Buffer.from(await (await api(result.bundle.url.replace(/^\/api/, ''))).arrayBuffer()));
    const read = (name) => zip.getEntries().find((entry) => entry.entryName.endsWith(name)).getData().toString('utf8');
    assert.deepEqual(JSON.parse(read('server/package.json')).dependencies, { cors: '^2.8.5', express: '^5.1.0' }, 'cors pinned to the version that was installed');
    assert.doesNotMatch(read('client/src/App.jsx'), /^const tasks = await/m);
    assert.match(read('server/util.js'), /a \+ b/);

    // The container: locked down, offline before any of the project's code ran, copied into twice, removed.
    const log = await dockerLog();
    const run = log.find((args) => args[0] === 'run');
    for (const flag of ['--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=bridge', '--user']) assert.ok(run.includes(flag), flag);
    const disconnect = log.findIndex((args) => args[0] === 'network' && args[1] === 'disconnect');
    const lastInstall = log.findLastIndex((args) => args.at(-1)?.includes?.('npm install'));
    const firstBuild = log.findIndex((args) => args.at(-1)?.includes?.('npm run build'));
    assert.ok(lastInstall < disconnect && disconnect < firstBuild, 'installs online, everything else offline');
    assert.equal(log.filter((args) => args[0] === 'network').length, 1, 'no second install, so no second trip online');
    assert.equal(log.filter((args) => args[0] === 'exec' && args.includes('tar')).length, 3, 'the project, the pinned package.json files, then the two fixed files');
    assert.deepEqual(log.at(-1).slice(0, 2), ['rm', '-f']);
  });

  test("a member's project gets the static checks only, and the answer says so", async () => {
    const runsBefore = (await dockerLog()).filter((args) => args[0] === 'run').length;
    const result = await ask('בנה מחשבון סכומים עם React ו-Express', MEMBER);
    assert.equal(result.final.type, 'done');
    assert.ok(!result.final.message.team.some((row) => row.role === 'sandbox'));
    assert.match(result.final.message.content, /הבדיקה סטטית: היא לא מתקינה את הפרויקט ולא מריצה אותו\./);
    assert.equal((await dockerLog()).filter((args) => args[0] === 'run').length, runsBefore, 'no container for a member');
  });

  test("a Docker that isn't running is reported, and the project still arrives", async () => {
    await fs.writeFile(path.join(process.env.FAKE_DOCKER_ROOT, 'down'), '');
    const result = await ask('בנה מחשבון סכומים עם React ו-Express');
    await fs.rm(path.join(process.env.FAKE_DOCKER_ROOT, 'down'));
    assert.equal(result.final.type, 'done');
    const sandbox = result.final.message.team.find((row) => row.role === 'sandbox');
    assert.deepEqual([sandbox.state, sandbox.note], ['failed', 'השרת לא מצליח להתחבר ל-Docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?']);
    assert.match(result.final.message.content, /ההרצה בסביבה המבודדת \(Docker\) לא התאפשרה: השרת לא מצליח להתחבר ל-Docker/);
    assert.match(result.final.message.content, /הבדיקה סטטית/, 'nothing ran, so the answer says the checks were static');
    assert.ok(result.bundle, 'the ZIP is there');
  });
});

// Last: the database outlives the server and whatever it was still writing.
after(() => database.stop());
