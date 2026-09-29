/** Repositories, trees and files from the GitHub API. */
import { githubRequest } from './githubClient.js';

const MAX_PAGES = 3; // up to 300 repositories
const TREE_TTL_MS = 60_000;
const trees = new Map(); // "owner/name@ref" → { at, tree }
const enc = encodeURIComponent;
const repoPath = (owner, name) => `/repos/${enc(owner)}/${enc(name)}`;

/** The fields the app uses, from a GitHub repository object. */
export function toRepoMeta(repo) {
  return {
    fullName: repo.full_name,
    owner: repo.owner?.login,
    name: repo.name,
    description: repo.description ?? '',
    homepage: repo.homepage || null,
    htmlUrl: repo.html_url,
    private: Boolean(repo.private),
    fork: Boolean(repo.fork),
    archived: Boolean(repo.archived),
    language: repo.language ?? null,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    topics: repo.topics ?? [],
    defaultBranch: repo.default_branch,
    pushedAt: repo.pushed_at,
    hasPages: Boolean(repo.has_pages),
  };
}

/** The authenticated user's repositories (owned, collaborating, and their organisations'), most recently pushed first. */
export async function listRepos(token) {
  const repos = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data } = await githubRequest(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, { token });
    repos.push(...data.map(toRepoMeta));
    if (data.length < 100) break;
  }
  return repos;
}

export async function getRepo(owner, name, token) {
  const { data } = await githubRequest(repoPath(owner, name), { token });
  return toRepoMeta(data);
}

/** Every file of a branch: [{ path, size, sha }] (blobs only; submodules skipped). Cached for a minute. */
export async function getTree(meta, token) {
  const key = `${meta.fullName.toLowerCase()}@${meta.defaultBranch}`;
  const cached = trees.get(key);
  if (cached && Date.now() - cached.at < TREE_TTL_MS) return cached.tree;
  const { data } = await githubRequest(`${repoPath(meta.owner, meta.name)}/git/trees/${enc(meta.defaultBranch)}?recursive=1`, { token });
  const tree = {
    sha: data.sha,
    truncated: Boolean(data.truncated),
    files: data.tree.filter((item) => item.type === 'blob').map((item) => ({ path: item.path, size: item.size ?? 0, sha: item.sha })),
  };
  trees.set(key, { at: Date.now(), tree });
  return tree;
}

/** Raw bytes of one file on the default branch. */
export async function readRepoFile(meta, filePath, token) {
  const encoded = filePath.split('/').map(enc).join('/');
  const { data } = await githubRequest(`${repoPath(meta.owner, meta.name)}/contents/${encoded}?ref=${enc(meta.defaultBranch)}`, { token, raw: true });
  return data;
}

/** GitHub Pages address, or null when the repository has no Pages site (or the token can't see it). */
export async function getPagesUrl(meta, token) {
  if (!meta.hasPages) return null;
  try {
    const { data } = await githubRequest(`${repoPath(meta.owner, meta.name)}/pages`, { token });
    return data.html_url ?? null;
  } catch (error) {
    if (error.status === 404 || error.status === 403) return null;
    throw error;
  }
}
