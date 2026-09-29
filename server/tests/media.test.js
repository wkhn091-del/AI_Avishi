// The media studio: Pollinations image, speech, music and video generation, stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { tempDir } from './helpers.js';

const storage = await tempDir('stash-media-');
process.env.STORAGE_DIR = storage.dir;
process.env.LOG_REQUESTS = 'false';
process.env.AI_PROVIDER = 'none';
process.env.POLLINATIONS_API_KEY = 'sk_test_key';
process.env.AI_RETRY_BASE_MS = '5';

const HEBREW = /[\u05D0-\u05EA]/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const MP3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 9, 9]);
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 7, 7, 7, 7]);
const realFetch = globalThis.fetch;
const calls = [];
let busyLeft = 0;

const bytes = (buffer, type) => new Response(buffer, { status: 200, headers: { 'content-type': type } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const target = new URL(href);
  if (target.hostname !== 'gen.pollinations.ai') throw new Error(`Unexpected request: ${href}`);
  calls.push({ url: target, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
  if (target.pathname === '/image/models') {
    return json([
      { id: 'black-forest-labs/flux.1-schnell', output_modalities: ['image'] },
      { id: 'google/veo-3.1-fast', output_modalities: ['video'], paid_only: true },
      { id: 'community/someone/model', output_modalities: ['image'] },
    ]);
  }
  if (target.pathname === '/audio/models') return json([{ id: 'elevenlabs/music-v2' }, { id: 'elevenlabs/eleven-v3' }, { id: 'openai/whisper-large-v3' }]);
  if (target.pathname === '/video/models') return json({ error: 'not here' }, 404);
  const prompt = decodeURIComponent(target.pathname.split('/').slice(2).join('/'));
  if (prompt === 'quota') return json({ error: { message: 'Insufficient pollen balance' } }, 402);
  if (prompt === 'busy' && busyLeft > 0) {
    busyLeft -= 1;
    return json({ error: { message: 'Queue full' } }, 503);
  }
  if (target.pathname.startsWith('/image/')) return bytes(PNG, 'image/png');
  if (target.pathname.startsWith('/video/')) return bytes(MP4, 'video/mp4');
  if (target.pathname === '/v1/audio/speech') return bytes(MP3, 'audio/mpeg');
  throw new Error(`Unexpected request: ${href}`);
};

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

const api = (route, init) => realFetch(`${base}${route}`, init);
const generate = (body) => api('/media/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
let imageId;
let videoId;

describe('Media studio', () => {
  test('lists models per kind from the live catalogue, without transcription or community models', async () => {
    const options = await (await api('/media/options')).json();
    assert.equal(options.configured, true);
    assert.equal(options.live, true);
    assert.equal(options.models.image[0].id, 'black-forest-labs/flux.1-schnell');
    assert.ok(options.models.video.some((model) => model.id === 'google/veo-3.1-fast' && model.paid));
    assert.ok(options.models.music.some((model) => model.id === 'elevenlabs/music-v2'));
    assert.ok(options.models.speech.some((model) => model.id === 'elevenlabs/eleven-v3'));
    const all = Object.values(options.models).flat().map((model) => model.id);
    assert.ok(!all.includes('openai/whisper-large-v3'));
    assert.ok(!all.some((id) => id.startsWith('community/')));
    assert.deepEqual(options.aspects.video, ['16:9', '9:16', '1:1']);
  });

  test('an image is generated with the key, size, seed and content filter, and saved', async () => {
    const response = await generate({ kind: 'image', prompt: 'ספינה בנמל', aspect: '16:9', seed: 42 });
    assert.equal(response.status, 201);
    const { media } = await response.json();
    imageId = media.id;
    assert.equal(media.kind, 'image');
    assert.equal(media.mime, 'image/png');
    assert.equal(media.size, PNG.length);
    assert.deepEqual(media.options, { aspect: '16:9', seed: 42, safe: true });
    const request = calls.at(-1);
    assert.equal(request.headers.authorization, 'Bearer sk_test_key');
    assert.equal(decodeURIComponent(request.url.pathname), '/image/ספינה בנמל');
    assert.equal(request.url.searchParams.get('model'), 'black-forest-labs/flux.1-schnell');
    assert.equal(request.url.searchParams.get('width'), '1344');
    assert.equal(request.url.searchParams.get('height'), '768');
    assert.equal(request.url.searchParams.get('seed'), '42');
    assert.equal(request.url.searchParams.get('safe'), 'sexual,violence');
  });

  test('files are served inline in a sandbox, or as a download', async () => {
    const inline = await api(`/media/${imageId}/file`);
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'image/png');
    assert.match(inline.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()), PNG);
    const download = await api(`/media/${imageId}/file?download=1`);
    assert.match(download.headers.get('content-disposition'), /attachment; filename="stash-image-[0-9a-f]{8}\.png"/);
  });

  test('speech uses the OpenAI-compatible endpoint with a voice', async () => {
    const { media } = await (await generate({ kind: 'speech', prompt: 'שלום לכולם', voice: 'rachel' })).json();
    assert.equal(media.mime, 'audio/mpeg');
    assert.match(media.file, /\.mp3$/);
    const request = calls.at(-1);
    assert.equal(request.url.pathname, '/v1/audio/speech');
    assert.deepEqual(request.body, { model: 'elevenlabs/eleven-v3', input: 'שלום לכולם', response_format: 'mp3', voice: 'rachel' });
  });

  test('music has no voice; video sends duration and aspect ratio and supports range requests', async () => {
    await generate({ kind: 'music', prompt: 'מנגינה שקטה בפסנתר', model: 'elevenlabs/music-v2' });
    assert.equal(calls.at(-1).body.voice, undefined);
    const { media } = await (await generate({ kind: 'video', prompt: 'גלים בשקיעה', duration: 6, aspect: '9:16', audio: true })).json();
    videoId = media.id;
    const request = calls.at(-1);
    assert.equal(request.url.searchParams.get('duration'), '6');
    assert.equal(request.url.searchParams.get('aspectRatio'), '9:16');
    assert.equal(request.url.searchParams.get('audio'), 'true');
    const part = await api(`/media/${videoId}/file`, { headers: { range: 'bytes=0-3' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 4);
  });

  test('an empty Pollen balance is explained in Hebrew, with the provider text kept apart', async () => {
    const response = await generate({ kind: 'image', prompt: 'quota' });
    assert.equal(response.status, 402);
    const { error } = await response.json();
    assert.equal(error.code, 'MEDIA_PAYMENT_REQUIRED');
    assert.match(error.message, HEBREW);
    assert.match(error.details.detail, /HTTP 402 \(Pollinations\): Insufficient pollen balance/);
  });

  test('a busy service is retried with the same seed', async () => {
    busyLeft = 2;
    const before = calls.length;
    const response = await generate({ kind: 'image', prompt: 'busy', seed: 7 });
    assert.equal(response.status, 201);
    const attempts = calls.slice(before);
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((call) => call.url.searchParams.get('seed') === '7'));
  });

  test('bad requests are refused in Hebrew', async () => {
    for (const body of [{ kind: 'image', prompt: '  ' }, { kind: 'hologram', prompt: 'x' }]) {
      const response = await generate(body);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, HEBREW);
    }
  });

  test('the gallery lists everything; deleting removes the record and the file', async () => {
    const { media } = await (await api('/media')).json();
    assert.equal(media.length, 5); // image, speech, music, video, and the retried image (the out-of-Pollen request saved nothing)
    assert.equal(media[0].prompt, 'busy');
    const record = media.find((item) => item.id === imageId);
    assert.equal((await api(`/media/${imageId}`, { method: 'DELETE' })).status, 204);
    await assert.rejects(fs.stat(path.join(config.paths.media, record.file)));
    const gone = await api(`/media/${imageId}/file`);
    assert.equal(gone.status, 404);
    assert.match((await gone.json()).error.message, HEBREW);
  });
});
