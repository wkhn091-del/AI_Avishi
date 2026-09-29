// The GitHub tab: token, repositories, analysis, files, preview and errors, with GitHub's API stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { tempDir } from './helpers.js';

const storage = await tempDir('stash-github-');
process.env.STORAGE_DIR = storage.dir;
process.env.AI_PROVIDER = 'none';
process.env.LOG_REQUESTS = 'false';
process.env.ALLOW_PRIVATE_NETWORK_URLS = 'true'; // the stubbed homepage isn't looked up in DNS
delete process.env.GITHUB_TOKEN;

const HEBREW = /[\u05D0-\u05EA]/;
const GOOD_TOKEN = `github_pat_${'a'.repeat(40)}1234`;
const USER = { login: 'rozen-dev', name: 'Rozen', avatar_url: 'https://avatars.example/rozen.png', html_url: 'https://github.com/rozen-dev' };
const repo = (name, extra = {}) => ({
  full_name: `rozen-dev/${name}`, name, owner: { login: 'rozen-dev' }, html_url: `https://github.com/rozen-dev/${name}`,
  description: 'Marine forecasts', homepage: null, private: false, fork: false, archived: false, language: 'TypeScript',
  stargazers_count: 12, forks_count: 1, topics: ['weather'], default_branch: 'main', pushed_at: '2026-09-20T10:00:00Z', has_pages: false, ...extra,
});
const REPOS = [repo('harbor-weather', { homepage: 'harbor.example.com' }), repo('reminder-bot', { private: true, language: 'Python', description: '' })];
const FILES = {
  'README.md': '# תחזית ימית\n\nתחזית לשייטים: רוח, גלים וגאות לשבוע הקרוב.\n',
  'package.json': JSON.stringify({ name: 'harbor-weather', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0' } }),
  'index.html': '<!doctype html><script type="module" src="/src/main.tsx"></script>',
  'src/main.tsx': 'import { App } from "./App";\n',
  'src/App.tsx': 'export function App() {\n  return <h1>שלום</h1>;\n}\n',
  'node_modules/react/index.js': 'module.exports = {};',
  'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

const calls = [];
const realFetch = globalThis.fetch;
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1790000000', ...headers },
  });

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('https://harbor.example.com')) {
    return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' } });
  }
  if (!href.startsWith('https://api.github.com/')) return realFetch(url, init);
  const { pathname, search } = new URL(href);
  const auth = init.headers?.Authorization;
  const etag = init.headers?.['If-None-Match'] ?? null;
  calls.push({ path: pathname + search, etag });
  if (auth && auth !== `Bearer ${GOOD_TOKEN}`) return json(401, { message: 'Bad credentials' });
  if (pathname === '/user') return auth ? json(200, USER, { 'x-oauth-scopes': 'repo, read:user' }) : json(401, { message: 'Requires authentication' });
  if (pathname === '/user/repos') return etag === '"repos-1"' ? new Response(null, { status: 304 }) : json(200, REPOS, { etag: '"repos-1"' });
  if (pathname === '/repos/rozen-dev/limited') return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });

  const match = /^\/repos\/rozen-dev\/([^/]+)(\/.*)?$/.exec(pathname);
  const found = match && REPOS.find((item) => item.name === match[1]);
  if (!found) return json(404, { message: 'Not Found' });
  const rest = match[2] ?? '';
  if (rest === '') return json(200, found);
  if (rest === '/git/trees/main') {
    const tree = Object.entries(FILES).map(([p, content]) => ({ path: p, type: 'blob', sha: `sha-${p}`, size: Buffer.byteLength(content) }));
    return json(200, { sha: `tree-${found.name}`, truncated: false, tree: [...tree, { path: 'src', type: 'tree', sha: 'dir' }] });
  }
  if (rest.startsWith('/contents/')) {
    const file = decodeURIComponent(rest.slice('/contents/'.length));
    return file in FILES ? new Response(FILES[file], { status: 200 }) : json(404, { message: 'Not Found' });
  }
  return json(404, { message: 'Not Found' });
};

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { JsonStore } = await import('../src/lib/jsonStore.js');

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

const api = (route) => realFetch(`${base}${route}`);
const send = (method, route, body) =>
  realFetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('GitHub', () => {
  test('without a token: not connected, and /repos explains how to connect in Hebrew', async () => {
    assert.equal((await (await api('/github/status')).json()).github.connected, false);
    const response = await api('/github/repos');
    assert.equal(response.status, 401);
    const { error } = await response.json();
    assert.equal(error.code, 'GITHUB_NOT_CONNECTED');
    assert.match(error.message, HEBREW);
  });

  test('bad tokens are refused in Hebrew; a good one is validated, saved privately and never echoed', async () => {
    assert.equal((await (await send('PUT', '/github/token', { token: 'nope' })).json()).error.code, 'INVALID_TOKEN');
    const rejected = await send('PUT', '/github/token', { token: `github_pat_${'b'.repeat(44)}` });
    assert.equal(rejected.status, 400);
    const { error } = await rejected.json();
    assert.equal(error.code, 'TOKEN_REJECTED');
    assert.match(error.message, HEBREW);

    const saved = await send('PUT', '/github/token', { token: GOOD_TOKEN });
    assert.equal(saved.status, 200);
    const { github } = await saved.json();
    assert.equal(github.connected, true);
    assert.equal(github.user.login, 'rozen-dev');
    assert.equal(github.source, 'settings');
    assert.equal(github.tokenHint, '…1234');
    assert.deepEqual(github.scopes, ['repo', 'read:user']);
    assert.ok(!JSON.stringify(github).includes(GOOD_TOKEN), 'the token never goes back to the browser');
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(storage.dir, 'settings.json'))).mode & 0o777, 0o600);
  });

  test('lists repositories, not analysed yet, and revalidates with ETags', async () => {
    const { repos } = await (await api('/github/repos')).json();
    assert.deepEqual(repos.map((item) => item.id), ['rozen-dev/harbor-weather', 'rozen-dev/reminder-bot']);
    assert.equal(repos[0].analyzed, false);
    assert.equal(repos[0].title, 'harbor-weather');
    assert.equal(repos[1].github.private, true);
    await api('/github/repos');
    assert.equal(calls.filter((call) => call.path.startsWith('/user/repos')).at(-1).etag, '"repos-1"');
  });

  test('analysing a repository uses the ZIP pipeline and writes Hebrew', async () => {
    const response = await send('POST', '/github/analyze/harbor-weather');
    assert.equal(response.status, 200);
    const { repo: analysed } = await response.json();
    assert.equal(analysed.analyzed, true);
    assert.equal(analysed.title, 'תחזית ימית');
    assert.match(analysed.description, HEBREW);
    assert.equal(analysed.kind, 'web');
    assert.ok(analysed.techStack.includes('React'));
    assert.equal(analysed.stats.ignoredEntries, 1);
    assert.ok(analysed.fingerprint.length > 0);
    assert.equal((await (await api('/github/repos')).json()).repos[0].analyzed, true);
  });

  test('edits to an analysis are kept', async () => {
    const { repo: edited } = await (await send('PATCH', '/github/repos/rozen-dev/harbor-weather', { title: 'תחזית לשייטים' })).json();
    assert.equal(edited.title, 'תחזית לשייטים');
    assert.equal(edited.edited, true);
  });

  test('files: tree, text content, binary refusal, sandboxed raw bytes', async () => {
    const tree = await (await api('/github/repos/rozen-dev/harbor-weather/files')).json();
    assert.equal(tree.tree.children[0].name, 'src');
    assert.deepEqual(tree.hidden, { count: 1, folders: ['node_modules'] });
    const content = await api(`/github/repos/rozen-dev/harbor-weather/files/content?path=${encodeURIComponent('src/App.tsx')}`);
    assert.equal(await content.text(), FILES['src/App.tsx']);
    assert.equal((await api('/github/repos/rozen-dev/harbor-weather/files/content?path=logo.png')).status, 415);
    assert.equal((await api('/github/repos/rozen-dev/harbor-weather/files/content?path=nope.ts')).status, 404);
    const raw = await api('/github/repos/rozen-dev/harbor-weather/raw/logo.png');
    assert.equal(raw.headers.get('content-type'), 'image/png');
    assert.match(raw.headers.get('content-security-policy'), /^sandbox/);
  });

  test('preview: the homepage is offered, and a site that forbids framing is flagged', async () => {
    const { preview } = await (await api('/github/repos/rozen-dev/harbor-weather/preview')).json();
    assert.equal(preview.mode, 'external');
    assert.equal(preview.url, 'https://harbor.example.com/');
    assert.equal(preview.site, 'homepage');
    assert.equal(preview.framable, false);
    assert.equal(preview.readme, 'README.md');
  });

  test('preview without a website: README, a Hebrew reason and run commands', async () => {
    const { preview } = await (await api('/github/repos/rozen-dev/reminder-bot/preview')).json();
    assert.equal(preview.mode, 'readme');
    assert.match(preview.reason, HEBREW);
    assert.ok(preview.hints.some((hint) => hint.command === 'npm run dev'));
  });

  test('explaining a GitHub file without AI explains how to enable it', async () => {
    const response = await send('POST', '/github/repos/rozen-dev/harbor-weather/files/explain', { path: 'src/App.tsx' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, HEBREW);
  });

  test('GitHub errors become Hebrew messages', async () => {
    const limited = await send('POST', '/github/analyze/rozen-dev/limited');
    assert.equal(limited.status, 429);
    const { error } = await limited.json();
    assert.equal(error.code, 'GITHUB_RATE_LIMITED');
    assert.match(error.message, HEBREW);
    const missing = await send('POST', '/github/analyze/rozen-dev/missing');
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error.message, HEBREW);
  });

  test('removing the token disconnects', async () => {
    const { github } = await (await send('DELETE', '/github/token')).json();
    assert.equal(github.connected, false);
    assert.equal((await api('/github/repos')).status, 401);
  });
});
