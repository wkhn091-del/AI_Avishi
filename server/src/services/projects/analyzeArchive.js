/**
 * The whole "smart ZIP" pipeline behind one function.
 *
 *   scanArchive      → what's inside (file list, key files' text)   archiveScanner.js
 *   deriveInsights   → stack, languages, kind, fingerprint, heuristics   insights.js
 *   summarizeProject → title, description, tags (AI or heuristic)   summarizer.js
 *
 * Routes call this for both new uploads and "Re-analyze".
 */
import { scanArchive } from './archiveScanner.js';
import { deriveInsights } from './insights.js';
import { summarizeProject } from './summarizer.js';

/**
 * @param {string} filePath Absolute path of the stored .zip
 * @param {{ archiveName: string }} options Original upload name (used for naming hints)
 * @returns {Promise<object>} The analysed fields of a project record
 */
export async function analyzeArchive(filePath, { archiveName }) {
  return analyzeScan(scanArchive(filePath, { archiveName }));
}

/** Insights and summary for a scan: the same for ZIP archives and GitHub repositories. */
export async function analyzeScan(scan) {
  const insights = deriveInsights(scan);
  const { title, description, tags, summary } = await summarizeProject(scan, insights);

  return {
    title,
    description,
    tags,
    kind: insights.kind,
    techStack: insights.techStack,
    languages: insights.languages,
    fingerprint: insights.fingerprint,
    entryPoints: insights.entryPoints,
    keyFiles: insights.keyFiles,
    topLevel: scan.topLevel,
    readmeExcerpt: insights.readme?.excerpt || null,
    stats: scan.stats,
    summary,
  };
}
