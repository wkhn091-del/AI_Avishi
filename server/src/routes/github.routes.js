/**
 * /api/github: the GitHub tab.
 *
 *   GET    /status                                  connection: user, token source, rate limit
 *   PUT    /token                { token }          validate with GitHub, then save
 *   DELETE /token                                   remove the saved token
 *   GET    /repos                                   your repositories, merged with saved analyses
 *   POST   /analyze/:repo                           analyse one of your repositories (Hebrew summary)
 *   POST   /analyze/:owner/:repo                    the same for any repository the token can read
 *   PATCH  /repos/:owner/:repo                      edit the title, description or tags of an analysis
 *   GET    /repos/:owner/:repo/files                folder tree
 *   GET    /repos/:owner/:repo/files/content?path=  one text file, raw
 *   POST   /repos/:owner/:repo/files/explain        { path, refresh? } → Hebrew AI explanation
 *   GET    /repos/:owner/:repo/preview              the website (homepage or GitHub Pages), or README and run hints
 *   GET    /repos/:owner/:repo/raw/*                one file's bytes (images, downloads), sandboxed like /serve
 */
import { Router } from 'express';
import { isolate } from '../lib/bidi.js';
import { HttpError } from '../lib/httpError.js';
import { AiError, aiHttpError } from '../services/ai/llmClient.js';
import { checkFramable } from '../services/github/framing.js';
import { currentToken, getAuthStatus, removeToken, requireToken, saveToken } from '../services/github/githubClient.js';
import { analyzeRepository } from '../services/github/repoAnalyzer.js';
import { getPagesUrl, getRepo, getTree, listRepos, readRepoFile } from '../services/github/repoService.js';
import { MAX_VIEW_BYTES, buildTree, cleanRequestPath, decodeText, isBinaryPath, sendFileBytes } from '../services/projects/archiveReader.js';
import { explainFile } from '../services/projects/fileExplainer.js';
import { findReadme, runHints } from '../services/projects/previewPlanner.js';
import { validateEdits } from './projects.routes.js';

const repoId = (owner, name) => `${owner}/${name}`.toLowerCase();
const formatSize = (bytes) => isolate(`${(bytes / 1024 / 1024).toFixed(1)} MB`);
const binaryError = () => new HttpError(415, 'זה קובץ בינארי, ולכן אין לו תצוגת קוד. אפשר להוריד אותו.', 'BINARY_FILE');

/** A repository as the client sees it: GitHub metadata plus the saved analysis, shaped like a ZIP project. */
export function mergeRepo(meta, analysis) {
  return {
    id: repoId(meta.owner, meta.name),
    source: 'github',
    github: meta,
    analyzed: Boolean(analysis),
    title: analysis?.title ?? meta.name,
    description: analysis?.description ?? meta.description,
    tags: analysis?.tags ?? meta.topics,
    kind: analysis?.kind ?? null,
    techStack: analysis?.techStack ?? [],
    languages: analysis?.languages ?? [],
    fingerprint: analysis?.fingerprint ?? [],
    entryPoints: analysis?.entryPoints ?? [],
    keyFiles: analysis?.keyFiles ?? [],
    topLevel: analysis?.topLevel ?? [],
    readmeExcerpt: analysis?.readmeExcerpt ?? null,
    stats: analysis?.stats ?? null,
    summary: analysis?.summary ?? null,
    edited: analysis?.edited ?? false,
    analyzedAt: analysis?.analyzedAt ?? null,
    createdAt: analysis?.createdAt ?? meta.pushedAt,
  };
}

/** Archive-like view of a tree, so the explorer's tree builder and the run hints work unchanged. */
function treeArchive(tree, contents = new Map()) {
  const files = new Map();
  const dirs = new Set(['']);
  for (const file of tree.files) {
    files.set(file.path, { path: file.path, size: file.size, sha: file.sha, entry: { getData: () => contents.get(file.path) ?? Buffer.alloc(0) } });
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return { files, dirs, memo: {} };
}

const archives = new Map(); // tree sha → archive-like view (with its memoised folder tree)
function archiveOf(tree) {
  let archive = archives.get(tree.sha);
  if (!archive) {
    archive = treeArchive(tree);
    archives.set(tree.sha, archive);
    if (archives.size > 20) archives.delete(archives.keys().next().value);
  }
  return archive;
}

/** "example.com" → "https://example.com/"; null for anything that isn't a web address. */
function websiteOf(value) {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** @param {{ store: import('../lib/jsonStore.js').JsonStore }} deps */
export function githubRouter({ store }) {
  const router = Router();
  const merged = (meta) => mergeRepo(meta, store.get('repos', repoId(meta.owner, meta.name)));

  const loadRepo = async (req) => {
    const { token } = await currentToken();
    return { meta: await getRepo(req.params.owner, req.params.repo, token), token };
  };
  const loadFile = async (req, value) => {
    const { meta, token } = await loadRepo(req);
    const filePath = cleanRequestPath(value);
    if (!filePath) throw new HttpError(400, 'הנתיב של הקובץ אינו תקין.', 'INVALID_PATH');
    const file = archiveOf(await getTree(meta, token)).files.get(filePath);
    if (!file) throw new HttpError(404, 'הקובץ לא נמצא במאגר.', 'FILE_NOT_FOUND');
    return { meta, token, file };
  };

  router.get('/status', async (req, res) => {
    res.json({ github: await getAuthStatus({ fresh: req.query.fresh === '1' }) });
  });
  router.put('/token', async (req, res) => {
    res.json({ github: await saveToken(req.body?.token) });
  });
  router.delete('/token', async (req, res) => {
    res.json({ github: await removeToken() });
  });

  router.get('/repos', async (req, res) => {
    const { token } = await requireToken();
    res.json({ repos: (await listRepos(token)).map(merged) });
  });

  const analyze = async (req, res) => {
    const { token } = await currentToken();
    let owner = req.params.owner;
    if (!owner) {
      const status = await getAuthStatus();
      if (!status.connected) {
        throw new HttpError(401, 'כדי לנתח מאגר לפי שם בלבד צריך לחבר את GitHub בהגדרות, או לציין גם את הבעלים של המאגר.', 'GITHUB_NOT_CONNECTED');
      }
      owner = status.user.login;
    }
    const meta = await getRepo(owner, req.params.repo, token);
    const analysis = await analyzeRepository(meta, token);
    const id = repoId(meta.owner, meta.name);
    const existing = store.get('repos', id);
    const now = new Date().toISOString();
    const record = { id, fullName: meta.fullName, ...analysis, edited: false, analyzedAt: now, createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (existing) await store.update('repos', id, record);
    else await store.insert('repos', record);
    res.json({ repo: merged(meta) });
  };
  router.post('/analyze/:repo', analyze);
  router.post('/analyze/:owner/:repo', analyze);

  router.patch('/repos/:owner/:repo', async (req, res) => {
    const id = repoId(req.params.owner, req.params.repo);
    if (!store.get('repos', id)) throw new HttpError(404, 'למאגר הזה עדיין אין ניתוח לעריכה.', 'NOT_ANALYZED');
    await store.update('repos', id, { ...validateEdits(req.body), edited: true, updatedAt: new Date().toISOString() });
    const { meta } = await loadRepo(req);
    res.json({ repo: merged(meta) });
  });

  router.get('/repos/:owner/:repo/files', async (req, res) => {
    const { meta, token } = await loadRepo(req);
    res.json(buildTree(archiveOf(await getTree(meta, token))));
  });

  router.get('/repos/:owner/:repo/files/content', async (req, res) => {
    const { meta, token, file } = await loadFile(req, req.query.path);
    if (isBinaryPath(file.path)) throw binaryError();
    if (file.size > MAX_VIEW_BYTES) {
      throw new HttpError(413, `הקובץ גדול מדי לתצוגה (${formatSize(file.size)}). אפשר להוריד אותו.`, 'FILE_TOO_LARGE_TO_VIEW');
    }
    const text = decodeText(await readRepoFile(meta, file.path, token));
    if (text === null) throw binaryError();
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-File-Size': String(file.size) });
    res.send(text);
  });

  router.get('/repos/:owner/:repo/raw{/*path}', async (req, res) => {
    const { meta, token, file } = await loadFile(req, (req.params.path ?? []).join('/'));
    sendFileBytes(res, file.path, await readRepoFile(meta, file.path, token), { sandbox: true, download: req.query.download === '1' });
  });

  router.post('/repos/:owner/:repo/files/explain', async (req, res) => {
    const { meta, token, file } = await loadFile(req, req.body?.path);
    if (isBinaryPath(file.path)) throw binaryError();
    // The blob sha is part of the key, so a changed file gets a fresh explanation.
    const id = `gh:${repoId(meta.owner, meta.name)}:${file.path}:${file.sha}`;
    const cached = store.get('explanations', id);
    if (cached && !req.body?.refresh) return res.json({ explanation: { ...cached, cached: true } });

    const text = decodeText(await readRepoFile(meta, file.path, token));
    if (text === null) throw binaryError();
    let result;
    try {
      result = await explainFile({ project: merged(meta), path: file.path, text });
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      console.warn(`[ai] Explaining "${meta.fullName}/${file.path}" failed: ${error.log}`);
      throw aiHttpError(error);
    }
    const record = { id, projectId: `gh:${repoId(meta.owner, meta.name)}`, path: file.path, ...result };
    if (cached) await store.update('explanations', id, record);
    else await store.insert('explanations', record);
    res.json({ explanation: { ...record, cached: false } });
  });

  router.get('/repos/:owner/:repo/preview', async (req, res) => {
    const { meta, token } = await loadRepo(req);
    let tree = { sha: `empty:${meta.fullName}`, files: [] };
    try {
      tree = await getTree(meta, token);
    } catch (error) {
      if (error.code !== 'GITHUB_EMPTY_REPO') throw error;
    }
    const readme = findReadme(archiveOf(tree));
    const homepage = websiteOf(meta.homepage);
    const url = homepage ?? (await getPagesUrl(meta, token));
    if (url) {
      const { framable } = await checkFramable(url);
      return res.json({ preview: { mode: 'external', url, site: homepage ? 'homepage' : 'pages', framable, readme } });
    }
    // The run hints read package.json scripts, so fetch the manifests they look at.
    const manifests = tree.files.filter((file) => /(^|\/)package\.json$/.test(file.path) && file.path.split('/').length <= 2 && file.size < 256 * 1024);
    const contents = new Map();
    for (const file of manifests.slice(0, 3)) {
      try {
        contents.set(file.path, await readRepoFile(meta, file.path, token));
      } catch {
        // hints without scripts
      }
    }
    res.json({
      preview: {
        mode: readme ? 'readme' : 'none',
        readme,
        title: 'אין אתר חי למאגר הזה',
        reason: 'למאגר לא הוגדרה כתובת אתר (Website) ב-GitHub, והוא לא מפורסם ב-GitHub Pages. אחרי שתוסיפו כתובת בהגדרות המאגר ב-GitHub, האתר יוצג כאן.',
        hints: runHints(treeArchive(tree, contents), merged(meta)),
      },
    });
  });

  return router;
}
