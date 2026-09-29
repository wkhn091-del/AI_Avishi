/**
 * /api/projects/:id/… — reading a project's archive (in memory, never extracted).
 *
 *   GET  /:id/files                  folder tree (JSON)
 *   GET  /:id/files/content?path=    one text file, raw (text/plain; charset=utf-8)
 *   POST /:id/files/explain          { path, refresh? } → Hebrew AI explanation of one file
 *   GET  /:id/preview                how the project can be previewed (live site, README, run hints)
 *   GET  /:id/serve/*                any file of the archive, as a static server (sandboxed documents)
 */
import { Router } from 'express';
import { isolate } from '../lib/bidi.js';
import { HttpError, notFound } from '../lib/httpError.js';
import { previewOriginOf } from '../middleware/previewHost.js';
import { AiError, aiHttpError } from '../services/ai/llmClient.js';
import {
  MAX_VIEW_BYTES, buildTree, cleanRequestPath, decodeText, isBinaryPath, openArchive, readBytes, sendArchiveFile,
} from '../services/projects/archiveReader.js';
import { explainFile } from '../services/projects/fileExplainer.js';
import { previewPlanOf } from '../services/projects/previewPlanner.js';

const encodePath = (filePath) => filePath.split('/').map(encodeURIComponent).join('/');
const formatSize = (bytes) => isolate(`${(bytes / 1024 / 1024).toFixed(1)} MB`);
const binaryError = () => new HttpError(415, 'זה קובץ בינארי, ולכן אין לו תצוגת קוד. אפשר להוריד אותו.', 'BINARY_FILE');

/** @param {{ store: import('../lib/jsonStore.js').JsonStore }} deps */
export function projectFilesRouter({ store }) {
  const router = Router();

  const load = async (req) => {
    const project = store.get('projects', req.params.id);
    if (!project) throw notFound('הפרויקט לא נמצא.');
    return { project, archive: await openArchive(project) };
  };
  const pathFrom = (value) => {
    const cleaned = cleanRequestPath(value);
    if (cleaned === null) throw new HttpError(400, 'הנתיב של הקובץ אינו תקין.', 'INVALID_PATH');
    return cleaned;
  };
  const fileOrThrow = (archive, filePath) => {
    const file = filePath ? archive.files.get(filePath) : null;
    if (!file) throw new HttpError(404, 'הקובץ לא נמצא בארכיון.', 'FILE_NOT_FOUND');
    return file;
  };

  router.get('/:id/files', async (req, res) => {
    const { archive } = await load(req);
    res.json(buildTree(archive));
  });

  router.get('/:id/files/content', async (req, res) => {
    const { archive } = await load(req);
    const filePath = pathFrom(req.query.path);
    const file = fileOrThrow(archive, filePath);
    if (isBinaryPath(filePath)) throw binaryError();
    if (file.size > MAX_VIEW_BYTES) {
      throw new HttpError(413, `הקובץ גדול מדי לתצוגה (${formatSize(file.size)}). אפשר להוריד אותו.`, 'FILE_TOO_LARGE_TO_VIEW');
    }
    const text = decodeText(readBytes(archive, filePath));
    if (text === null) throw binaryError();
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-File-Size': String(file.size) });
    res.send(text);
  });

  router.post('/:id/files/explain', async (req, res) => {
    const { project, archive } = await load(req);
    const filePath = pathFrom(req.body?.path);
    fileOrThrow(archive, filePath);
    if (isBinaryPath(filePath)) throw binaryError();

    const id = `${project.id}:${filePath}`;
    const cached = store.get('explanations', id);
    if (cached && !req.body?.refresh) return res.json({ explanation: { ...cached, cached: true } });

    const text = decodeText(readBytes(archive, filePath));
    if (text === null) throw binaryError();
    let result;
    try {
      result = await explainFile({ project, path: filePath, text });
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      console.warn(`[ai] Explaining "${filePath}" failed: ${error.log}`);
      throw aiHttpError(error);
    }
    const record = { id, projectId: project.id, path: filePath, ...result };
    if (cached) await store.update('explanations', id, record);
    else await store.insert('explanations', record);
    res.json({ explanation: { ...record, cached: false } });
  });

  router.get('/:id/preview', async (req, res) => {
    const { project, archive } = await load(req);
    const plan = previewPlanOf(archive, project);
    const site = plan.mode === 'site';
    res.json({
      preview: {
        ...plan,
        originUrl: site ? previewOriginOf(project.id) : null,
        pathUrl: site ? `/api/projects/${project.id}/serve/${encodePath(plan.webRoot)}` : null,
      },
    });
  });

  // Express 5 path syntax: "{/*path}" makes the wildcard optional, so /serve and /serve/ match too.
  router.get('/:id/serve{/*path}', async (req, res) => {
    const { archive } = await load(req);
    const requested = pathFrom((req.params.path ?? []).join('/'));
    let target = requested;
    if (requested === '' || archive.dirs.has(requested)) {
      if (!req.path.endsWith('/')) {
        const [pathname, query] = req.originalUrl.split('?');
        return res.redirect(301, `${pathname}/${query ? `?${query}` : ''}`);
      }
      target = requested ? `${requested}/index.html` : 'index.html';
    }
    fileOrThrow(archive, target);
    sendArchiveFile(res, archive, target, { sandbox: true, download: req.query.download === '1' });
  });

  return router;
}
