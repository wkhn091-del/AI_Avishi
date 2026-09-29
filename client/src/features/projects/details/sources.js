/**
 * Where a workspace reads its files: a stored ZIP archive or a GitHub
 * repository. Both expose the same routes (tree, content, explain, preview,
 * raw bytes), so the explorer, code viewer and preview don't care which.
 */
import { resourceUrl } from '../../../lib/api.js';
export const encodePath = (filePath) => filePath.split('/').map(encodeURIComponent).join('/');

export function sourceOf(project) {
  if (project.source === 'github') {
    const { owner, name } = project.github;
    const base = `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    return {
      key: `gh:${project.id}`,
      kind: 'github',
      tree: `${base}/files`,
      content: (filePath) => `${base}/files/content?path=${encodeURIComponent(filePath)}`,
      explain: `${base}/files/explain`,
      preview: `${base}/preview`,
      raw: (filePath, { download = false } = {}) => resourceUrl(`/api${base}/raw/${encodePath(filePath)}${download ? '?download=1' : ''}`),
      hash: `#github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    };
  }
  const base = `/projects/${encodeURIComponent(project.id)}`;
  return {
    key: project.id,
    kind: 'zip',
    tree: `${base}/files`,
    content: (filePath) => `${base}/files/content?path=${encodeURIComponent(filePath)}`,
    explain: `${base}/files/explain`,
    preview: `${base}/preview`,
    raw: (filePath, { download = false } = {}) => resourceUrl(`/api${base}/serve/${encodePath(filePath)}${download ? '?download=1' : ''}`),
    hash: `#projects/${encodeURIComponent(project.id)}`,
  };
}

/** Link that opens this project or repository (what Share copies). */
export const shareLink = (project) => `${window.location.origin}${window.location.pathname}${sourceOf(project).hash}`;
