import { useEffect, useState } from 'react';
import type { AgentEvent } from '../shared/events';
import type { MatrixStore } from './store';

export type CollectorStatus = 'connecting' | 'live' | 'offline' | 'locked';

// Per-tab on purpose: localStorage would be readable by any other dev server
// that later runs on this same localhost port.
const TOKEN_KEY = 'agentmatrix.token';

/** Move a token from the access link's #fragment into this tab's storage. */
function currentToken(): string | null {
  try {
    const match = location.hash.match(/(?:^#|&)token=([a-f0-9]{64})(?:&|$)/);
    if (match) {
      sessionStorage.setItem(TOKEN_KEY, match[1]);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Reads a Server-Sent Events body. EventSource can't send an Authorization header. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (name: string, data: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let name = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) onEvent(name, data.join('\n'));
    }
  }
}

/**
 * Subscribes to the local collector's event stream.
 * On every (re)connect the collector sends a snapshot of its in-memory buffer,
 * which we replay without animation after dropping previously-seen live lanes.
 */
export function useCollector(store: MatrixStore): CollectorStatus {
  const [status, setStatus] = useState<CollectorStatus>('connecting');
  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;

    const onEvent = (name: string, data: string) => {
      try {
        if (name === 'snapshot') {
          setStatus('live');
          const events = JSON.parse(data) as AgentEvent[];
          store.clear((l) => !l.mock);
          store.ingest(events, { replay: true });
        } else if (name === 'events') {
          store.ingest(JSON.parse(data) as AgentEvent[]);
        } else if (name === 'cleared') {
          store.clear((l) => !l.mock);
        }
      } catch {
        /* ignore malformed */
      }
    };

    const connect = async () => {
      if (closed) return;
      const token = currentToken();
      if (!token) return setStatus('locked');
      abort = new AbortController();
      const mine = abort;
      try {
        const res = await fetch('/api/stream', { headers: { authorization: `Bearer ${token}` }, signal: mine.signal });
        if (res.status === 401) return setStatus('locked');
        if (!res.ok || !res.body) throw new Error('stream unavailable');
        await readEvents(res.body, onEvent);
      } catch {
        if (mine.signal.aborted) return;
      }
      if (closed || mine.signal.aborted) return;
      // Back off quietly; the UI works fine offline with mock data.
      setStatus('offline');
      retry = setTimeout(connect, 3000);
    };

    // Opening the access link in an already-open tab only changes the hash.
    const onHash = () => {
      if (!location.hash.includes('token=')) return;
      abort?.abort();
      if (retry) clearTimeout(retry);
      setStatus('connecting');
      void connect();
    };
    window.addEventListener('hashchange', onHash);
    void connect();
    return () => {
      closed = true;
      window.removeEventListener('hashchange', onHash);
      abort?.abort();
      if (retry) clearTimeout(retry);
    };
  }, [store]);
  return status;
}

export async function clearCollector() {
  const token = currentToken();
  if (!token) return;
  try {
    await fetch('/api/events', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  } catch {
    /* collector offline: nothing to clear */
  }
}
