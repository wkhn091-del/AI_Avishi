/**
 * Data for the project workspace, from any source (see sources.js): the file
 * tree, file content, the preview plan and AI explanations. Requests are
 * cancelled when the component that made them unmounts or asks for something else.
 */
import { useEffect, useState } from 'react';
import { request, requestText } from '../../../lib/api.js';

/**
 * Runs `load` for `key` (null = idle). `cached` renders immediately, with no
 * loading flash, when the value is already known.
 */
function useLoad(key, load, cached = null) {
  const [state, setState] = useState(() =>
    cached ? { status: 'ready', data: cached, error: null } : { status: key ? 'loading' : 'idle', data: null, error: null },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!key || (cached && attempt === 0)) return undefined;
    const controller = new AbortController();
    setState({ status: 'loading', data: null, error: null });
    load(controller.signal).then(
      (data) => setState({ status: 'ready', data, error: null }),
      (error) => {
        if (error.name !== 'AbortError') setState({ status: 'error', data: null, error });
      },
    );
    return () => controller.abort();
    // `load` is a new function on every render; `key` says what it loads.
  }, [key, attempt]);

  return { ...state, retry: () => setAttempt((count) => count + 1) };
}

/** @param {ReturnType<import('./sources.js').sourceOf>} source */
export function useProjectTree(source) {
  return useLoad(`tree:${source.key}`, (signal) => request(source.tree, { signal }));
}

export function usePreviewPlan(source) {
  return useLoad(`preview:${source.key}`, (signal) => request(source.preview, { signal }).then((body) => body.preview));
}

const contents = new Map(); // "sourceKey:path" → { text, size }, oldest first
const MAX_CACHED_FILES = 40;

/** Text of one file. `enabled` = false for files without a text view (images). */
export function useFileContent(source, filePath, enabled = true) {
  const key = enabled && filePath ? `${source.key}:${filePath}` : null;
  return useLoad(
    key,
    async (signal) => {
      const result = await requestText(source.content(filePath), { signal });
      contents.set(key, result);
      if (contents.size > MAX_CACHED_FILES) contents.delete(contents.keys().next().value);
      return result;
    },
    key ? contents.get(key) : null,
  );
}

const explanations = new Map();

/** Hebrew AI explanation of one file. The server caches it; `refresh` asks the model again. */
export async function explainFile(source, filePath, refresh = false) {
  const { explanation } = await request(source.explain, { method: 'POST', body: { path: filePath, refresh } });
  explanations.set(`${source.key}:${filePath}`, explanation);
  return explanation;
}

/** An explanation already fetched in this session, so reopening a file shows it again. */
export const knownExplanation = (source, filePath) => explanations.get(`${source.key}:${filePath}`) ?? null;
