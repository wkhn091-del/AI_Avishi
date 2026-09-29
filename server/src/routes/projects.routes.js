/**
 * /api/projects — ZIP projects.
 *
 *   GET    /                 list projects (newest first)
 *   POST   /                 multipart field "archive" (.zip) → analyse → 201 { project }
 *   GET    /:id              one project
 *   PATCH  /:id              { title?, description?, tags? } → manual edits
 *   POST   /:id/reanalyze    run the analysis again (replaces manual edits)
 *   GET    /:id/download     the original .zip
 *   DELETE /:id              remove the project, its archive and its file explanations
 *
 * Reading the archive (files, code, explanations, preview): see projectFiles.routes.js.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { displayName } from '../lib/filenames.js';
import { HttpError, notFound } from '../lib/httpError.js';
import { acceptArchive } from '../middleware/uploads.js';
import { analyzeArchive } from '../services/projects/analyzeArchive.js';
import { forgetArchive } from '../services/projects/archiveReader.js';

/** @param {{ store: import('../lib/jsonStore.js').JsonStore }} deps */
export function projectsRouter({ store }) {
  const router = Router();

  const findProject = (id) => {
    const project = store.get('projects', id);
    if (!project) throw notFound('הפרויקט לא נמצא.');
    return project;
  };

  const archivePathOf = (project) => path.join(config.paths.archives, path.basename(project.archive.storedName));

  router.get('/', (req, res) => {
    res.json({ projects: store.list('projects') });
  });

  router.post('/', acceptArchive, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'בחרו קובץ ZIP להוספה (בשדה archive).', 'FILE_REQUIRED');

    const archiveName = displayName(req.file.originalname, 'archive.zip');
    try {
      const analysis = await analyzeArchive(req.file.path, { archiveName });
      const now = new Date().toISOString();
      const project = {
        id: path.basename(req.file.filename, '.zip'),
        ...analysis,
        archive: { originalName: archiveName, storedName: req.file.filename, size: req.file.size },
        edited: false,
        createdAt: now,
        updatedAt: now,
      };
      await store.insert('projects', project);
      res.status(201).json({ project });
    } catch (error) {
      // Don't keep an archive that never became a project.
      await fs.rm(req.file.path, { force: true });
      throw error;
    }
  });

  router.get('/:id', (req, res) => {
    res.json({ project: findProject(req.params.id) });
  });

  router.patch('/:id', async (req, res) => {
    const project = findProject(req.params.id);
    const patch = validateEdits(req.body);
    const updated = await store.update('projects', project.id, { ...patch, edited: true, updatedAt: new Date().toISOString() });
    res.json({ project: updated });
  });

  router.post('/:id/reanalyze', async (req, res) => {
    const project = findProject(req.params.id);
    const archivePath = archivePathOf(project);
    await assertFileExists(archivePath, 'הארכיון השמור של הפרויקט הזה חסר, ולכן אי אפשר לנתח אותו מחדש.');
    const analysis = await analyzeArchive(archivePath, { archiveName: project.archive.originalName });
    const updated = await store.update('projects', project.id, { ...analysis, edited: false, updatedAt: new Date().toISOString() });
    res.json({ project: updated });
  });

  router.get('/:id/download', async (req, res) => {
    const project = findProject(req.params.id);
    const archivePath = archivePathOf(project);
    await assertFileExists(archivePath, 'הארכיון השמור של הפרויקט הזה חסר.');
    res.download(archivePath, project.archive.originalName);
  });

  router.delete('/:id', async (req, res) => {
    const removed = await store.remove('projects', req.params.id);
    if (!removed) throw notFound('הפרויקט לא נמצא.');
    await fs.rm(archivePathOf(removed), { force: true });
    forgetArchive(removed);
    for (const explanation of store.list('explanations')) {
      if (explanation.projectId === removed.id) await store.remove('explanations', explanation.id);
    }
    res.status(204).end();
  });

  return router;
}

/** Validates a PATCH body. Only the fields present are changed. */
export function validateEdits(body) {
  const patch = {};

  if (body?.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > 120) throw new HttpError(400, 'הכותרת צריכה להכיל בין 1 ל-120 תווים.', 'INVALID_TITLE');
    patch.title = title;
  }

  if (body?.description !== undefined) {
    const description = typeof body.description === 'string' ? body.description.trim() : null;
    if (description === null || description.length > 600) {
      throw new HttpError(400, 'התיאור יכול להכיל עד 600 תווים.', 'INVALID_DESCRIPTION');
    }
    patch.description = description;
  }

  if (body?.tags !== undefined) {
    const tags = Array.isArray(body.tags) ? body.tags.map((tag) => (typeof tag === 'string' ? tag.trim() : '')) : null;
    if (!tags || tags.length > 12 || tags.some((tag) => !tag || tag.length > 30)) {
      throw new HttpError(400, 'אפשר להוסיף עד 12 תגיות, ובכל אחת 1 עד 30 תווים.', 'INVALID_TAGS');
    }
    const unique = new Map();
    for (const tag of tags) if (!unique.has(tag.toLowerCase())) unique.set(tag.toLowerCase(), tag);
    patch.tags = [...unique.values()];
  }

  if (!Object.keys(patch).length) {
    throw new HttpError(400, 'אין מה לעדכן. שלחו כותרת, תיאור או תגיות.', 'EMPTY_UPDATE');
  }
  return patch;
}

async function assertFileExists(filePath, message) {
  try {
    await fs.access(filePath);
  } catch {
    throw new HttpError(410, message, 'ARCHIVE_MISSING');
  }
}
