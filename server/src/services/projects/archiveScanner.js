/**
 * Archive scanner — step 1 of project analysis.
 *
 * Reads a ZIP in memory (nothing is extracted to disk) and returns a
 * normalised view of it: the meaningful file list, size stats, a top-level
 * outline, and the decoded text of a few "key files" (README, manifests,
 * entry HTML). Parsing that text is the job of manifestParsers/insights.
 *
 * Safety properties
 *  - No disk extraction, so path-traversal entries ("zip slip") can't escape;
 *    they are dropped from the listing anyway.
 *  - Only small key files are decompressed (≤ KEY_FILE_MAX_BYTES each), and
 *    adm-zip ≥ 0.6 caps inflation at the declared size, so a forged header
 *    can't turn one of them into a decompression bomb.
 *  - Enumeration stops after MAX_ENTRIES entries.
 */
import AdmZip from 'adm-zip';
import { HttpError } from '../../lib/httpError.js';

const MAX_ENTRIES = 50_000;
export const KEY_FILE_MAX_BYTES = 512 * 1024;
const MAX_WRAPPER_DEPTH = 3;
const MAX_TOP_LEVEL_ITEMS = 40;

/** Folders holding dependencies, VCS data, caches or build output. */
export const NOISE_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', '__macosx', '.idea', '.vscode', '.vs',
  'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', '.expo', '.turbo',
  '.cache', '.parcel-cache', 'coverage', '.gradle', 'pods', 'vendor', 'target',
  '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.tox',
  // Unity's regenerated folders
  'library', 'temp', 'logs', 'obj',
]);
const NOISE_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * Key files to decode. `depth` is the deepest folder level searched
 * (0 = archive root) so monorepos like client/ + server/ are still understood.
 * With `many`, every match is returned (shallowest first); otherwise only the
 * shallowest one.
 */
const KEY_FILES = [
  { key: 'readme', depth: 1, test: (name) => /^readme(\.(md|markdown|mdx|txt|rst))?$/.test(name) },
  { key: 'packageJson', depth: 2, many: true, test: (name) => name === 'package.json' },
  { key: 'indexHtml', depth: 2, test: (name) => name === 'index.html' },
  { key: 'pyproject', depth: 1, test: (name) => name === 'pyproject.toml' },
  { key: 'requirements', depth: 2, many: true, test: (name) => name === 'requirements.txt' },
  { key: 'cargoToml', depth: 1, test: (name) => name === 'cargo.toml' },
  { key: 'goMod', depth: 1, test: (name) => name === 'go.mod' },
  { key: 'pubspec', depth: 1, test: (name) => name === 'pubspec.yaml' },
  { key: 'composerJson', depth: 1, test: (name) => name === 'composer.json' },
  { key: 'webManifest', depth: 2, many: true, test: (name) => name === 'manifest.json' },
  { key: 'appJson', depth: 1, test: (name) => name === 'app.json' },
  { key: 'godotProject', depth: 1, test: (name) => name === 'project.godot' },
  { key: 'unityVersion', depth: 1, test: (name, path) => path.toLowerCase().endsWith('projectsettings/projectversion.txt') },
  { key: 'csproj', depth: 2, test: (name) => name.endsWith('.csproj') },
];
const MAX_MATCHES_PER_KEY = 5;

/**
 * @typedef {{ path: string, size: number }} ArchiveFile
 * @typedef {{ path: string, text: string }} KeyFile
 * @typedef {object} ArchiveScan
 * @property {string} archiveName   Original upload name, e.g. "weather-app-main.zip"
 * @property {string|null} rootFolder Wrapper folder that was unwrapped, if any
 * @property {ArchiveFile[]} files   Meaningful files, sorted by path, relative to the unwrapped root
 * @property {{ fileCount: number, totalBytes: number, ignoredEntries: number, truncated: boolean }} stats
 * @property {Array<{ name: string, type: 'dir'|'file', fileCount: number, bytes: number }>} topLevel
 * @property {Record<string, KeyFile|KeyFile[]|null>} keyFiles
 */

/**
 * Scans a ZIP archive on disk.
 * @param {string} filePath Absolute path of the stored .zip
 * @param {{ archiveName: string }} options
 * @returns {ArchiveScan}
 * @throws {HttpError} 422 when the file is not a readable ZIP
 */
export function scanArchive(filePath, { archiveName }) {
  let entries;
  try {
    entries = new AdmZip(filePath).getEntries();
  } catch {
    throw new HttpError(422, 'הקובץ אינו ארכיון ZIP תקין, או שהוא פגום.', 'INVALID_ZIP');
  }

  const truncated = entries.length > MAX_ENTRIES;
  let ignoredEntries = 0;
  const collected = [];

  for (const entry of truncated ? entries.slice(0, MAX_ENTRIES) : entries) {
    if (entry.isDirectory) continue;
    const path = normalizeEntryPath(entry.entryName);
    if (!path) continue;
    if (isNoise(path)) {
      ignoredEntries += 1;
      continue;
    }
    collected.push({ path, size: Number(entry.header.size) || 0, entry });
  }

  // Most downloaded archives wrap everything in one folder ("repo-main/…").
  // Unwrap it so "README.md" means the project's README, not "repo-main/README.md".
  const prefix = findWrapperPrefix(collected.map((file) => file.path));
  if (prefix) for (const file of collected) file.path = file.path.slice(prefix.length);
  collected.sort((a, b) => a.path.localeCompare(b.path));

  return assembleScan({
    archiveName,
    rootFolder: prefix ? prefix.replace(/\/$/, '').split('/').pop() : null,
    files: collected,
    ignoredEntries,
    truncated,
    keyFiles: fillKeyFiles(selectKeyFiles(collected), readText),
  });
}

/**
 * The scan object shared by ZIP archives and GitHub repositories.
 * `files` must already be filtered (no noise) and sorted by path.
 */
export function assembleScan({ archiveName, rootFolder = null, files, ignoredEntries = 0, truncated = false, keyFiles }) {
  return {
    archiveName,
    rootFolder,
    files: files.map(({ path, size }) => ({ path, size })),
    stats: { fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0), ignoredEntries, truncated },
    topLevel: outlineTopLevel(files),
    keyFiles,
  };
}

/** Normalises separators and rejects absolute or traversal paths. Returns '' to skip. */
export function normalizeEntryPath(rawName) {
  const segments = String(rawName).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..')) return '';
  return segments.join('/');
}

export function isNoise(path) {
  const segments = path.toLowerCase().split('/');
  const fileName = segments.pop();
  return NOISE_FILES.has(fileName) || fileName.startsWith('._') || segments.some((s) => NOISE_DIRECTORIES.has(s));
}

/** Returns "wrapper/" (possibly nested, "a/b/") if every file lives under one folder. */
export function findWrapperPrefix(paths) {
  let prefix = '';
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH && paths.length; depth += 1) {
    let folder = null;
    for (const path of paths) {
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) return prefix; // a file sits at this level — stop unwrapping
      const segment = rest.slice(0, slash);
      if (folder === null) folder = segment;
      else if (segment !== folder) return prefix;
    }
    prefix += `${folder}/`;
  }
  return prefix;
}

function outlineTopLevel(files) {
  const items = new Map();
  for (const { path, size } of files) {
    const slash = path.indexOf('/');
    const name = slash === -1 ? path : path.slice(0, slash);
    const type = slash === -1 ? 'file' : 'dir';
    const item = items.get(`${type}:${name}`) ?? { name, type, fileCount: 0, bytes: 0 };
    item.fileCount += 1;
    item.bytes += size;
    items.set(`${type}:${name}`, item);
  }
  return [...items.values()]
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    .slice(0, MAX_TOP_LEVEL_ITEMS);
}

/** Which files the analysis reads, per rule. Files keep their extra fields (a ZIP entry, a Git sha). */
export function selectKeyFiles(files) {
  const selection = {};
  for (const rule of KEY_FILES) {
    selection[rule.key] = {
      many: Boolean(rule.many),
      files: files
        .map((file) => ({ file, depth: file.path.split('/').length - 1 }))
        .filter(({ file, depth }) => depth <= rule.depth && rule.test(file.path.split('/').pop().toLowerCase(), file.path))
        .sort((a, b) => a.depth - b.depth || a.file.path.length - b.file.path.length)
        .slice(0, rule.many ? MAX_MATCHES_PER_KEY : 1)
        .map(({ file }) => file),
    };
  }
  return selection;
}

/** Turns a selection into the keyFiles object; `readText(file)` returns the text, or null when unreadable. */
export function fillKeyFiles(selection, readText) {
  const result = {};
  for (const [key, { many, files }] of Object.entries(selection)) {
    const read = files
      .map((file) => {
        const text = readText(file);
        return text === null || text === undefined ? null : { path: file.path, text };
      })
      .filter(Boolean);
    result[key] = many ? read : (read[0] ?? null);
  }
  return result;
}

/** Decodes a small text entry; returns null for oversized, encrypted, binary or corrupt entries. */
function readText({ entry, size }) {
  if (size > KEY_FILE_MAX_BYTES || entry.header.encrypted) return null;
  try {
    const buffer = entry.getData();
    if (buffer.length > KEY_FILE_MAX_BYTES) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
    if (buffer.subarray(0, 8000).includes(0)) return null; // NUL byte → binary
    return new TextDecoder('utf-8').decode(buffer);
  } catch {
    return null;
  }
}
