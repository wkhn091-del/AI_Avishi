/**
 * Analyses a GitHub repository with the same pipeline as a ZIP archive: the
 * file tree replaces the archive listing, and only the key files (README,
 * manifests, index.html…) are downloaded.
 */
import { analyzeScan } from '../projects/analyzeArchive.js';
import { decodeText } from '../projects/archiveReader.js';
import { KEY_FILE_MAX_BYTES, assembleScan, fillKeyFiles, isNoise, selectKeyFiles } from '../projects/archiveScanner.js';
import { getTree, readRepoFile } from './repoService.js';

const MAX_FILES = 50_000;
const PARALLEL_DOWNLOADS = 4;

export async function analyzeRepository(meta, token) {
  const tree = await getTree(meta, token);
  let ignoredEntries = 0;
  const files = [];
  for (const file of tree.files) {
    if (isNoise(file.path)) ignoredEntries += 1;
    else files.push(file);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const kept = files.slice(0, MAX_FILES);

  const selection = selectKeyFiles(kept);
  const wanted = new Map();
  for (const { files: selected } of Object.values(selection)) {
    for (const file of selected) if (file.size <= KEY_FILE_MAX_BYTES) wanted.set(file.path, file);
  }
  const texts = new Map();
  await forEachLimited([...wanted.values()], PARALLEL_DOWNLOADS, async (file) => {
    try {
      const text = decodeText(await readRepoFile(meta, file.path, token));
      if (text !== null) texts.set(file.path, text);
    } catch {
      // an unreadable key file only makes the summary less informed
    }
  });

  const scan = assembleScan({
    archiveName: meta.name,
    files: kept,
    ignoredEntries,
    truncated: tree.truncated || files.length > MAX_FILES,
    keyFiles: fillKeyFiles(selection, (file) => texts.get(file.path) ?? null),
  });
  return { ...(await analyzeScan(scan)), headSha: tree.sha };
}

async function forEachLimited(items, limit, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
