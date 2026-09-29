import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/ui/Toaster.jsx';
import { request, uploadWithProgress } from '../../lib/api.js';
import { formatBytes, quote } from '../../lib/format.js';
import { nextClientId } from '../../lib/ids.js';
import { createTaskQueue } from '../../lib/taskQueue.js';

/**
 * State and actions for the Projects section.
 *
 * Archives upload one at a time (each is analysed on the server). Every file
 * shows up immediately as a pending card — Queued → Uploading n% → Analyzing —
 * and the finished project takes over the same grid slot (it inherits the
 * pending card's key), so the card transforms in place instead of jumping.
 *
 * @param {{ archiveBytes: number } | null} limits From /api/health, for checks before uploading
 */
export function useProjects(limits, { enabled = true } = {}) {
  const toast = useToast();
  const [projects, setProjects] = useState([]);
  const [pending, setPending] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [queue] = useState(() => createTaskQueue(1));
  const files = useRef(new Map()); // tempId → File, kept for "Try again"

  const load = useCallback(async (signal) => {
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    try {
      const data = await request('/projects', { signal });
      setProjects(data.projects);
      setError(null);
      setStatus('ready');
    } catch (loadError) {
      if (loadError.name === 'AbortError') return;
      setError(loadError.message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const patchPending = useCallback(
    (tempId, patch) => setPending((list) => list.map((item) => (item.tempId === tempId ? { ...item, ...patch } : item))),
    [],
  );

  const upload = useCallback(
    (tempId) =>
      queue.push(async () => {
        const file = files.current.get(tempId);
        if (!file) return; // dismissed while queued
        patchPending(tempId, { state: 'uploading', progress: 0, error: null });

        const form = new FormData();
        form.append('archive', file, file.name);
        try {
          const { project } = await uploadWithProgress('/projects', form, {
            onProgress: (fraction) =>
              patchPending(tempId, fraction >= 1 ? { state: 'analyzing', progress: 1 } : { progress: fraction }),
          });
          files.current.delete(tempId);
          setPending((list) => list.filter((item) => item.tempId !== tempId));
          setProjects((list) => [{ ...project, clientKey: tempId }, ...list]);
          toast.success(`הפרויקט ${quote(project.title)} נוסף`);
        } catch (uploadError) {
          patchPending(tempId, { state: 'error', error: uploadError.message });
        }
      }),
    [queue, patchPending, toast],
  );

  /** Queue .zip files for upload; anything else is refused with a pointer to Files. */
  const addArchives = useCallback(
    (input) => {
      const all = Array.from(input);
      const archives = all.filter((file) => file.name.toLowerCase().endsWith('.zip'));
      const others = all.filter((file) => !archives.includes(file));
      if (others.length === 1) toast.error(`הקובץ ${quote(others[0].name)} אינו ארכיון ZIP. אפשר להעלות אותו באזור הקבצים.`);
      if (others.length > 1) toast.error(`${others.length} קבצים אינם ארכיוני ZIP. אפשר להעלות אותם באזור הקבצים.`);

      const accepted = archives.filter((file) => {
        if (!limits || file.size <= limits.archiveBytes) return true;
        toast.error(`הקובץ ${quote(file.name)} גדול מהמגבלה של ${formatBytes(limits.archiveBytes)}.`);
        return false;
      });
      if (!accepted.length) return;

      const items = accepted.map((file) => {
        const tempId = nextClientId('project');
        files.current.set(tempId, file);
        return { tempId, name: file.name, size: file.size, state: 'queued', progress: 0, error: null };
      });
      // Newest batch first, in the order the cards will end up once finished.
      setPending((list) => [...[...items].reverse(), ...list]);
      items.forEach((item) => upload(item.tempId));
    },
    [limits, toast, upload],
  );

  const retry = useCallback(
    (tempId) => {
      patchPending(tempId, { state: 'queued', progress: 0, error: null });
      upload(tempId);
    },
    [patchPending, upload],
  );

  const dismiss = useCallback((tempId) => {
    files.current.delete(tempId);
    setPending((list) => list.filter((item) => item.tempId !== tempId));
  }, []);

  const replace = useCallback(
    (project) => setProjects((list) => list.map((item) => (item.id === project.id ? { ...project, clientKey: item.clientKey } : item))),
    [],
  );

  const update = useCallback(
    async (id, changes) => {
      const { project } = await request(`/projects/${id}`, { method: 'PATCH', body: changes });
      replace(project);
      return project;
    },
    [replace],
  );

  const reanalyze = useCallback(
    async (id) => {
      const { project } = await request(`/projects/${id}/reanalyze`, { method: 'POST' });
      replace(project);
      return project;
    },
    [replace],
  );

  const remove = useCallback(async (id) => {
    await request(`/projects/${id}`, { method: 'DELETE' });
    setProjects((list) => list.filter((item) => item.id !== id));
  }, []);

  return {
    items: projects,
    pending,
    status,
    error,
    busy: pending.some((item) => item.state !== 'error'),
    reload: load,
    addArchives,
    retry,
    dismiss,
    update,
    reanalyze,
    remove,
  };
}
