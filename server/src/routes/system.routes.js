/**
 * /api/health — liveness plus what the client needs to know up front:
 * whether AI summaries are on, and the upload limits (so oversized files are
 * rejected in the browser before a long upload starts). `database`: whether its tables are there (lib/migrations.js):
 * ready, pending, checking, unreachable or off; it never waits for the database.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { getAiStatus } from '../services/ai/llmClient.js';
import { schemaState } from '../lib/migrations.js';

export function systemRouter() {
  const router = Router();

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      ai: getAiStatus(),
      media: { configured: Boolean(config.media.pollinationsKey) },
      database: schemaState(),
      limits: {
        archiveBytes: config.limits.archiveBytes,
        fileBytes: config.limits.fileBytes,
        filesPerUpload: config.limits.filesPerUpload,
      },
    });
  });

  return router;
}
