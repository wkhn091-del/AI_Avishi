import { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api.js';

/**
 * Server health, AI status and upload limits. While the server is
 * unreachable it re-checks every 5 seconds, so the UI recovers on its own
 * once the server starts.
 */
export function useHealth() {
  const [health, setHealth] = useState({ status: 'loading', ai: null, media: null, limits: null, error: null });

  const check = useCallback(async () => {
    try {
      const data = await request('/health');
      setHealth({ status: 'ok', ai: data.ai, media: data.media ?? null, limits: data.limits, error: null });
    } catch (error) {
      setHealth((current) => ({ ...current, status: 'error', error: error.message }));
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    if (health.status !== 'error') return undefined;
    const timer = setInterval(check, 5_000);
    return () => clearInterval(timer);
  }, [health.status, check]);

  return health;
}
