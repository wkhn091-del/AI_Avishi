/**
 * Reads a project's stored ZIP in memory (adm-zip) for the file explorer, the
 * code viewer, file explanations and the live preview. Nothing is extracted
 * to disk.
 *
 * Paths match the analysis: separators are normalised, entries that try to
 * escape the archive are dropped, macOS/Windows junk is skipped and a single
 * wrapper folder ("repo-main/") is unwrapped. Opened archives are cached
 * (least recently used first out, within a memory budget).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from '../../config.js';
import { HttpError } from '../../lib/httpError.js';
import { mimeTypeOf } from '../../lib/mime.js';
import { NOISE_DIRECTORIES, findWrapperPrefix, isNoise, normalizeEntryPath } from './archiveScanner.js';

const CACHE_BUDGET_BYTES = 400 * 1024 * 1024;
const MAX_TREE_FILES = 20_000;
/** Largest file the code viewer shows. */
export const MAX_VIEW_BYTES = 1024 * 1024;

const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const BUILD_OUTPUT_DIRS = new Set(['dist', 'build', 'out']);
/** Dependency, VCS and cache folders are hidden in the explorer; build output stays visible (the preview serves it). */
export const HIDDEN_DIRECTORIES = new Set([...NOISE_DIRECTORIES].filter((name) => !BUILD_OUTPUT_DIRS.has(name)));

const BINARY_EXTENSIONS = new Set(
  ('png jpg jpeg gif webp avif bmp ico icns tif tiff psd pdf zip gz tgz bz2 xz 7z rar jar war class exe dll so dylib ' +
    'bin dat pck wasm mp3 wav ogg flac m4a aac mp4 m4v mov webm mkv avi woff woff2 ttf otf eot sqlite db blend fbx glb ' +
    'unitypackage keystore jks apk aab ipa').split(' '),
);

/**
 * @typedef {{ path: string, size: number, entry: import('adm-zip').IZipEntry }} ArchiveFile
 * @typedef {{ files: Map<string, ArchiveFile>, dirs: Set<string>, memo: Record<string, unknown> }} ProjectArchive
 */

const cache = new Map();

export const archivePathOf = (project) => path.join(config.paths.archives, path.basename(project.archive.storedName));

/** @returns {Promise<ProjectArchive>} */
export async function openArchive(project) {
  const file = archivePathOf(project);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new HttpError(410, 'הארכיון השמור של הפרויקט הזה חסר.', 'ARCHIVE_MISSING');
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    cache.delete(file); // re-insert: Map order doubles as the recency order
    cache.set(file, cached);
    return cached.archive;
  }
  let zip;
  try {
    zip = new AdmZip(file);
  } catch {
    throw new HttpError(422, 'הקובץ אינו ארכיון ZIP תקין, או שהוא פגום.', 'INVALID_ZIP');
  }
  const archive = indexArchive(zip);
  cache.set(file, { archive, mtimeMs: stat.mtimeMs, bytes: stat.size });
  trimCache();
  return archive;
}

/** Drops a project's archive from the cache (after it's deleted). */
export function forgetArchive(project) {
  cache.delete(archivePathOf(project));
}

function trimCache() {
  let total = 0;
  for (const item of cache.values()) total += item.bytes;
  for (const [key, item] of cache) {
    if (total <= CACHE_BUDGET_BYTES || cache.size <= 1) break;
    cache.delete(key);
    total -= item.bytes;
  }
}

function indexArchive(zip) {
  const raw = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const entryPath = normalizeEntryPath(entry.entryName);
    if (!entryPath) continue;
    const lower = entryPath.toLowerCase().split('/');
    const name = lower.at(-1);
    if (JUNK_FILES.has(name) || name.startsWith('._') || lower.includes('__macosx')) continue;
    raw.push({ path: entryPath, entry });
  }
  // Same unwrapping as the analysis; if only build output is present (a zipped dist/), unwrap that.
  const meaningful = raw.map((file) => file.path).filter((p) => !isNoise(p));
  const prefix = findWrapperPrefix(meaningful.length ? meaningful : raw.map((file) => file.path));

  const files = new Map();
  const dirs = new Set(['']);
  for (const { path: entryPath, entry } of raw) {
    if (!entryPath.startsWith(prefix)) continue;
    const relative = entryPath.slice(prefix.length);
    if (!relative || files.has(relative)) continue;
    files.set(relative, { path: relative, size: Number(entry.header.size) || 0, entry });
    const parts = relative.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return { files, dirs, memo: {} };
}

/**
 * Validates a path from a request ("src/App.tsx"). Returns '' for the root and
 * null when the path is invalid (traversal, NUL bytes, absurd length).
 */
export function cleanRequestPath(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 1024) return null;
  const segments = value.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.includes('\0'))) return null;
  return segments.join('/');
}

/** Decompressed bytes of one file, or null. */
export function readBytes(archive, filePath) {
  return archive.files.get(filePath)?.entry.getData() ?? null;
}

/** True for file types that never have a text view (images, fonts, media, binaries). */
export function isBinaryPath(filePath) {
  const name = filePath.split('/').pop().toLowerCase();
  return name.includes('.') && BINARY_EXTENSIONS.has(name.split('.').pop());
}

/**
 * Text for the code viewer: UTF-8 (with or without BOM), UTF-16 with BOM, or
 * windows-1255 for older Hebrew files. Returns null for binary content.
 */
export function decodeText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (looksBinary(bytes)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1255').decode(bytes);
  }
}

function looksBinary(bytes) {
  const sample = bytes.subarray(0, 8000);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 32 && ![9, 10, 12, 13, 27].includes(byte)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.05;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Folder tree for the explorer: folders first, natural sort order. Hidden
 * folders (node_modules, .git…) are counted rather than listed.
 */
export function buildTree(archive) {
  if (archive.memo.tree) return archive.memo.tree;
  const root = { name: '', path: '', type: 'dir', children: [] };
  const folders = new Map([['', root]]);
  const hiddenFolders = new Set();
  let hiddenCount = 0;
  let fileCount = 0;
  let truncated = false;

  for (const file of [...archive.files.values()].sort((a, b) => collator.compare(a.path, b.path))) {
    const segments = file.path.split('/');
    const hiddenAt = segments.slice(0, -1).findIndex((segment) => HIDDEN_DIRECTORIES.has(segment.toLowerCase()));
    if (hiddenAt !== -1) {
      hiddenCount += 1;
      hiddenFolders.add(segments[hiddenAt]);
      continue;
    }
    if (fileCount >= MAX_TREE_FILES) {
      truncated = true;
      continue;
    }
    fileCount += 1;
    let parent = root;
    let current = '';
    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      let folder = folders.get(current);
      if (!folder) {
        folder = { name: segment, path: current, type: 'dir', children: [] };
        folders.set(current, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({ name: segments.at(-1), path: file.path, type: 'file', size: file.size });
  }
  sortTree(root);
  archive.memo.tree = { tree: root, fileCount, hidden: { count: hiddenCount, folders: [...hiddenFolders].slice(0, 6) }, truncated };
  return archive.memo.tree;
}

function sortTree(node) {
  node.children.sort((a, b) => (a.type === b.type ? collator.compare(a.name, b.name) : a.type === 'dir' ? -1 : 1));
  for (const child of node.children) if (child.type === 'dir') sortTree(child);
}

/**
 * Sends one archive file. With `sandbox`, documents get an opaque origin
 * (CSP sandbox) so a served page can't reach the dashboard or its API, and
 * CORS is opened so that page's module scripts and fonts still load.
 */
export function sendArchiveFile(res, archive, filePath, options = {}) {
  sendFileBytes(res, filePath, archive.files.get(filePath).entry.getData(), options);
}

/** Sends file bytes with a content type taken from the path (archive files and GitHub files alike). */
export function sendFileBytes(res, filePath, bytes, { sandbox = false, download = false } = {}) {
  if (download) res.attachment(filePath.split('/').pop());
  const { type, encoding } = mimeTypeOf(filePath);
  res.set('Content-Type', type);
  if (encoding) res.set('Content-Encoding', encoding);
  res.set('Cache-Control', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  if (sandbox) {
    res.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads');
    res.set('Access-Control-Allow-Origin', '*');
  }
  res.send(bytes);
}
