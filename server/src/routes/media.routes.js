/**
 * /api/media: the media studio (Pollinations).
 *
 *   GET    /options     whether a key is configured; models per kind, voices, aspect ratios, video lengths
 *   GET    /            everything generated so far, newest first
 *   POST   /generate    { kind: image|speech|music|video, prompt, model?, aspect?, seed?, safe?, voice?, duration?, audio? }
 *   GET    /:id/file    the file, inline (?download=1 downloads it); supports range requests for video
 *   DELETE /:id
 */
import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../lib/httpError.js';
import { balanceOf, reserveCredits, unlimited } from '../services/credits.js';
import { ASPECTS, DEFAULT_MEDIA_MODELS, MEDIA_KINDS, VOICES, extensionOf, generateMedia, isConfigured, mediaModels } from '../services/media/pollinations.js';

const MAX_PROMPT = { image: 1_500, video: 1_500, music: 1_500, speech: 4_000 };
export const VIDEO_DURATIONS = [4, 5, 6, 8, 10];
const VIDEO_ASPECTS = ['16:9', '9:16', '1:1'];
const notFound = () => new HttpError(404, 'הקובץ לא נמצא. ייתכן שהוא נמחק.', 'NOT_FOUND');

export function validateMediaRequest(body = {}) {
  const kind = MEDIA_KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) throw new HttpError(400, 'סוג המדיה אינו תקין.', 'INVALID_KIND');
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, kind === 'speech' ? 'כתבו את הטקסט להקראה.' : 'כתבו תיאור של מה ליצור.', 'EMPTY_PROMPT');
  if (prompt.length > MAX_PROMPT[kind]) {
    throw new HttpError(413, `התיאור ארוך מדי: עד ${MAX_PROMPT[kind].toLocaleString('he-IL')} תווים.`, 'PROMPT_TOO_LONG');
  }
  const model = typeof body.model === 'string' && /^[\w./:-]{1,120}$/.test(body.model.trim()) ? body.model.trim() : DEFAULT_MEDIA_MODELS[kind];
  const request = { kind, prompt, model };
  if (kind === 'image' || kind === 'video') {
    const allowed = kind === 'image' ? Object.keys(ASPECTS) : VIDEO_ASPECTS;
    request.aspect = allowed.includes(body.aspect) ? body.aspect : allowed[kind === 'image' ? 0 : 0];
    const seed = Number.parseInt(body.seed, 10);
    request.seed = Number.isInteger(seed) && seed >= 0 && seed <= 2_147_483_647 ? seed : randomInt(0, 2_147_483_647);
    request.safe = body.safe !== false;
  }
  if (kind === 'video') {
    const duration = Number.parseInt(body.duration, 10);
    request.duration = VIDEO_DURATIONS.includes(duration) ? duration : 5;
    request.audio = Boolean(body.audio);
  }
  if (kind === 'speech') request.voice = VOICES.includes(body.voice) ? body.voice : 'nova';
  return request;
}

/** @param {{ store: import('../lib/jsonStore.js').JsonStore }} deps */
export function mediaRouter({ store }) {
  const router = Router();
  const fileOf = (record) => path.join(config.paths.media, record.file);

  router.get('/options', async (req, res) => {
    const catalogue = await mediaModels();
    res.json({
      configured: isConfigured(),
      live: catalogue.live,
      models: catalogue.models,
      defaults: DEFAULT_MEDIA_MODELS,
      voices: VOICES,
      aspects: { image: Object.keys(ASPECTS), video: VIDEO_ASPECTS },
      videoDurations: VIDEO_DURATIONS,
    });
  });

  router.get('/', (req, res) => {
    // Each person sees what they made.
    res.json({ media: store.list('media').filter((record) => record.ownerId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  });

  router.post('/generate', async (req, res) => {
    const request = validateMediaRequest(req.body);
    // Credits: an item's price is reserved first (402 when there isn't enough) and given back if it fails.
    const hold = await reserveCredits(req.user, config.credits.perMedia);
    let record;
    try {
      const { bytes, mime, ms } = await generateMedia(request);
      const id = randomUUID();
      const file = `${id}.${extensionOf(mime)}`;
      await fs.mkdir(config.paths.media, { recursive: true });
      await fs.writeFile(path.join(config.paths.media, file), bytes);
      const { kind, prompt, model, ...options } = request;
      record = { id, ownerId: req.user.id, kind, prompt, model, options, mime, size: bytes.length, ms, file, createdAt: new Date().toISOString() };
      await store.insert('media', record);
    } catch (error) {
      await hold.release();
      throw error;
    }
    res.status(201).json({ media: record, ...(unlimited(req.user) ? {} : { credits: await balanceOf(req.user) }) });
  });

  router.get('/:id/file', async (req, res) => {
    const record = store.get('media', req.params.id);
    if (!record || record.ownerId !== req.user.id) throw notFound();
    res.set({
      'X-Content-Type-Options': 'nosniff',
      // Generated files are shown as media only: an SVG opened directly can't run scripts.
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    if (req.query.download === '1') res.attachment(`stash-${record.kind}-${record.id.slice(0, 8)}${path.extname(record.file)}`);
    res.type(record.mime);
    await new Promise((resolve, reject) => {
      res.sendFile(fileOf(record), (error) => (error ? reject(error.code === 'ENOENT' ? notFound() : error) : resolve()));
    });
  });

  router.delete('/:id', async (req, res) => {
    const record = store.get('media', req.params.id);
    if (!record || record.ownerId !== req.user.id) throw notFound();
    await store.remove('media', record.id);
    await fs.rm(fileOf(record), { force: true });
    res.status(204).end();
  });

  return router;
}
