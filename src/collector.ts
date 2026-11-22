import { useEffect, useState } from 'react';
import type { AgentEvent } from '../shared/events';
import type { MatrixStore } from './store';

export type CollectorStatus = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to the local collector's Server-Sent Events stream.
 * On every (re)connect the collector sends a snapshot of its in-memory buffer,
 * which we replay without animation after dropping previously-seen live lanes.
 */
export function useCollector(store: MatrixStore): CollectorStatus {
  const [status, setStatus] = useState<CollectorStatus>('connecting');
  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/stream');
      es.addEventListener('snapshot', (m) => {
        setStatus('live');
        try {
          const events = JSON.parse((m as MessageEvent).data) as AgentEvent[];
          store.clear((l) => !l.mock);
          store.ingest(events, { replay: true });
        } catch {
          /* ignore malformed */
        }
      });
      es.addEventListener('events', (m) => {
        try {
          store.ingest(JSON.parse((m as MessageEvent).data) as AgentEvent[]);
        } catch {
          /* ignore malformed */
        }
      });
      es.addEventListener('cleared', () => store.clear((l) => !l.mock));
      es.onerror = () => {
        setStatus('offline');
        es?.close();
        // Back off quietly; the UI works fine offline with mock data.
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [store]);
  return status;
}

export async function clearCollector() {
  try {
    await fetch('/api/events', { method: 'DELETE' });
  } catch {
    /* collector offline: nothing to clear */
  }
}
