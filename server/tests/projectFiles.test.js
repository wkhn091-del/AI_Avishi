// Archive browsing: file tree, code content, the /serve static server, preview planning and the preview origin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { makeZip, tempDir } from './helpers.js';

const storage = await tempDir('stash-files-');
process.env.STORAGE_DIR = storage.dir;
process.env.AI_PROVIDER = 'none';
process.env.LOG_REQUESTS = 'false';

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');
const { mimeTypeOf } = await import('../src/lib/mime.js');

let server;
let base;
let port;
let store;
const HEBREW = /[\u05D0-\u05EA]/;

before(async () => {
  await Promise.all([config.paths.archives, config.paths.files].map((dir) => fs.mkdir(dir, { recursive: true })));
  store = new JsonStore(config.paths.database);
  await store.init();
  server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.flush();
  await storage.cleanup();
});

async function upload(name, entries) {
  const file = await makeZip(storage.dir, name, entries);
  const form = new FormData();
  form.append('archive', new Blob([await fs.readFile(file)]), name);
  const response = await fetch(`${base}/api/projects`, { method: 'POST', body: form });
  assert.equal(response.status, 201);
  return (await response.json()).project;
}

/** Request with an explicit Host header (fetch doesn't allow setting it). */
function hostRequest(host, route, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}${route}`, { method, headers: { host } }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

const SITE = {
  'weather-main/README.md': '# תחזית ימית\n\nתחזית לשייטים.\n',
  'weather-main/package.json': JSON.stringify({ name: 'weather', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '19' }, devDependencies: { vite: '7' } }),
  'weather-main/index.html': '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  'weather-main/src/main.tsx': 'console.log("שלום עולם");\n',
  'weather-main/dist/index.html': '<!doctype html><link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script><h1>Site</h1>',
  'weather-main/dist/assets/app.js': 'document.title = "ok";',
  'weather-main/dist/assets/app.css': 'h1 { color: red }',
  'weather-main/node_modules/react/index.js': 'module.exports = {};',
  'weather-main/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  'weather-main/big.txt': 'a'.repeat(1.2 * 1024 * 1024),
};

describe('file tree and content', () => {
  let project;
  before(async () => (project = await upload('weather-main.zip', SITE)));

  test('tree: wrapper unwrapped, folders first, dependency folders hidden, build output visible', async () => {
    const response = await fetch(`${base}/api/projects/${project.id}/files`);
    assert.equal(response.status, 200);
    const { tree, fileCount, hidden } = await response.json();
    const names = tree.children.map((child) => child.name);
    assert.deepEqual(names.slice(0, 2), ['dist', 'src']);
    assert.ok(names.includes('README.md') && names.includes('logo.png'));
    assert.ok(!names.includes('node_modules') && !names.includes('weather-main'));
    assert.equal(fileCount, 9);
    assert.deepEqual(hidden, { count: 1, folders: ['node_modules'] });
  });

  test('content: raw UTF-8 text', async () => {
    const response = await fetch(`${base}/api/projects/${project.id}/files/content?path=${encodeURIComponent('src/main.tsx')}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8/);
    assert.equal(await response.text(), 'console.log("שלום עולם");\n');
  });

  test('content: binary, too large, missing and traversal paths are refused in Hebrew', async () => {
    const cases = [['logo.png', 415, 'BINARY_FILE'], ['big.txt', 413, 'FILE_TOO_LARGE_TO_VIEW'], ['nope.txt', 404, 'FILE_NOT_FOUND'], ['../etc/passwd', 400, 'INVALID_PATH']];
    for (const [filePath, status, code] of cases) {
      const response = await fetch(`${base}/api/projects/${project.id}/files/content?path=${encodeURIComponent(filePath)}`);
      assert.equal(response.status, status, filePath);
      const { error } = await response.json();
      assert.equal(error.code, code);
      assert.match(error.message, HEBREW);
    }
  });

  test('serve: folders redirect to a trailing slash, documents are sandboxed, downloads are attachments', async () => {
    const redirect = await fetch(`${base}/api/projects/${project.id}/serve/dist`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.ok(redirect.headers.get('location').endsWith(`/api/projects/${project.id}/serve/dist/`));

    const page = await fetch(`${base}/api/projects/${project.id}/serve/dist/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<h1>Site<\/h1>/);
    assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts/);
    assert.equal(page.headers.get('access-control-allow-origin'), '*');

    const script = await fetch(`${base}/api/projects/${project.id}/serve/dist/assets/app.js`);
    assert.match(script.headers.get('content-type'), /^text\/javascript/);

    const download = await fetch(`${base}/api/projects/${project.id}/serve/README.md?download=1`);
    assert.match(download.headers.get('content-disposition'), /^attachment/);
  });

  test('explaining a file without an AI provider explains how to enable it, in Hebrew', async () => {
    const response = await fetch(`${base}/api/projects/${project.id}/files/explain`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'src/main.tsx' }),
    });
    assert.equal(response.status, 503);
    const { error } = await response.json();
    assert.equal(error.code, 'AI_DISABLED');
    assert.match(error.message, HEBREW);
  });

  test('preview: the build folder wins over a source index.html', async () => {
    const { preview } = await (await fetch(`${base}/api/projects/${project.id}/preview`)).json();
    assert.equal(preview.mode, 'site');
    assert.equal(preview.webRoot, 'dist/');
    assert.equal(preview.entry, 'dist/index.html');
    assert.equal(preview.originUrl, `http://p-${project.id}.localhost:${config.port}/`);
    assert.equal(preview.pathUrl, `/api/projects/${project.id}/serve/dist/`);
  });

  test('preview origin: the site root is served at "/", with static-host rules', async () => {
    const host = `p-${project.id}.localhost:${port}`;
    const home = await hostRequest(host, '/');
    assert.equal(home.status, 200);
    assert.match(home.body, /<h1>Site<\/h1>/);
    assert.equal(home.headers['content-security-policy'], undefined, 'its own origin needs no sandbox header');
    assert.match((await hostRequest(host, '/assets/app.js')).body, /document\.title/);
    assert.match((await hostRequest(host, '/tides')).body, /<h1>Site<\/h1>/, 'app routes fall back to index.html');
    assert.equal((await hostRequest(host, '/missing.js')).status, 404);
    assert.equal((await hostRequest(host, '/__stash/ping')).status, 204);
    assert.equal((await hostRequest(host, '/', 'POST')).status, 405);
    const apiPath = await hostRequest(host, '/api/projects');
    assert.match(apiPath.body, /<h1>Site<\/h1>/, 'API paths on a preview origin are just site routes, never the API');
    const unknown = await hostRequest(`p-00000000-0000-4000-8000-000000000000.localhost:${port}`, '/');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body, HEBREW);
  });
});

describe('preview planning without a ready site', () => {
  test('a Vite source project gets a Hebrew reason and npm commands', async () => {
    const project = await upload('app.zip', {
      'README.md': '# App\n\nA small app.\n',
      'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '19' }, devDependencies: { vite: '7' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'index.html': '<!doctype html><script type="module" src="/src/main.tsx"></script>',
      'src/main.tsx': 'export {}',
    });
    const { preview } = await (await fetch(`${base}/api/projects/${project.id}/preview`)).json();
    assert.equal(preview.mode, 'readme');
    assert.equal(preview.readme, 'README.md');
    assert.match(preview.title, HEBREW);
    assert.match(preview.reason, /src\/main\.tsx/);
    assert.deepEqual(preview.hints.map((hint) => hint.command), ['pnpm install', 'pnpm run dev', 'pnpm run build']);
  });

  test('a Python bot without a README gets pip and python commands', async () => {
    const project = await upload('bot.zip', { 'requirements.txt': 'python-telegram-bot\n', 'bot.py': 'print(1)\n' });
    const { preview } = await (await fetch(`${base}/api/projects/${project.id}/preview`)).json();
    assert.equal(preview.mode, 'none');
    assert.match(preview.reason, HEBREW);
    assert.deepEqual(preview.hints.map((hint) => hint.command), ['pip install -r requirements.txt', 'python bot.py']);
  });

  test('an empty index.html (only a title) is not a site', async () => {
    const project = await upload('empty-page.zip', { 'index.html': '<!doctype html><title>App</title>', 'src/main.rs': 'fn main() {}' });
    const { preview } = await (await fetch(`${base}/api/projects/${project.id}/preview`)).json();
    assert.notEqual(preview.mode, 'site');
  });

  test('a plain static site at the root is served as is', async () => {
    const project = await upload('portfolio.zip', { 'index.html': '<link rel="stylesheet" href="style.css"><script src="app.js"></script>', 'style.css': 'body{}', 'app.js': '' });
    const { preview } = await (await fetch(`${base}/api/projects/${project.id}/preview`)).json();
    assert.equal(preview.mode, 'site');
    assert.equal(preview.webRoot, '');
  });
});

test('content types, including pre-compressed web builds', () => {
  assert.deepEqual(mimeTypeOf('Build/game.wasm.gz'), { type: 'application/wasm', encoding: 'gzip' });
  assert.deepEqual(mimeTypeOf('release.tar.gz'), { type: 'application/gzip', encoding: null });
  assert.equal(mimeTypeOf('assets/index.js').type, 'text/javascript; charset=utf-8');
});
