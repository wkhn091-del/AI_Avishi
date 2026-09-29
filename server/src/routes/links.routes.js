/**
 * /api/links — bookmarks with OpenGraph previews.
 *
 *   GET    /              list links (newest first)
 *   POST   /              { url } → fetch preview → 201 { link }   (409 if already saved)
 *   POST   /:id/refresh   fetch the preview again
 *   DELETE /:id           remove the link
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { HttpError, notFound } from '../lib/httpError.js';
import { fetchLinkPreview } from '../services/links/linkPreview.js';
import { normalizeUserUrl } from '../services/links/urlSafety.js';

/** @param {{ store: import('../lib/jsonStore.js').JsonStore }} deps */
export function linksRouter({ store }) {
  const router = Router();

  const assertNotSaved = (url) => {
    const existing = store.list('links').find((link) => link.url === url);
    if (existing) throw new HttpError(409, 'הקישור הזה כבר שמור.', 'DUPLICATE', { id: existing.id });
  };

  router.get('/', (req, res) => {
    res.json({ links: store.list('links') });
  });

  router.post('/', async (req, res) => {
    const url = normalizeUserUrl(req.body?.url);
    assertNotSaved(url);

    const preview = await fetchLinkPreview(url);
    assertNotSaved(url); // the same link may have been saved while we were fetching

    const now = new Date().toISOString();
    const link = { id: randomUUID(), url, ...preview, createdAt: now, updatedAt: now };
    await store.insert('links', link);
    res.status(201).json({ link });
  });

  router.post('/:id/refresh', async (req, res) => {
    const link = store.get('links', req.params.id);
    if (!link) throw notFound('הקישור לא נמצא.');
    const preview = await fetchLinkPreview(link.url);
    const updated = await store.update('links', link.id, { ...preview, updatedAt: new Date().toISOString() });
    res.json({ link: updated });
  });

  router.delete('/:id', async (req, res) => {
    const removed = await store.remove('links', req.params.id);
    if (!removed) throw notFound('הקישור לא נמצא.');
    res.status(204).end();
  });

  return router;
}
