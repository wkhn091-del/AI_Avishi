// HTTP smoke test: boots the real app on a random port with temporary storage.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeZip, tempDir } from './helpers.js';

const storage = await tempDir('stash-api-');
process.env.STORAGE_DIR = storage.dir;
process.env.AI_PROVIDER = 'none';
process.env.LOG_REQUESTS = 'false';

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
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.flush();
  await storage.cleanup();
});

const api = (route, init) => fetch(`${base}/api${route}`, init);
const upload = (field, name, bytes, type = 'application/octet-stream') => {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), name);
  return form;
};

/** Raw request, for headers fetch won't let us set (Host). */
function rawRequest(route, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}${route}`, { method, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body || 'null') }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('API', () => {
  test('health reports AI status and limits', async () => {
    const response = await api('/health');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.ai.enabled, false);
    assert.ok(body.limits.archiveBytes > 0);
  });

  test('project lifecycle: upload, list, edit, download, delete', async () => {
    const zipPath = await makeZip(storage.dir, 'demo.zip', { 'README.md': '# Demo Project\n\nA small demo.\n', 'index.js': 'console.log(1)' });
    const zipBytes = await fs.readFile(zipPath);

    const created = await api('/projects', { method: 'POST', body: upload('archive', 'פרויקט demo.zip', zipBytes, 'application/zip') });
    assert.equal(created.status, 201);
    const { project } = await created.json();
    assert.equal(project.title, 'Demo Project');
    assert.equal(project.archive.originalName, 'פרויקט demo.zip');

    const list = await (await api('/projects')).json();
    assert.equal(list.projects.length, 1);

    const patched = await api(`/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '  Renamed   project ', tags: ['Demo', 'demo', 'Node'] }),
    });
    const { project: renamed } = await patched.json();
    assert.equal(renamed.title, 'Renamed project');
    assert.deepEqual(renamed.tags, ['Demo', 'Node']);
    assert.equal(renamed.edited, true);

    const download = await api(`/projects/${project.id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), zipBytes);

    assert.equal((await api(`/projects/${project.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/projects/${project.id}`)).status, 404);
    assert.deepEqual(await fs.readdir(config.paths.archives), []);
  });

  test('rejects uploads that are not ZIP archives', async () => {
    const response = await api('/projects', { method: 'POST', body: upload('archive', 'notes.txt', 'hello') });
    assert.equal(response.status, 415);
    const { error } = await response.json();
    assert.equal(error.code, 'UNSUPPORTED_TYPE');
    assert.match(error.message, /[\u05D0-\u05EA]/, 'error messages are in Hebrew');
  });

  test('files: upload, raster preview, no SVG preview, delete', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    const form = upload('files', 'dot.png', png, 'image/png');
    form.append('files', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }), 'logo.svg');
    const response = await api('/files', { method: 'POST', body: form });
    assert.equal(response.status, 201);
    const { files } = await response.json();
    const [dot, logo] = files;

    const preview = await api(`/files/${dot.id}/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-security-policy'), "default-src 'none'");
    assert.equal((await api(`/files/${logo.id}/preview`)).status, 415);

    for (const file of files) assert.equal((await api(`/files/${file.id}`, { method: 'DELETE' })).status, 204);
  });

  test('links: local addresses are saved without fetching, duplicates are refused', async () => {
    const save = () => api('/links', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'localhost:9' }) });
    const first = await save();
    assert.equal(first.status, 201);
    const { link } = await first.json();
    assert.equal(link.url, 'http://localhost:9/');
    assert.equal(link.metadataStatus, 'skipped');

    const second = await save();
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.details.id, link.id);
  });

  test('blocks unknown Host headers (DNS rebinding) and cross-site writes', async () => {
    const rebinding = await rawRequest('/api/health', { headers: { host: 'attacker.example:80' } });
    assert.equal(rebinding.status, 403);
    assert.equal(rebinding.body.error.code, 'HOST_NOT_ALLOWED');

    const crossSite = await rawRequest('/api/projects/x', { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.error.code, 'CROSS_SITE');
  });
});
