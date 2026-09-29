// The development team (the swarm) through the chat: the architect's JSON blueprint, the micro-agents writing
// every file in parallel, the QA compiler and its fix rounds, the ZIP, the live cost meter, and the routing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import AdmZip from 'adm-zip';
import { applyPatch } from '../src/services/ai/swarm/runs.js';
import { MEMBER, authHeader, startTestDatabase, tempDir } from './helpers.js';

const storage = await tempDir('stash-pipeline-');
process.env.STORAGE_DIR = storage.dir;
process.env.LOG_REQUESTS = 'false';
process.env.LONG_TERM_MEMORY = 'off'; // the long-term memory and web research have their own suite (chatResearchMemory.test.js)
process.env.ANTHROPIC_API_KEY = 'anthropic-key';
process.env.OPENAI_API_KEY = 'openai-key';
process.env.GEMINI_API_KEY = 'gemini-key';
process.env.DEEPSEEK_API_KEY = 'deepseek-key';
process.env.AI_RETRY_BASE_MS = '5';
for (const name of ['AI_PROVIDER', 'AI_PROVIDERS', 'CHAT_HANDOFF', 'PIPELINE', 'PIPELINE_ARCHITECT', 'PIPELINE_ARCHITECT_FALLBACK', 'PIPELINE_BUILDER', 'PIPELINE_REVIEWER', 'PIPELINE_MAX_FILES', 'PIPELINE_FILE_TOKENS', 'PIPELINE_QA_ROUNDS', 'MOONSHOT_API_KEY', 'AUTO_CONTINUE_MAX']) delete process.env[name];
process.env.PIPELINE_CONCURRENCY = '2';

const S = (text) => `${text} Every function validates its input and handles errors and edge cases exactly as the contracts say.`;
const BLUEPRINT = {
  name: 'tasks-app',
  title: 'משימות',
  summary: 'אפליקציית משימות עם React ושרת Express.',
  stack: ['React 19', 'Vite 7', 'Express 5'],
  architecture: 'A React client built with Vite fetches the tasks from an Express API.',
  contracts: 'GET /api/tasks → 200 [{ "id": string, "title": string, "done": boolean }]',
  packages: [{ path: 'package.json', type: 'module', scripts: { dev: 'vite', server: 'node server/index.js' }, dependencies: { express: '^5.1.0', react: '^19.1.0', 'react-dom': '^19.1.0' }, devDependencies: { vite: '^7.1.0' } }],
  files: [
    { path: 'index.html', purpose: 'The HTML entry', imports: [{ from: '/src/main.jsx' }], spec: S('The page: a root div and the module script /src/main.jsx.') },
    { path: 'src/main.jsx', purpose: 'Mounts the app', imports: [{ from: 'react-dom/client', names: ['createRoot'] }, { from: './App.jsx', names: ['default'] }], spec: S('Mounts <App /> into #root with createRoot.') },
    { path: 'src/App.jsx', purpose: 'The task list', imports: [{ from: 'react', names: ['useEffect', 'useState'] }, { from: './api.js', names: ['fetchTasks'] }], exports: [{ name: 'default', kind: 'component', signature: 'App()' }], spec: S('Loads the tasks with fetchTasks and lists their titles.') },
    { path: 'src/api.js', purpose: 'The API client', exports: [{ name: 'fetchTasks', kind: 'function', signature: 'fetchTasks(): Promise<Task[]>' }], spec: S('fetchTasks() GETs /api/tasks, throws on a non-2xx status and returns the JSON.') },
    { path: 'server/index.js', purpose: 'The API server', imports: [{ from: 'express', names: ['default'] }], spec: S('An Express 5 app: GET /api/tasks returns the tasks; it listens on PORT or 3000.') },
    { path: 'README.md', purpose: 'How to run it', spec: S('How to install and run it, with a bash code block.') },
  ],
  run: 'npm install\nnpm run dev',
};
// A plan with a path outside the project: the architect gets it back, and repeats it.
const BAD_BLUEPRINT = { ...BLUEPRINT, files: [...BLUEPRINT.files, { path: '../evil.js', purpose: 'x', spec: S('x') }] };
const MAIN_PART = "import { createRoot } from 'react-dom/client';\nimport App from './Ap";
const MAIN_REST = "p.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n";
// What the micro-agents write: a first version with the planted problems, and the fix.
const CODE = {
  'index.html': () => '```html\n<!doctype html>\n<html lang="he" dir="rtl">\n  <head><meta charset="utf-8" /><title>משימות</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>\n</html>\n```',
  'src/App.jsx': (fixed) =>
    `import { useEffect, useState } from 'react';\nimport { fetchTasks } from './api.js';\n\nexport default function App() {\n  const [tasks, setTasks] = useState([]);\n  useEffect(() => {\n    ${fixed ? 'fetchTasks().then(setTasks).catch(() => setTasks([]));' : '// TODO: add logic here'}\n  }, []);\n  return <ul>{tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>;\n}\n`,
  'src/api.js': (fixed) =>
    fixed
      ? "export async function fetchTasks() {\n  const response = await fetch('/api/tasks');\n  if (!response.ok) throw new Error(`HTTP ${response.status}`);\n  return response.json();\n}\n"
      : "export async function getTasks() {\n  const response = await fetch('/api/tasks');\n  return response.json();\n}\n",
  'server/index.js': (fixed) =>
    `import express from 'express';\nimport cors from 'cors';\n\nconst app = express();\napp.use(cors());\napp.get('${fixed ? '/api/tasks' : '/api/task'}', (req, res) => res.json([{ id: '1', title: 'לקנות חלב', done: false }]));\napp.listen(process.env.PORT ?? 3000);\n`,
  'README.md': () => '# משימות\n\n```bash\nnpm install\nnpm run dev\n```\n',
};
function builderAnswer(file, { fix, continuation }) {
  if (file === 'src/main.jsx' && !fix) return continuation ? { text: MAIN_REST } : { text: MAIN_PART, cut: true };
  if (!CODE[file]) return { text: `export const unplanned = ${JSON.stringify(file)};\n` };
  return { text: CODE[file](fix && !(scenario === 'stubborn' && file === 'src/api.js')) };
}
// The reviewer: one real problem the compiler can't see, and one about code that isn't there (dropped).
function reviewAnswer(prompt) {
  const issues = [];
  if (prompt.includes("app.get('/api/task'")) {
    issues.push({ path: 'server/index.js', line: 2, kind: 'contract', message: 'The route must be /api/tasks, as the contracts say.', evidence: "app.get('/api/task'," });
    issues.push({ path: 'src/main.jsx', line: 4, kind: 'logic', message: 'ReactDOM.render was removed in React 19.', evidence: 'ReactDOM.render(<App />' });
  }
  return JSON.stringify({ issues });
}

const realFetch = globalThis.fetch;
const calls = [];
let rating = { complexity: 8, category: 'code', kind: 'planning', output: 'massive', reason: 'אפליקציה מלאה' };
let scenario = 'normal';
let architectDelay = 0;
let inFlight = 0;
let mostInFlight = 0;
const sse = (events) =>
  new Response(events.map((event) => (typeof event === 'string' ? `${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`)).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const claude = (text, stop = 'end_turn') =>
  sse([
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stop }, usage: { input_tokens: 900, output_tokens: 400 } })}`,
  ]);
const openai = (text, finish = 'stop') =>
  sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 800, completion_tokens: 500 } }, 'data: [DONE]']);
const gemini = (text, finish = 'STOP') => sse([{ candidates: [{ content: { parts: [{ text }] }, finishReason: finish }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 300 } }]);
const systemOf = (body) => (typeof body.system === 'string' ? body.system : (body.messages?.find((message) => message.role === 'system')?.content ?? body.systemInstruction?.parts?.[0]?.text ?? ''));
const partsText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '');
const messageText = (message) => (message?.parts ? message.parts.map((part) => part.text ?? '').join('') : partsText(message?.content));
const textOf = (body) => (body?.contents ?? body?.messages ?? []).map(messageText).join('\n');
const lastTextOf = (body) => messageText((body?.contents ?? body?.messages ?? []).at(-1));
const roleOf = (system) =>
  system.includes('You are the Master Architect') ? 'architect' : system.includes('You are an expert compiler') ? 'builder' : system.includes('You are the QA compiler') ? 'review' : null;

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
  const system = body ? systemOf(body) : '';
  const role = roleOf(system);
  const provider = href.startsWith('https://generativelanguage.googleapis.com/')
    ? 'gemini'
    : href.startsWith('https://api.anthropic.com/')
      ? 'anthropic'
      : href.startsWith('https://api.deepseek.com/')
        ? 'deepseek'
        : href.startsWith('https://api.openai.com/')
          ? 'openai'
          : null;
  const prompt = textOf(body);
  const call = {
    url: href,
    body,
    role,
    provider,
    model: body?.model ?? href.match(/models\/([^:]+):/)?.[1],
    file: role === 'builder' ? (/# The file to write: (\S+)/.exec(prompt)?.[1] ?? null) : null,
    fix: role === 'builder' && prompt.includes('What the QA compiler found'),
    continuation: role === 'builder' && lastTextOf(body).includes('Your file was cut off'),
  };
  calls.push(call);
  const reply = (text, cut = false) => (provider === 'gemini' ? gemini(text, cut ? 'MAX_TOKENS' : 'STOP') : provider === 'anthropic' ? claude(text, cut ? 'max_tokens' : 'end_turn') : openai(text, cut ? 'length' : 'stop'));
  if (role === 'builder') {
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    const answer = builderAnswer(call.file, call);
    return reply(answer.text, answer.cut);
  }
  if (role === 'architect') {
    if (architectDelay) await new Promise((resolve) => setTimeout(resolve, architectDelay));
    if (scenario === 'architect-broken') return provider === 'openai' ? json({ error: { message: 'The server had an error' } }, 500) : reply('אני לא יכול לתכנן את זה.');
    return reply(JSON.stringify(scenario === 'architect-invalid' && provider === 'openai' ? BAD_BLUEPRINT : BLUEPRINT));
  }
  if (role === 'review') return reply(reviewAnswer(prompt));
  if (provider === 'gemini' && system.includes('You route chat requests')) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(rating) }] } }] });
  if (provider) return reply(`תשובה מ-${provider}`);
  throw new Error(`Unexpected request: ${href}`);
};

const database = await startTestDatabase();
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { extractCodeFiles } = await import('../src/services/chat/codeBundles.js');
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

const api = (route, init) => realFetch(`${base}${route}`, init);
const post = (route, body) => api(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const newChat = async () => (await (await post('/chat/conversations', {})).json()).conversation.id;
async function ask(id, body) {
  const response = await post(`/chat/conversations/${id}/messages`, { workspace: 'premium', effort: 'low', premiumModel: 'auto', ...body });
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  return {
    events,
    streamed: events.filter((event) => event.type === 'text').map((event) => event.text).join(''),
    final: events.find((event) => event.type === 'done' || event.type === 'error'),
    route: events.find((event) => event.type === 'route')?.route,
    bundle: events.find((event) => event.type === 'bundle')?.bundle,
  };
}
const teamCalls = (from) => calls.slice(from).filter((call) => call.role);

describe('The swarm (development team)', () => {
  /** The run's Server-Sent Events, read to the end: the status, the content type and the events. */
  const listen = async (runId, init = {}) => {
    const response = await api(`/chat/runs/${runId}/events`, init);
    if (response.status !== 200) return { status: response.status, body: await response.json() };
    const text = await response.text();
    const events = text
      .split('\n\n')
      .filter((block) => /^data:/m.test(block))
      .map((block) => ({ event: /^event: (.+)$/m.exec(block)?.[1] ?? 'message', data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) }));
    return { status: 200, type: response.headers.get('content-type'), events };
  };
  const askAs = async (user, content) => {
    const headers = { 'content-type': 'application/json', ...authHeader(user) };
    const id = (await (await api('/chat/conversations', { method: 'POST', headers, body: '{}' })).json()).conversation.id;
    const response = await api(`/chat/conversations/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ workspace: 'premium', effort: 'low', premiumModel: 'auto', content }) });
    const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
    return { events, final: events.find((event) => event.type === 'done' || event.type === 'error') };
  };

  test('the live dashboard: the run streams over SSE (its whole state, then patches, then end), and the answer saves its final state', async () => {
    scenario = 'normal';
    architectDelay = 150;
    mostInFlight = 0;
    const conversationId = await newChat();
    const response = await api(`/chat/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'premium', effort: 'low', premiumModel: 'auto', content: 'בנה אפליקציית משימות עם React ו-Express' }),
    });
    // Read the answer as it streams, and start listening to the run as soon as it's announced.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = '';
    let listening = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === 'pipeline' && !listening) listening = listen(event.runId);
      }
    }
    architectDelay = 0;
    const final = events.find((event) => event.type === 'done');
    const live = await listening;
    assert.equal(live.status, 200);
    assert.match(live.type, /^text\/event-stream/);
    assert.deepEqual([live.events[0].event, live.events[0].data.status, live.events.at(-1).event], ['snapshot', 'running', 'end']);

    // Every patch, applied in order to the first state, makes exactly the state saved with the answer.
    const state = live.events[0].data;
    let most = 0;
    const seen = new Set();
    for (const event of live.events.slice(1, -1)) {
      assert.equal(event.event, 'patch');
      for (const patch of event.data) applyPatch(state, patch);
      most = Math.max(most, state.build.active);
      if (state.architect.draft.length) seen.add(`draft:${state.architect.draft.length}`);
      for (const file of state.files) seen.add(`${file.path}:${file.status}`);
    }
    const pipeline = final.message.pipeline;
    assert.deepEqual(state, pipeline);
    assert.equal(most, 2, 'never more files at once than PIPELINE_CONCURRENCY (2)');
    assert.ok(seen.has('draft:7'), 'the file tree appeared while the architect was still writing its JSON');
    assert.ok(seen.has('src/App.jsx:writing') && seen.has('src/App.jsx:flagged') && seen.has('src/App.jsx:fixing'), 'a file seen writing, flagged, then correcting itself');

    assert.deepEqual([pipeline.status, pipeline.phase, pipeline.runId], ['done', 'done', events.find((event) => event.type === 'pipeline').runId]);
    assert.deepEqual(pipeline.architect.tree.map((item) => item.path), ['package.json', 'index.html', 'src/main.jsx', 'src/App.jsx', 'src/api.js', 'server/index.js', 'README.md']);
    assert.deepEqual([pipeline.architect.status, pipeline.architect.model, pipeline.architect.draft], ['done', 'GPT-6 Sol', []]);
    assert.deepEqual(
      pipeline.files.map((file) => [file.path, file.status]),
      [['index.html', 'written'], ['src/main.jsx', 'written'], ['src/App.jsx', 'fixed'], ['src/api.js', 'fixed'], ['server/index.js', 'fixed'], ['README.md', 'written']],
    );
    const app = pipeline.files.find((file) => file.path === 'src/App.jsx');
    assert.deepEqual([app.attempt, app.maxAttempts, app.fixPhase], [1, 3, 'qa']);
    assert.match(app.snippet, /^Placeholder comment "TODO: add logic here"/);
    assert.equal(app.line, 7);
    assert.ok(pipeline.files.every((file) => file.status === 'fixed' || (file.model && file.lines > 0)), 'each written file with its model and length');
    assert.deepEqual([pipeline.build.status, pipeline.build.done, pipeline.build.failed, pipeline.build.total, pipeline.build.active], ['done', 6, 0, 6, 0]);
    assert.deepEqual([pipeline.qa.status, pipeline.qa.round, pipeline.qa.remaining], ['done', 2, 0]);
    assert.equal(pipeline.sandbox.status, 'off');
    assert.deepEqual([pipeline.package.status, pipeline.package.bundle.files], ['done', 7]);
    assert.ok(pipeline.package.bundle.url);
    assert.deepEqual(pipeline.credits, { status: 'done', charged: 0, after: null, before: null, unlimited: true }, "an admin isn't charged");

    // Only the owner can listen; a finished run still answers its owner, at once; an unknown one doesn't exist.
    const other = await listen(pipeline.runId, { headers: authHeader(MEMBER) });
    assert.deepEqual([other.status, other.body.error.code], [404, 'RUN_NOT_FOUND']);
    const late = await listen(pipeline.runId);
    assert.deepEqual(late.events.map((event) => [event.event, event.data.status]), [['snapshot', 'done'], ['end', undefined]]);
    assert.equal((await listen('00000000-0000-4000-8000-00000000abcd')).status, 404);

    // A member's run records what it cost: a credit per file of the blueprint, with the balance before and after.
    const member = await askAs(MEMBER, 'בנה אפליקציית משימות עם React ו-Express');
    assert.deepEqual(member.final.message.pipeline.credits, { status: 'done', charged: 6, before: 50, after: 44, unlimited: false });
    assert.equal(member.final.credits, 44);
  });

  const zipOf = async (bundle) => {
    const zip = new AdmZip(Buffer.from(await (await api(bundle.url.replace(/^\/api/, ''))).arrayBuffer()));
    return (name) => zip.getEntries().find((entry) => entry.entryName.endsWith(name)).getData().toString('utf8');
  };

  test('a complex coding request: a JSON blueprint, every file written in parallel, the QA compiler, one fix round, and the ZIP', async () => {
    scenario = 'normal';
    mostInFlight = 0;
    const from = calls.length;
    const conversationId = await newChat();
    const result = await ask(conversationId, { content: 'בנה אפליקציית משימות עם React ו-Express' });
    assert.deepEqual([result.route.mode, result.route.label, result.route.complexity], ['pipeline', 'צוות פיתוח', 8]);
    const work = teamCalls(from);

    // 1. The architect plans in strict JSON and writes no code.
    const architect = work.filter((call) => call.role === 'architect');
    assert.deepEqual(architect.map((call) => call.model), ['gpt-6-sol']);
    assert.deepEqual(architect[0].body.response_format, { type: 'json_object' });
    assert.match(systemOf(architect[0].body), /You write NO implementation code/);

    // 2. A micro-agent per file, on two providers, two at a time; a file cut off at the limit is continued.
    const writes = work.filter((call) => call.role === 'builder' && !call.fix && !call.continuation);
    assert.deepEqual(writes.map((call) => call.file).sort(), ['README.md', 'index.html', 'server/index.js', 'src/App.jsx', 'src/api.js', 'src/main.jsx']);
    assert.deepEqual([...new Set(writes.map((call) => call.provider))].sort(), ['deepseek', 'gemini']);
    assert.equal(mostInFlight, 2, 'PIPELINE_CONCURRENCY=2 files at a time');
    assert.deepEqual(work.filter((call) => call.continuation).map((call) => call.file), ['src/main.jsx']);
    assert.match(systemOf(writes[0].body), /^You are an expert compiler generating a single file[\s\S]*ZERO placeholders/);
    assert.ok(textOf(writes.find((call) => call.file === 'src/App.jsx').body).includes('fetchTasks (function): fetchTasks(): Promise<Task[]>'), 'an agent sees the exact interface of what it imports');
    const deepseek = writes.find((call) => call.provider === 'deepseek').body;
    assert.ok(deepseek.max_tokens >= 8_192, `the file's output limit (got ${deepseek.max_tokens})`);

    // 3. The QA compiler: a placeholder and a missing export (the compiler's checks) and a route mismatch (the reviewer)
    // go back for one round; the reviewer's issue about code that isn't there doesn't.
    const fixes = work.filter((call) => call.role === 'builder' && call.fix);
    assert.deepEqual(fixes.map((call) => call.file).sort(), ['server/index.js', 'src/App.jsx', 'src/api.js']);
    const log = (file) => textOf(fixes.find((call) => call.file === file).body);
    assert.match(log('src/App.jsx'), /- line 7: \[placeholder\] Placeholder comment "TODO: add logic here": write the real code\./);
    assert.match(log('src/api.js'), /- \[contract\] Must export "fetchTasks" \(fetchTasks\(\): Promise<Task\[\]>\) as the blueprint says, but doesn't\./);
    assert.match(log('src/api.js'), /# Your previous version of this file\n```\nexport async function getTasks/);
    assert.match(log('server/index.js'), /- line 6: \[contract\] The route must be \/api\/tasks, as the contracts say\./, 'the line comes from the quoted code');
    assert.ok(!fixes.some((call) => call.file === 'src/main.jsx'), 'the imagined issue was dropped');
    const reviews = work.filter((call) => call.role === 'review');
    assert.deepEqual(reviews.map((call) => call.model), ['claude-sonnet-5', 'claude-sonnet-5'], 'the whole codebase, then what changed');
    const second = textOf(reviews[1].body);
    for (const file of ['src/App.jsx', 'src/api.js', 'server/index.js', 'src/main.jsx']) assert.ok(second.includes(`## ${file}\n`), `${file} is reviewed again (changed, or imports a changed file)`);
    assert.ok(!second.includes('## index.html\n') && !second.includes('## README.md\n'), 'unchanged files are not reviewed again');

    // The answer: streamed exactly as saved, the team's steps, and the verdict.
    const message = result.final.message;
    assert.equal(result.streamed, message.content);
    assert.deepEqual([...message.content.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1]), ['משימות', 'בדיקת איכות', 'הרצה', 'הקבצים']);
    assert.match(message.content, /✓ כל הבדיקות עברו: תחביר, ייבוא וייצוא בין הקבצים, חבילות, משתנים לא מוגדרים ומימושים חלקיים, וסקירת קוד של Sonnet 5\./);
    assert.match(message.content, /סבבי תיקון: 1 · קבצים שתוקנו: 3 · חבילות שנוספו ל-package\.json: cors/);
    assert.equal(message.label, 'צוות פיתוח');
    assert.deepEqual(message.team.map((row) => [row.role, row.state]), [['architect', 'done'], ['builder', 'done'], ['review', 'done'], ['fix', 'done']]);
    assert.deepEqual([message.team[0].model, message.team[0].note], ['GPT-6 Sol', '6 קבצים · React 19, Vite 7, Express 5']);
    assert.match(message.team[1].model, /^DeepSeek V4\.1 Flash \+ Gemini/);
    assert.equal(message.team[1].note, '6 הקבצים נכתבו');
    assert.deepEqual([message.team[2].model, message.team[2].note], ['Sonnet 5 + קומפיילר', 'כל הבדיקות עברו אחרי סבב תיקון אחד']);
    assert.equal(message.team[3].note, 'סבב 1 מתוך 3: תוקנו 3 מתוך 3 קבצים');
    const updates = result.events.filter((event) => event.type === 'team');
    assert.deepEqual([...new Set(updates.flatMap((event) => event.team.filter((row) => row.state === 'working').map((row) => row.role)))], ['architect', 'builder', 'review', 'fix']);
    assert.ok(updates.some((event) => event.team.find((row) => row.role === 'builder')?.progress?.total === 6), 'the files are counted');

    // The ZIP: every file, the fixes in, the stray fence out, the added package declared.
    assert.deepEqual(result.bundle.files.map((file) => file.path ?? file).sort(), ['README.md', 'index.html', 'package.json', 'server/index.js', 'src/App.jsx', 'src/api.js', 'src/main.jsx']);
    const read = await zipOf(result.bundle);
    assert.equal(read('src/main.jsx'), MAIN_PART + MAIN_REST, 'the continuation is joined without a seam');
    assert.match(read('src/api.js'), /export async function fetchTasks/);
    assert.match(read('server/index.js'), /app\.get\('\/api\/tasks'/);
    assert.doesNotMatch(read('src/App.jsx'), /TODO/);
    assert.ok(read('index.html').startsWith('<!doctype html>'), "the fence an agent added isn't in the file");
    assert.match(read('README.md'), /```bash\nnpm install/);
    assert.deepEqual(JSON.parse(read('package.json')).dependencies, { cors: 'latest', express: '^5.1.0', react: '^19.1.0', 'react-dom': '^19.1.0' });

    // The cost meter: it moved with every call, and it's broken down by role.
    const live = result.events.filter((event) => event.type === 'usage').map((event) => event.conversationUsage.cost);
    assert.ok(live.length >= 10, `usage after every call (got ${live.length})`);
    assert.ok(live.every((cost, index) => index === 0 || cost >= live[index - 1]), 'the running cost only grows');
    assert.ok(Math.abs(live.at(-1) - result.final.conversationUsage.cost) < 1e-9);
    const detail = await (await api(`/chat/conversations/${conversationId}/usage`)).json();
    const byRole = Object.fromEntries(detail.usage.byRole.map((item) => [item.role, item.label]));
    assert.deepEqual([byRole.architect, byRole.builder, byRole.qa, byRole.fix], ['צוות: תוכנית', 'צוות: כתיבת קבצים', 'צוות: בדיקת QA', 'צוות: תיקונים']);
  });

  test("what three fix rounds can't fix is reported, not hidden: each round on the other model, then QA_REPORT.md", async () => {
    scenario = 'stubborn';
    const from = calls.length;
    const result = await ask(await newChat(), { content: 'בנה אפליקציית משימות עם React ו-Express' });
    const apiFixes = teamCalls(from).filter((call) => call.fix && call.file === 'src/api.js');
    assert.equal(apiFixes.length, 3, 'three fix rounds, no more');
    assert.deepEqual(apiFixes.slice(1).map((call) => call.provider), ['deepseek', 'gemini'], 'each round starts on the other lane');
    const message = result.final.message;
    assert.match(message.content, /⚠️ אחרי 3 סבבי תיקון נותרה בעיה אחת בקובץ אחד\. היא מפורטת בקובץ QA_REPORT\.md בסוף התשובה\./);
    assert.deepEqual(message.team.map((row) => [row.role, row.state]), [['architect', 'done'], ['builder', 'done'], ['review', 'failed'], ['fix', 'done']]);
    assert.equal(message.team[2].note, 'נותרה בעיה אחת בקובץ אחד');
    assert.equal(message.team[3].note, 'סבב 3 מתוך 3: הקובץ לא תוקן');
    assert.match(JSON.stringify(result.final), /הבדיקה האוטומטית לא הצליחה לתקן בעיה אחת: היא מפורטת בסוף התשובה ובקובץ QA_REPORT\.md/);
    assert.ok(result.bundle.files.map((file) => file.path ?? file).includes('QA_REPORT.md'));
    const read = await zipOf(result.bundle);
    assert.match(read('QA_REPORT.md'), /## src\/api\.js\n\n- Must export "fetchTasks" \(fetchTasks\(\): Promise<Task\[\]>\) as the blueprint says, but doesn't\./);
    assert.match(read('src/App.jsx'), /fetchTasks\(\)\.then/, 'what could be fixed was');
  });

  test('the blueprint is validated: its problems go back to the architect once, then Opus 5.5 plans', async () => {
    scenario = 'architect-invalid';
    const from = calls.length;
    const result = await ask(await newChat(), { content: 'בנה אפליקציית משימות' });
    const architect = teamCalls(from).filter((call) => call.role === 'architect');
    assert.deepEqual(architect.map((call) => call.model), ['gpt-6-sol', 'gpt-6-sol', 'claude-opus-5-5']);
    assert.match(lastTextOf(architect[1].body), /^The blueprint has these problems:\n- files\[6\] "\.\.\/evil\.js": must be a relative path inside the project\.\n\nReturn the complete corrected blueprint as one JSON object\.$/);
    const [row] = result.final.message.team;
    assert.deepEqual([row.model, row.state], ['Opus 5.5', 'done']);
    assert.equal(row.note, '6 קבצים · React 19, Vite 7, Express 5 · GPT-6 Sol נכשל, ולכן Opus 5.5 תכנן', 'the timeline says who planned');
    assert.equal(result.bundle.files.length, 7, 'the team carried on from the fallback plan');
  });

  test('with no valid blueprint from any architect, the turn fails clearly and no agent writes blind', async () => {
    scenario = 'architect-broken';
    const from = calls.length;
    const result = await ask(await newChat(), { content: 'בנה אפליקציית משימות' });
    assert.equal(result.final.type, 'error');
    assert.match(JSON.stringify(result.final), /הארכיטקט לא הצליח לבנות תוכנית תקינה לפרויקט/);
    const last = result.events.filter((event) => event.type === 'team').at(-1).team;
    assert.deepEqual([last[0].role, last[0].state], ['architect', 'failed']);
    assert.equal(teamCalls(from).filter((call) => call.role === 'builder').length, 0);
    scenario = 'normal';
  });

  test('simple requests go to Haiku 4.5; follow-ups, non-code and a switched-off team stay with one model', async () => {
    rating = { complexity: 3, category: 'quick', kind: 'question', output: 'short', reason: 'שאלה קצרה' };
    assert.equal((await ask(await newChat(), { content: 'מה זה REST?' })).route.label, 'Haiku 4.5');
    const id = await newChat();
    rating = { complexity: 8, category: 'code', kind: 'planning', output: 'massive', reason: 'אפליקציה' };
    assert.equal((await ask(id, { content: 'בנה אפליקציה' })).route.mode, 'pipeline');
    rating = { complexity: 8, category: 'code', kind: 'implementation', output: 'long', reason: 'הוספת יכולת' };
    const followUp = await ask(id, { content: 'הוסף התחברות' });
    assert.equal(followUp.route.mode, 'auto', 'a follow-up in a project goes to one model');
    rating = { complexity: 8, category: 'code', kind: 'planning', output: 'long', reason: 'מודול חדש' };
    assert.equal((await ask(id, { content: 'תכנן מודול תשלומים' })).route.mode, 'pipeline', 'a new plan brings the team back');
    assert.equal((await ask(await newChat(), { content: 'בנה אפליקציה', pipeline: false })).route.mode, 'auto', 'the switch turns the team off');
    rating = { complexity: 9, category: 'reasoning', kind: 'planning', output: 'long', reason: 'ארכיטקטורה' };
    assert.equal((await ask(await newChat(), { content: 'השווה ארכיטקטורות' })).route.label, 'Opus 5.5', 'a hard question without code goes to Opus');
  });

  test('thinking can\'t use up the answer: a reserve on top for OpenAI and Gemini, and low thinking for the router', async () => {
    rating = { complexity: 3, category: 'quick', kind: 'question', output: 'short', reason: 'שאלה' };
    const from = calls.length;
    await ask(await newChat(), { content: 'שאלה', premiumModel: 'gemini-flash', effort: 'high' });
    const answer = calls.slice(from).find((call) => call.url.includes('streamGenerateContent')).body.generationConfig;
    assert.deepEqual(answer, { maxOutputTokens: 8_192 + 16_384, thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } });
    await ask(await newChat(), { content: 'שאלה', premiumModel: 'gpt-5.6-sol', effort: 'medium' });
    assert.equal(calls.at(-1).body.max_completion_tokens, 4_096 + 8_192);
    await ask(await newChat(), { content: 'שאלה', premiumModel: 'gpt-4o-mini', effort: 'medium' });
    assert.equal(calls.at(-1).body.max_completion_tokens, 4_096, 'a model without reasoning gets no reserve');
    const router = calls.filter((call) => systemOf(call.body ?? {}).includes('You route chat requests')).at(-1).body.generationConfig;
    assert.deepEqual(router.thinkingConfig, { thinkingLevel: 'low', includeThoughts: false });
  });

  test('the catalog lists the swarm and every 2026 OpenAI model', async () => {
    const catalog = await (await api('/chat/catalog')).json();
    assert.equal(catalog.premium.pipeline.available, true);
    const team = catalog.premium.pipeline.team;
    assert.deepEqual(team.map((member) => member.role), ['architect', 'builder', 'review']);
    assert.deepEqual([team[0].model, team[0].fallback, team[2].model], ['GPT-6 Sol', 'Opus 5.5', 'Sonnet 5']);
    assert.match(team[1].model, /^DeepSeek V4\.1 Flash \+ Gemini/);
    const labels = catalog.premium.models.map((model) => model.label);
    for (const label of ['GPT-6 Astra', 'GPT-6 Sol', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna', 'Opus 5.5', 'Sonnet 5', 'Haiku 4.5', 'DeepSeek V4.1 Flash', 'Gemini Pro']) assert.ok(labels.includes(label), label);
  });

  test('a later block replaces a file only when it is complete: excerpts are skipped, spread syntax is not an excerpt', () => {
    const md = [
      '```js src/a.js', 'export const a = 1;', 'export const b = 2;', '```',
      '```js src/a.js', '// ... existing code', 'export const b = 3;', '```',
      '```js src/c.js', 'const c = { x: 1 };', '```',
      '```js src/c.js', 'const c = {', '  ...defaults,', '  x: 2,', '};', '```',
    ].join('\n');
    const files = Object.fromEntries(extractCodeFiles(md).map((file) => [file.path, file.content]));
    assert.match(files['src/a.js'], /b = 2/, 'the excerpt did not replace the complete file');
    assert.match(files['src/c.js'], /\.\.\.defaults/, 'a complete file with spread syntax replaced the earlier one');
  });
});

// Last: the database outlives the server and whatever it was still writing.
after(() => database.stop());
