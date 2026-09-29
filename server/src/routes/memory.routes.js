/**
 * The signed-in person's long-term memory, for them to see and control (only their own):
 *   GET    /api/memory        the memories, and where they are kept and how they are searched
 *   POST   /api/memory        add one by hand: { content, kind?, project? }
 *   PATCH  /api/memory/:id    edit one: { content?, kind?, project? }
 *   DELETE /api/memory/:id    forget one
 *   DELETE /api/memory        forget everything
 */
import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../lib/httpError.js';
import { embedder } from '../services/memory/embeddings.js';
import { looksSecret } from '../services/memory/learner.js';
import { CONTENT_MAX, MEMORY_KINDS, PROJECT_MAX, addMemory, clearMemories, listMemories, removeMemory, updateMemory } from '../services/memory/memoryStore.js';
import { ensureUser } from '../services/users.js';

const PROVIDER_NAMES = { gemini: 'Gemini', openai: 'OpenAI' };

function enabledOnly() {
  if (!config.longTermMemory.enabled) throw new HttpError(403, 'הזיכרון לטווח ארוך כבוי (LONG_TERM_MEMORY=off).', 'MEMORY_DISABLED');
}

/** The fields of a memory from a request body; `partial` for an edit. */
function fieldsOf(body, { partial = false } = {}) {
  const fields = {};
  if (!partial || body.content !== undefined) {
    const content = typeof body.content === 'string' ? body.content.replace(/\s+/g, ' ').trim() : '';
    if (content.length < 3 || content.length > CONTENT_MAX) throw new HttpError(400, `כתבו זיכרון באורך 3 עד ${CONTENT_MAX} תווים.`, 'INVALID_MEMORY');
    if (looksSecret(content)) throw new HttpError(400, 'אל תשמרו בזיכרון מפתחות, סיסמאות או טוקנים.', 'SECRET_IN_MEMORY');
    fields.content = content;
  }
  if (!partial || body.kind !== undefined) {
    const kind = body.kind ?? 'preference';
    if (!MEMORY_KINDS.includes(kind)) throw new HttpError(400, 'סוג הזיכרון אינו מוכר.', 'INVALID_MEMORY');
    fields.kind = kind;
  }
  if (!partial || body.project !== undefined) {
    const project = typeof body.project === 'string' ? body.project.trim() : '';
    if (project.length > PROJECT_MAX) throw new HttpError(400, `שם הפרויקט ארוך מ-${PROJECT_MAX} תווים.`, 'INVALID_MEMORY');
    fields.project = project || null;
  }
  return fields;
}

/** A database that can't be reached (PostgreSQL down, a locked file) answers 503, in Hebrew. */
const guarded = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn(`[memory] ${error.message}`);
    throw new HttpError(503, `מסד הנתונים של הזיכרון לא זמין: ${error.message}`, 'MEMORY_UNAVAILABLE');
  }
};

export function memoryRouter() {
  const router = Router();

  router.get(
    '/',
    guarded(async (req, res) => {
      const enabled = config.longTermMemory.enabled;
      res.json({
        enabled,
        database: 'PostgreSQL',
        embeddings: PROVIDER_NAMES[embedder()?.provider] ?? null,
        memories: enabled ? await listMemories(req.user.id) : [],
      });
    }),
  );

  router.post(
    '/',
    guarded(async (req, res) => {
      enabledOnly();
      await ensureUser(req.user);
      const memory = await addMemory(req.user.id, { ...fieldsOf(req.body ?? {}), source: 'user' });
      res.status(201).json({ memory });
    }),
  );

  router.patch(
    '/:id',
    guarded(async (req, res) => {
      enabledOnly();
      const memory = await updateMemory(req.user.id, req.params.id, fieldsOf(req.body ?? {}, { partial: true }));
      if (!memory) throw new HttpError(404, 'הזיכרון לא נמצא.', 'NOT_FOUND');
      res.json({ memory });
    }),
  );

  router.delete(
    '/:id',
    guarded(async (req, res) => {
      enabledOnly();
      if (!(await removeMemory(req.user.id, req.params.id))) throw new HttpError(404, 'הזיכרון לא נמצא.', 'NOT_FOUND');
      res.status(204).end();
    }),
  );

  router.delete(
    '/',
    guarded(async (req, res) => {
      enabledOnly();
      res.json({ removed: await clearMemories(req.user.id) });
    }),
  );

  return router;
}
