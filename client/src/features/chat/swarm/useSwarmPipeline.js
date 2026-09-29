/**
 * The live state of a development-team run, for its dashboard. While the answer is being written,
 * `pipeline` is `{ runId, live: true }`, and the hook listens to the run's Server-Sent Events
 * (GET /api/chat/runs/:id/events, signed in by the session cookie): its whole state first, then patches,
 * then `end`. EventSource reconnects by itself, and every connection starts with the whole state again,
 * so nothing is missed. Once the answer is saved, `pipeline` is the run's final state, and nothing is opened.
 */
import { useEffect, useState } from 'react';
import { applyPatches } from './pipelineState.js';
import { resourceUrl } from '../../../lib/api.js';

export function useSwarmPipeline(pipeline) {
  const saved = pipeline?.version ? pipeline : null;
  const runId = saved ? null : (pipeline?.runId ?? null);
  const [live, setLive] = useState(null);
  const [connection, setConnection] = useState('connecting');
  useEffect(() => {
    if (!runId || typeof EventSource === 'undefined') return undefined;
    setConnection('connecting');
    const source = new EventSource(resourceUrl(`/api/chat/runs/${encodeURIComponent(runId)}/events`));
    source.addEventListener('snapshot', (event) => {
      setLive(JSON.parse(event.data));
      setConnection('live');
    });
    source.addEventListener('patch', (event) => {
      const patches = JSON.parse(event.data);
      setLive((current) => (current ? applyPatches(current, patches) : current));
    });
    source.addEventListener('end', () => {
      setConnection('closed');
      source.close();
    });
    // Closed: the run is gone (the answer's saved state takes over). Otherwise EventSource tries again.
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    return () => source.close();
  }, [runId]);
  return { state: saved ?? live, connection: saved ? 'closed' : connection };
}
