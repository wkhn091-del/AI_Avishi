/**
 * Live previews on their own origin: http://p-<project id>.localhost:<port>/
 * serves the project's web root (e.g. dist/) at "/", so absolute asset paths
 * and client-side routing work as on a real host. The preview can't reach the
 * dashboard: it is a different origin, it never gets API routes, and the
 * dashboard's writes require same-origin requests (see localGuard).
 * Browsers resolve every *.localhost name to this computer.
 */
import { config } from '../config.js';
import { openArchive, sendArchiveFile } from '../services/projects/archiveReader.js';
import { previewPlanOf } from '../services/projects/previewPlanner.js';

const PREVIEW_HOST = /^p-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.localhost$/i;

export const previewOriginOf = (projectId) => `http://p-${projectId}.localhost:${config.port}/`;

/** @param {{ store: import('../lib/jsonStore.js').JsonStore }} deps */
export function previewHost({ store }) {
  return async (req, res, next) => {
    const match = PREVIEW_HOST.exec(req.hostname ?? '');
    if (!match) return next();
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).set('Allow', 'GET, HEAD').type('text/plain; charset=utf-8').send('התצוגה המקדימה מגישה קבצים סטטיים בלבד.');
      }
      if (req.path === '/__stash/ping') return res.status(204).set('Access-Control-Allow-Origin', '*').end();

      const project = store.get('projects', match[1].toLowerCase());
      if (!project) return page(res, 404, 'הפרויקט לא נמצא.');
      const archive = await openArchive(project);
      const plan = previewPlanOf(archive, project);
      if (plan.mode !== 'site') return page(res, 404, 'לפרויקט הזה אין אתר מוכן לתצוגה מקדימה.');

      const target = resolveSitePath(archive, plan.webRoot, req.path);
      if (!target) return page(res, 404, 'הדף לא נמצא בתצוגה המקדימה.');
      if (target.redirect) return res.redirect(301, target.redirect);
      sendArchiveFile(res, archive, target.path);
    } catch (error) {
      next(error);
    }
  };
}

/** Static-host rules: exact file, folder → index.html, "/about" → about.html, and index.html for app routes. */
function resolveSitePath(archive, webRoot, urlPath) {
  const segments = [];
  for (const raw of urlPath.split('/')) {
    if (!raw) continue;
    let segment;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '..' || segment === '.' || segment.includes('\0')) return null;
    segments.push(segment);
  }
  const relative = segments.join('/');
  const full = `${webRoot}${relative}`;
  if (relative && archive.files.has(full)) return { path: full };
  if (!relative || archive.dirs.has(full)) {
    if (relative && !urlPath.endsWith('/')) return { redirect: `${urlPath}/` };
    const index = relative ? `${full}/index.html` : `${webRoot}index.html`;
    if (archive.files.has(index)) return { path: index };
  }
  if (relative && archive.files.has(`${full}.html`)) return { path: `${full}.html` };
  if (!(segments.at(-1) ?? '').includes('.')) return { path: `${webRoot}index.html` };
  return null;
}

function page(res, status, message) {
  res
    .status(status)
    .type('html')
    .set('Cache-Control', 'no-cache')
    .send(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>Stash</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:16px system-ui,sans-serif;color:#5a6273;background:#eef0f3">
<p>${message}</p></body></html>`);
}
