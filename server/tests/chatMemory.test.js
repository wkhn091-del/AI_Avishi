// Chat memory and code: project_state.md compaction, multi-file ZIP packaging, and GitHub context.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import AdmZip from 'adm-zip';
import { startTestDatabase, tempDir } from './helpers.js';

const storage = await tempDir('stash-memory-');
process.env.STORAGE_DIR = storage.dir;
process.env.LOG_REQUESTS = 'false';
process.env.LONG_TERM_MEMORY = 'off'; // the long-term memory and web research have their own suite (chatResearchMemory.test.js)
process.env.GROQ_API_KEY = 'groq-key';
process.env.GEMINI_API_KEY = 'gemini-key';
process.env.GITHUB_TOKEN = 'ghp_testtoken1234567890abcdefghij';
process.env.CHAT_COMPACT_EVERY = '2';
process.env.CHAT_KEEP_RECENT = '3';
delete process.env.AI_PROVIDER;
delete process.env.AI_PROVIDERS;
process.env.AI_RETRY_BASE_MS = '5';

const realFetch = globalThis.fetch;
const groqBodies = [];
const CODE_ANSWER = [
  'הנה שני קבצים:',
  '',
  '```js src/app.js',
  "import './styles.css';",
  "console.log('שלום');",
  '```',
  '',
  '**src/styles.css**',
  '```css',
  'body { margin: 0; }',
  '```',
].join('\n');
const STATE = '# project_state.md\n## מטרות\n- אפליקציית בדיקה\n## מבנה הקוד\n- src/app.js';

function sse(text) {
  const body = [JSON.stringify({ choices: [{ delta: { content: text } }] }), JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), '[DONE]']
    .map((line) => `data: ${line}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const repo = { full_name: 'rozen-dev/demo', name: 'demo', owner: { login: 'rozen-dev' }, private: true, default_branch: 'main', language: 'JavaScript', description: 'Demo repo', html_url: 'https://github.com/rozen-dev/demo' };
const REPO_FILES = { 'README.md': '# Demo\nA demo app.', 'src/app.js': 'export const answer = 42;\n', 'node_modules/x/index.js': 'skip' };

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const body = init.body ? JSON.parse(init.body) : null;
  if (href === 'https://api.groq.com/openai/v1/models') return json({ data: [{ id: 'openai/gpt-oss-120b' }] });
  if (href === 'https://api.groq.com/openai/v1/chat/completions') {
    groqBodies.push(body);
    const question = body.messages.at(-1).content;
    return sse(question.includes('צור קבצים') ? CODE_ANSWER : `תשובה ל: ${question}`);
  }
  if (href.startsWith('https://generativelanguage.googleapis.com/')) return json({ candidates: [{ content: { parts: [{ text: STATE }] } }] });
  if (href.startsWith('https://api.github.com/')) {
    assert.equal(init.headers.Authorization, `Bearer ${process.env.GITHUB_TOKEN}`);
    const { pathname } = new URL(href);
    if (pathname === '/repos/rozen-dev/demo') return json(repo);
    if (pathname === '/repos/rozen-dev/demo/git/trees/main') {
      return json({ sha: 'tree-1', truncated: false, tree: Object.entries(REPO_FILES).map(([path, text]) => ({ path, type: 'blob', sha: path, size: text.length })) });
    }
    const file = decodeURIComponent(pathname.replace('/repos/rozen-dev/demo/contents/', ''));
    if (REPO_FILES[file]) return new Response(REPO_FILES[file], { status: 200 });
    return json({ message: 'Not Found' }, 404);
  }
  throw new Error(`Unexpected request: ${href}`);
};

const database = await startTestDatabase();
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { extractCodeFiles, zipFiles } = await import('../src/services/chat/codeBundles.js');
console.warn = () => {};

let server;
let base;
let store;
let chatId;

before(async () => {
  await Promise.all([config.paths.archives, config.paths.files].map((dir) => fs.mkdir(dir, { recursive: true })));
  store = new JsonStore(config.paths.database);
  await store.init();
  server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  chatId = (await (await post('/chat/conversations', {})).json()).conversation.id;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.flush();
  await storage.cleanup();
});

const api = (route, init) => realFetch(`${base}${route}`, init);
const post = (route, body) => api(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function ask(content) {
  const response = await post(`/chat/conversations/${chatId}/messages`, { content, workspace: 'free', freeMode: 'manual', provider: 'groq' });
  return (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
}

describe('Chat memory, code packaging and GitHub context', () => {
  test('code blocks are recognised by the path on the fence, the label above, or a first-line comment', () => {
    const files = extractCodeFiles(['```jsx src/App.jsx', 'export default 1;', '```', '### server/index.js', '```js', 'x()', '```', '```css', '/* styles/main.css */', 'a{}', '```', '```js', 'not a file', '```'].join('\n'));
    assert.deepEqual(files.map((file) => file.path), ['src/App.jsx', 'server/index.js', 'styles/main.css']);
    assert.equal(files[2].content, 'a{}\n');
    assert.equal(zipFiles([{ path: 'package.json', content: '{"name": "@rozen/todo_app"}' }, ...files]).fileName, 'todo-app.zip');
    assert.equal(zipFiles(files).fileName, 'stash-code.zip');
  });

  test('an answer with several files comes with a ZIP of them', async () => {
    const events = await ask('צור קבצים לאפליקציה');
    const bundle = events.find((event) => event.type === 'bundle').bundle;
    assert.deepEqual(bundle.files.map((file) => file.path), ['src/app.js', 'src/styles.css']);
    const response = await realFetch(`${base.replace('/api', '')}${bundle.url}`);
    assert.match(response.headers.get('content-disposition'), /attachment; filename="stash-code\.zip"/);
    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(zip.getEntries().map((entry) => entry.entryName).sort(), ['stash-code/src/app.js', 'stash-code/src/styles.css']);
    assert.equal(zip.readAsText('stash-code/src/styles.css'), 'body { margin: 0; }\n');
    assert.equal(events.find((event) => event.type === 'memory'), undefined, 'one turn: no compaction yet');
  });

  test('every N turns project_state.md is rewritten by a fast model and the context shrinks', async () => {
    const events = await ask('מה הצעד הבא?');
    assert.deepEqual(events.filter((event) => event.type === 'memory').map((event) => event.status), ['updating', 'updated']);
    const memory = (await (await api(`/chat/conversations/${chatId}/memory`)).json()).memory;
    assert.match(memory.state, /## מטרות/);
    assert.equal(memory.compactions, 1);
    assert.equal(memory.windowStart, 1, 'four messages, the last three kept');
    assert.equal(memory.by.provider, 'gemini');

    await ask('ומה עם בדיקות?');
    const request = groqBodies.at(-1);
    assert.match(request.messages[0].content, /# project_state\.md[\s\S]*אפליקציית בדיקה/);
    const sent = request.messages.slice(1).map((message) => message.content);
    assert.ok(!sent.some((content) => content.includes('צור קבצים')), 'the first question is no longer sent');
    assert.deepEqual(sent.at(-1), 'ומה עם בדיקות?');
  });

  test('project_state.md can be downloaded, and compacted on demand', async () => {
    const download = await api(`/chat/conversations/${chatId}/memory?download=1`);
    assert.match(download.headers.get('content-disposition'), /project_state\.md/);
    assert.match(await download.text(), /## מבנה הקוד/);
    const compacted = await (await post(`/chat/conversations/${chatId}/memory/compact`, {})).json();
    assert.equal(compacted.memory.compactions, 2);
  });

  test('a referenced GitHub repository adds its tree, README and requested file to the context', async () => {
    const events = await ask('מה עושה @rozen-dev/demo:src/app.js ?');
    const context = events.find((event) => event.type === 'context').github[0];
    assert.equal(context.fullName, 'rozen-dev/demo');
    assert.equal(context.private, true);
    assert.equal(context.files, 2, 'node_modules is skipped');
    assert.deepEqual(context.included, ['README.md', 'src/app.js']);
    const system = groqBodies.at(-1).messages[0].content;
    assert.match(system, /# GitHub context[\s\S]*## rozen-dev\/demo \(private\)[\s\S]*export const answer = 42;/);
    const saved = (await (await api(`/chat/conversations/${chatId}`)).json()).conversation.messages;
    assert.equal(saved.findLast((message) => message.role === 'user').context.github[0].fullName, 'rozen-dev/demo');
  });
});

// Last: the database outlives the server and whatever it was still writing.
after(() => database.stop());
