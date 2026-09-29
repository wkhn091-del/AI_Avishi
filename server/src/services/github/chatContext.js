/**
 * GitHub context for the chat. A message that mentions a repository (a
 * github.com link, @owner/repo, or @owner/repo:path/to/file) gets that
 * repository's file tree, its README and the requested files, read with the
 * GitHub token (so private repositories work too), for that turn only.
 */
import { decodeText } from '../projects/archiveReader.js';
import { isNoise } from '../projects/archiveScanner.js';
import { currentToken } from './githubClient.js';
import { getRepo, getTree, readRepoFile } from './repoService.js';

const URL_REFERENCE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:blob|tree)\/[^/\s]+\/([^\s#?)\]]+))?(?=$|[\s)#?\],])/g;
const MENTION = /(?:^|[\s(])@([\w.-]+)\/([\w.-]+?)(?::([^\s,)]+))?(?=$|[\s),.?!])/g;
const MAX_REPOS = 3;
const MAX_PATHS = 6;
const MAX_TREE = 300;
const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 60_000;

export function findRepoReferences(text) {
  const found = new Map();
  const add = (owner, repo, path) => {
    const key = `${owner}/${repo}`.toLowerCase();
    const entry = found.get(key) ?? { owner, repo, paths: new Set() };
    if (path) entry.paths.add(path.replace(/\/$/, ''));
    found.set(key, entry);
  };
  for (const match of String(text).matchAll(URL_REFERENCE)) add(match[1], match[2], match[3] ? decodeURIComponent(match[3]) : null);
  for (const match of String(text).matchAll(MENTION)) add(match[1], match[2], match[3]);
  return [...found.values()].slice(0, MAX_REPOS).map((entry) => ({ ...entry, paths: [...entry.paths].slice(0, MAX_PATHS) }));
}

/** @returns {Promise<null | { text: string, summary: object[] }>} */
export async function githubContextFor(text) {
  const references = findRepoReferences(text);
  if (!references.length) return null;
  const { token } = await currentToken();
  const sections = [];
  const summary = [];
  for (const reference of references) {
    try {
      const meta = await getRepo(reference.owner, reference.repo, token);
      let tree = { files: [] };
      try {
        tree = await getTree(meta, token);
      } catch (error) {
        if (error.code !== 'GITHUB_EMPTY_REPO') throw error;
      }
      const files = tree.files.filter((file) => !isNoise(file.path));
      const parts = [
        `## ${meta.fullName}${meta.private ? ' (private)' : ''}\nDefault branch: ${meta.defaultBranch}. Language: ${meta.language ?? 'unknown'}.${meta.description ? ` Description: ${meta.description}` : ''}`,
        `### Files (${files.length}${files.length > MAX_TREE ? `, the first ${MAX_TREE}` : ''})\n${files.slice(0, MAX_TREE).map((file) => file.path).join('\n')}`,
      ];
      const wanted = [];
      const readme = files.find((file) => /^readme(\.(md|markdown|txt|rst))?$/i.test(file.path));
      if (readme) wanted.push(readme);
      for (const path of reference.paths) {
        const exact = files.find((file) => file.path === path);
        if (exact) {
          if (!wanted.includes(exact)) wanted.push(exact);
          continue;
        }
        const inside = files.filter((file) => file.path.startsWith(`${path}/`));
        parts.push(inside.length ? `### Folder ${path}\n${inside.slice(0, 100).map((file) => file.path).join('\n')}` : `### ${path}\n(not found in the repository)`);
      }
      const included = [];
      for (const file of wanted) {
        if (file.size > 500_000) continue;
        const content = decodeText(await readRepoFile(meta, file.path, token));
        if (content === null) continue;
        const clipped = content.length > MAX_FILE_CHARS ? `${content.slice(0, MAX_FILE_CHARS)}\n… (truncated)` : content;
        parts.push(`### ${file.path}\n\`\`\`\n${clipped}\n\`\`\``);
        included.push(file.path);
      }
      sections.push(parts.join('\n\n'));
      summary.push({ fullName: meta.fullName, private: meta.private, files: files.length, included });
    } catch (error) {
      summary.push({ fullName: `${reference.owner}/${reference.repo}`, error: error.message });
      sections.push(`## ${reference.owner}/${reference.repo}\n(could not be read: ${error.code ?? 'error'})`);
    }
  }
  let context = sections.join('\n\n');
  if (context.length > MAX_TOTAL_CHARS) context = `${context.slice(0, MAX_TOTAL_CHARS)}\n… (context truncated)`;
  return { text: context, summary };
}
