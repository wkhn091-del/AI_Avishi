// Hebrew file explanations through Gemini, with Gemini's HTTP API stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { makeZip, tempDir } from './helpers.js';

const storage = await tempDir('stash-explain-');
process.env.STORAGE_DIR = storage.dir;
process.env.AI_PROVIDER = 'gemini';
process.env.AI_API_KEY = 'test-key';
process.env.LOG_REQUESTS = 'false';

const PROJECT_ANSWER = { title: 'אפליקציית מזג אוויר', description: 'תחזית לפי עיר.', tags: ['מזג אוויר'] };
let fileAnswer = { summary: 'זו נקודת הכניסה של האפליקציה: הקובץ מרנדר את רכיב App לתוך האלמנט root.', points: ['מייבא את React ואת App', 'Renders App'] };
const geminiCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) return realFetch(url, init);
  const body = init.body;
  const answer = body.includes('catalogue software projects') ? PROJECT_ANSWER : fileAnswer;
  if (!body.includes('catalogue software projects')) geminiCalls.push(JSON.parse(body));
  const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { EXPLAIN_RULE } = await import('../src/services/projects/fileExplainer.js');

let server;
let base;
let store;
let project;

before(async () => {
  await Promise.all([config.paths.archives, config.paths.files].map((dir) => fs.mkdir(dir, { recursive: true })));
  store = new JsonStore(config.paths.database);
  await store.init();
  server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const file = await makeZip(storage.dir, 'app.zip', {
    'src/main.jsx': 'import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")).render(<App />);\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  const form = new FormData();
  form.append('archive', new Blob([await fs.readFile(file)]), 'app.zip');
  project = (await (await realFetch(`${base}/api/projects`, { method: 'POST', body: form })).json()).project;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.flush();
  await storage.cleanup();
});

const explain = (body) =>
  realFetch(`${base}/api/projects/${project.id}/files/explain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('file explanations', () => {
  test('the project summary itself came back in Hebrew', () => {
    assert.equal(project.title, 'אפליקציית מזג אוויר');
  });

  test('explains a file in Hebrew, with the Hebrew rule in the request', async () => {
    const response = await explain({ path: 'src/main.jsx' });
    assert.equal(response.status, 200);
    const { explanation } = await response.json();
    assert.equal(explanation.summary, fileAnswer.summary);
    assert.deepEqual(explanation.points, ['מייבא את React ואת App'], 'points without Hebrew are dropped');
    assert.equal(explanation.provider, 'gemini');
    assert.equal(explanation.cached, false);

    const request = JSON.stringify(geminiCalls.at(-1));
    assert.ok(request.includes(EXPLAIN_RULE), 'system prompt carries the Hebrew rule');
    assert.ok(request.includes('createRoot'), 'the file content is sent');
  });

  test('a second request is served from the cache; refresh asks again', async () => {
    const calls = geminiCalls.length;
    const cached = (await (await explain({ path: 'src/main.jsx' })).json()).explanation;
    assert.equal(cached.cached, true);
    assert.equal(geminiCalls.length, calls);
    const refreshed = (await (await explain({ path: 'src/main.jsx', refresh: true })).json()).explanation;
    assert.equal(refreshed.cached, false);
    assert.equal(geminiCalls.length, calls + 1);
  });

  test('an answer that is not in Hebrew is rejected with a Hebrew error', async () => {
    fileAnswer = { summary: 'This file renders the app.', points: [] };
    const response = await explain({ path: 'src/main.jsx', refresh: true });
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.equal(error.code, 'AI_FAILED');
    assert.match(error.message, /בעברית/);
  });

  test('binary files are not sent to the model', async () => {
    const calls = geminiCalls.length;
    assert.equal((await explain({ path: 'logo.png' })).status, 415);
    assert.equal(geminiCalls.length, calls);
  });

  test('deleting the project deletes its explanations', async () => {
    assert.ok(store.list('explanations').some((item) => item.projectId === project.id));
    assert.equal((await realFetch(`${base}/api/projects/${project.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(store.list('explanations').filter((item) => item.projectId === project.id).length, 0);
  });
});
