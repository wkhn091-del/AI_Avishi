import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../../lib/api.js';

const repoPath = (repo) => `${encodeURIComponent(repo.github.owner)}/${encodeURIComponent(repo.github.name)}`;

/**
 * State and actions for the GitHub tab and the Settings dialog: the
 * connection (token), your repositories and their analyses. An analysis runs
 * on demand (opening an unanalysed repository starts one) and is saved on the server.
 */
export function useGithub({ enabled = true } = {}) {
  const [connection, setConnection] = useState({ status: 'loading', data: null, error: null });
  const [repos, setRepos] = useState([]);
  const [reposStatus, setReposStatus] = useState('idle'); // idle | loading | ready | error
  const [reposError, setReposError] = useState(null);
  const [analyses, setAnalyses] = useState({}); // repo id → { status: 'running' | 'error', error? }
  const reposRef = useRef(repos);

  useEffect(() => {
    if (!enabled) return undefined;
    reposRef.current = repos;
  }, [repos]);

  const loadRepos = useCallback(async () => {
    setReposStatus((current) => (current === 'ready' ? current : 'loading'));
    try {
      const { repos: list } = await request('/github/repos');
      setRepos(list);
      setReposError(null);
      setReposStatus('ready');
    } catch (error) {
      setReposError(error.message);
      setReposStatus('error');
    }
  }, []);

  const apply = useCallback(
    (data) => {
      setConnection({ status: 'ready', data, error: null });
      if (data.connected) loadRepos();
      else {
        setRepos([]);
        setReposStatus('idle');
      }
      return data;
    },
    [loadRepos],
  );

  const reload = useCallback(
    async ({ fresh = true } = {}) => {
      try {
        const { github } = await request(`/github/status${fresh ? '?fresh=1' : ''}`);
        apply(github);
      } catch (error) {
        setConnection({ status: 'error', data: null, error: error.message });
      }
    },
    [apply],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    reload({ fresh: false });
  }, [reload]);

  const saveToken = useCallback(async (token) => apply((await request('/github/token', { method: 'PUT', body: { token } })).github), [apply]);
  const removeToken = useCallback(async () => apply((await request('/github/token', { method: 'DELETE' })).github), [apply]);

  const replace = (updated) => setRepos((list) => list.map((item) => (item.id === updated.id ? updated : item)));

  /** Analyses a repository (Hebrew summary); throws with a Hebrew message on failure. */
  const analyze = useCallback(async (id) => {
    const repo = reposRef.current.find((item) => item.id === id);
    if (!repo) return null;
    setAnalyses((current) => ({ ...current, [id]: { status: 'running' } }));
    try {
      const { repo: updated } = await request(`/github/analyze/${repoPath(repo)}`, { method: 'POST' });
      replace(updated);
      setAnalyses(({ [id]: _finished, ...rest }) => rest);
      return updated;
    } catch (error) {
      setAnalyses((current) => ({ ...current, [id]: { status: 'error', error: error.message } }));
      throw error;
    }
  }, []);

  const update = useCallback(async (id, changes) => {
    const repo = reposRef.current.find((item) => item.id === id);
    const { repo: updated } = await request(`/github/repos/${repoPath(repo)}`, { method: 'PATCH', body: changes });
    replace(updated);
    return updated;
  }, []);

  return {
    connection,
    repos,
    reposStatus,
    reposError,
    analyses,
    reload,
    loadRepos,
    saveToken,
    removeToken,
    analyze,
    reanalyze: analyze,
    update,
  };
}
