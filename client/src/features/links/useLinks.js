import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../components/ui/Toaster.jsx';
import { request } from '../../lib/api.js';
import { quote } from '../../lib/format.js';
import { nextClientId } from '../../lib/ids.js';

const shorten = (text, max = 60) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * State and actions for the Links section. While a link's preview is being
 * fetched it shows as a placeholder card that becomes the real card in place.
 */
export function useLinks({ enabled = true } = {}) {
  const toast = useToast();
  const [links, setLinks] = useState([]);
  const [saving, setSaving] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);

  const load = useCallback(async (signal) => {
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    try {
      const data = await request('/links', { signal });
      setLinks(data.links);
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

  /**
   * Saves a link and fetches its preview.
   * @returns {Promise<{ ok: boolean, duplicateId?: string, invalid?: boolean }>}
   */
  const add = useCallback(
    async (url) => {
      const tempId = nextClientId('link');
      setSaving((list) => [{ tempId, url }, ...list]);
      try {
        const { link } = await request('/links', { method: 'POST', body: { url } });
        setLinks((list) => [{ ...link, clientKey: tempId }, ...list]);
        toast.success(`הקישור ${quote(shorten(link.title ?? link.domain))} נשמר`);
        return { ok: true };
      } catch (saveError) {
        if (saveError.code === 'DUPLICATE') {
          toast.info('הקישור הזה כבר שמור.');
          return { ok: false, duplicateId: saveError.details?.id };
        }
        toast.error(saveError.message);
        return { ok: false, invalid: saveError.status === 400 };
      } finally {
        setSaving((list) => list.filter((item) => item.tempId !== tempId));
      }
    },
    [toast],
  );

  const refresh = useCallback(async (id) => {
    const { link } = await request(`/links/${id}/refresh`, { method: 'POST' });
    setLinks((list) => list.map((item) => (item.id === id ? { ...link, clientKey: item.clientKey } : item)));
    return link;
  }, []);

  const remove = useCallback(async (id) => {
    await request(`/links/${id}`, { method: 'DELETE' });
    setLinks((list) => list.filter((item) => item.id !== id));
  }, []);

  return { items: links, saving, status, error, reload: load, add, refresh, remove };
}
