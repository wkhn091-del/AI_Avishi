/**
 * Builds the Express application. Kept separate from index.js (which starts
 * the server) so the app can be created with any store — e.g. in tests.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { apiNotFound, errorHandler, notFound } from './middleware/errorHandler.js';
import { cors } from './middleware/cors.js';
import { localGuard } from './middleware/localGuard.js';
import { previewHost } from './middleware/previewHost.js';
import { sandboxPreviewHost } from './services/ai/swarm/preview.js';
import { requestLogger } from './middleware/requestLogger.js';
import { filesRouter } from './routes/files.routes.js';
import { chatRouter } from './routes/chat.routes.js';
import { memoryRouter } from './routes/memory.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { requireAdmin, requireAuth } from './middleware/auth.js';
import { githubRouter } from './routes/github.routes.js';
import { linksRouter } from './routes/links.routes.js';
import { mediaRouter } from './routes/media.routes.js';
import { projectFilesRouter } from './routes/projectFiles.routes.js';
import { projectsRouter } from './routes/projects.routes.js';
import { systemRouter } from './routes/system.routes.js';

/** @param {{ store: import('./lib/jsonStore.js').JsonStore }} deps */
export function createApp({ store }) {
  const app = express();
  app.disable('x-powered-by');

  // Live previews answer on their own origin (p-<id>.localhost) before anything else.
  // Live previews of generated projects, each on its own origin (s-<token>.localhost), before anything reads a body.
  app.use(sandboxPreviewHost());
  app.use(previewHost({ store }));

  app.use(requestLogger);
  app.use(localGuard);
  // For the browser app when it's served from another origin (CORS_ORIGINS).
  app.use(cors);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  // --- API -------------------------------------------------------------------
  app.use('/api', express.json({ limit: '64kb' }));
  // Public: health, and what the browser needs to sign in.
  app.use('/api', systemRouter());
  app.use('/api/auth', authRouter());
  // Everything else needs a signed-in person.
  app.use('/api', requireAuth);
  // Each person's own data.
  app.use('/api/chat', chatRouter({ store }));
  app.use('/api/memory', memoryRouter());
  app.use('/api/media', mediaRouter({ store }));
  // Tools that keep one shared store (and GitHub runs on the server's own token): admins only.
  app.use('/api/projects', requireAdmin, projectsRouter({ store }));
  app.use('/api/projects', requireAdmin, projectFilesRouter({ store }));
  app.use('/api/github', requireAdmin, githubRouter({ store }));
  app.use('/api/links', requireAdmin, linksRouter({ store }));
  app.use('/api/files', requireAdmin, filesRouter({ store }));
  app.use('/api', apiNotFound);

  // --- Built client (npm start) ----------------------------------------------
  if (config.serveClient) serveBuiltClient(app);
  // Without the browser app here (API only, with the app on Vercel, say): the root says what this is, and any other
  // path gets a JSON 404 rather than Express's "Cannot GET /".
  app.get('/', (req, res) => res.json({ name: 'Stash API', health: '/api/health' }));
  app.use(notFound);

  app.use(errorHandler);
  return app;
}

function serveBuiltClient(app) {
  const indexHtml = path.join(config.paths.clientDist, 'index.html');
  if (!existsSync(indexHtml)) {
    console.warn('[client] client/dist is missing — run "npm run build" first. Serving the API only.');
    return;
  }

  app.use(
    express.static(config.paths.clientDist, {
      index: false,
      setHeaders(res, filePath) {
        // Vite fingerprints everything in /assets, so it can be cached forever.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  // SPA fallback: any other GET that isn't an API call gets index.html.
  // (A middleware instead of a wildcard route — Express 5 path syntax changed.)
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
}
