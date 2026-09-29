import { useCallback, useEffect, useState } from 'react';
import { request } from '../../lib/api.js';
import { useCredits } from '../credits/CreditsProvider.jsx';

/**
 * The media studio: options (models, voices, sizes), everything generated so
 * far, and the generations in progress (one per tab). Lives in the Dashboard,
 * so a long video render continues while another tab is open.
 */
export function useMedia() {
  const credits = useCredits();
  const [options, setOptions] = useState({ status: 'loading', data: null, error: null });
  const [items, setItems] = useState({ status: 'loading', list: [], error: null });
  const [jobs, setJobs] = useState({});

  const load = useCallback(async () => {
    setOptions((current) => ({ ...current, status: current.data ? 'ready' : 'loading' }));
    try {
      setOptions({ status: 'ready', data: await request('/media/options'), error: null });
    } catch (error) {
      setOptions({ status: 'error', data: null, error: error.message });
    }
    try {
      const { media } = await request('/media');
      setItems({ status: 'ready', list: media, error: null });
    } catch (error) {
      setItems({ status: 'error', list: [], error: error.message });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Generates one item; throws ApiError (Hebrew message, provider text in details.detail). */
  const generate = useCallback(async (tab, body) => {
    setJobs((current) => ({ ...current, [tab]: { started: Date.now(), kind: body.kind } }));
    try {
      const { media, credits: balance } = await request('/media/generate', { method: 'POST', body });
      credits.update(balance);
      setItems((current) => ({ ...current, list: [media, ...current.list] }));
      return media;
    } catch (error) {
      credits.handleError(error); // a 402 opens the upgrade dialog; the studio still shows the error
      throw error;
    } finally {
      setJobs(({ [tab]: _finished, ...rest }) => rest);
    }
  }, [credits]);

  const remove = useCallback(async (id) => {
    await request(`/media/${id}`, { method: 'DELETE' });
    setItems((current) => ({ ...current, list: current.list.filter((item) => item.id !== id) }));
  }, []);

  return { options, items, jobs, generate, remove, reload: load };
}
