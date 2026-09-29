/**
 * /api/files — general file storage.
 *
 *   GET    /              list files (newest first)
 *   POST   /              multipart field "files" (up to 20) → 201 { files }
 *   GET    /:id/download  the file, with its original name
 *   GET    /:id/preview   inline image for thumbnails (raster formats only)
 *   DELETE /:id           remove the file
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { displayName, safeExtension } from '../lib/filenames.js';
import { HttpError, notFound } from '../lib/httpError.js';
import { acceptFiles } from '../middleware/uploads.js';

/**
 * Formats served inline for thumbnails. SVG is deliberately excluded: it can
 * carry scripts, so it is only ever offered as a download.
 */
const PREVIEW_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
]);

/** @param {{ store: import('../lib/jsonStore.js').JsonStore }} deps */
export function filesRouter({ store }) {
  const router = Router();

  const findFile = (id) => {
    const file = store.get('files', id);
    if (!file) throw notFound('הקובץ לא נמצא.');
    return file;
  };

  const storedPathOf = (file) => path.join(config.paths.files, path.basename(file.storedName));

  router.get('/', (req, res) => {
    res.json({ files: store.list('files') });
  });

  router.post('/', acceptFiles, async (req, res) => {
    const uploads = req.files ?? [];
    if (!uploads.length) throw new HttpError(400, 'בחרו לפחות קובץ אחד להעלאה (בשדה files).', 'FILE_REQUIRED');

    const now = new Date().toISOString();
    const records = uploads.map((upload) => {
      const extension = safeExtension(upload.originalname).slice(1);
      return {
        id: path.parse(upload.filename).name,
        originalName: displayName(upload.originalname),
        storedName: upload.filename,
        size: upload.size,
        mimeType: upload.mimetype || 'application/octet-stream',
        extension,
        previewable: PREVIEW_TYPES.has(extension),
        createdAt: now,
      };
    });

    try {
      await store.insert('files', records);
    } catch (error) {
      await Promise.all(uploads.map((upload) => fs.rm(upload.path, { force: true })));
      throw error;
    }
    res.status(201).json({ files: records });
  });

  router.get('/:id/download', async (req, res) => {
    const file = findFile(req.params.id);
    await assertFileExists(storedPathOf(file));
    res.download(storedPathOf(file), file.originalName);
  });

  router.get('/:id/preview', async (req, res) => {
    const file = findFile(req.params.id);
    const type = PREVIEW_TYPES.get(file.extension);
    if (!type) throw new HttpError(415, 'אין תצוגה מקדימה לסוג הקובץ הזה.', 'NO_PREVIEW');
    await assertFileExists(storedPathOf(file));
    res.sendFile(storedPathOf(file), {
      headers: {
        'Content-Type': type,
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'private, max-age=86400',
      },
    });
  });

  router.delete('/:id', async (req, res) => {
    const removed = await store.remove('files', req.params.id);
    if (!removed) throw notFound('הקובץ לא נמצא.');
    await fs.rm(storedPathOf(removed), { force: true });
    res.status(204).end();
  });

  return router;
}

async function assertFileExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new HttpError(410, 'העותק השמור של הקובץ הזה חסר.', 'FILE_MISSING');
  }
}
