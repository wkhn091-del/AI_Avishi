import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../components/ui/Toaster.jsx';
import { request, uploadWithProgress } from '../../lib/api.js';
import { formatBytes, quote } from '../../lib/format.js';
import { nextClientId } from '../../lib/ids.js';
import { createTaskQueue } from '../../lib/taskQueue.js';

/**
 * State and actions for the Files section. Each file uploads in its own
 * request (three at a time) so it gets its own progress bar, and one failure
 * doesn't sink the rest of the batch.
 *
 * @param {{ fileBytes: number } | null} limits From /api/health
 */
export function useFiles(limits, { enabled = true } = {}) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [queue] = useState(() => createTaskQueue(3));

  const load = useCallback(async (signal) => {
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    try {
      const data = await request('/files', { signal });
      setFiles(data.files);
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

  const patchUpload = useCallback(
    (tempId, patch) => setUploads((list) => list.map((item) => (item.tempId === tempId ? { ...item, ...patch } : item))),
    [],
  );

  const add = useCallback(
    (input) => {
      const accepted = Array.from(input).filter((file) => {
        if (!limits || file.size <= limits.fileBytes) return true;
        toast.error(`הקובץ ${quote(file.name)} גדול מהמגבלה של ${formatBytes(limits.fileBytes)}.`);
        return false;
      });
      if (!accepted.length) return;

      const batch = accepted.map((file) => ({ tempId: nextClientId('file'), file }));
      setUploads((list) => [
        ...batch.map(({ tempId, file }) => ({ tempId, name: file.name, size: file.size, progress: 0, state: 'queued' })).reverse(),
        ...list,
      ]);

      const tasks = batch.map(({ tempId, file }) =>
        queue.push(async () => {
          patchUpload(tempId, { state: 'uploading' });
          const form = new FormData();
          form.append('files', file, file.name);
          try {
            const { files: saved } = await uploadWithProgress('/files', form, {
              onProgress: (fraction) => patchUpload(tempId, { progress: fraction }),
            });
            setUploads((list) => list.filter((item) => item.tempId !== tempId));
            setFiles((list) => [{ ...saved[0], clientKey: tempId }, ...list]);
            return saved[0].originalName;
          } catch (uploadError) {
            setUploads((list) => list.filter((item) => item.tempId !== tempId));
            toast.error(`הקובץ ${quote(file.name)} לא הועלה. ${uploadError.message}`);
            return null;
          }
        }),
      );

      // One confirmation per batch rather than one per file.
      Promise.all(tasks).then((names) => {
        const done = names.filter(Boolean);
        if (done.length === 1) toast.success(`הקובץ ${quote(done[0])} הועלה`);
        if (done.length > 1) toast.success(`${done.length} קבצים הועלו`);
      });
    },
    [limits, queue, patchUpload, toast],
  );

  const remove = useCallback(async (id) => {
    await request(`/files/${id}`, { method: 'DELETE' });
    setFiles((list) => list.filter((item) => item.id !== id));
  }, []);

  return { items: files, uploads, status, error, reload: load, add, remove };
}
