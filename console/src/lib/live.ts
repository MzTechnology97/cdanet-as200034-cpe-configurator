import { useEffect } from 'react';
import { keys, queryClient } from './query';
import { deviceId } from './api';

/** What each event of the server refreshes (the page asks the API again, with its user's rights). */
const REFRESH: Record<string, ReadonlyArray<readonly string[]>> = {
  notifications: [keys.notifications],
  advisor: [keys.advisor],
  outages: [keys.outages, keys.network],
};

/**
 * Live updates (/api/events): read with fetch and the session's token (never in the address), one
 * stream at a time, opened again when the server closes it (every 15 minutes) or the network drops.
 * Each event refreshes the shared data. A server without /api/events: tried again every few minutes.
 */
export function useLiveEvents(token: string | null) {
  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const later = (ms: number) => {
      if (!stopped) timer = setTimeout(connect, ms);
    };

    async function connect() {
      ctrl = new AbortController();
      let wait = 5_000;
      try {
        const res = await fetch('/api/events', { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'X-CDA-Device': deviceId() }, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 404) wait = 5 * 60_000; // server not updated yet
        if (res.status === 401) return; // the session is over: the API calls handle it
        if (!res.ok || !res.body) return later(wait);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const topic = /^event: (.+)$/m.exec(block)?.[1]?.trim();
            if (!topic || topic === 'ready') continue;
            for (const k of REFRESH[topic] ?? []) void queryClient.invalidateQueries({ queryKey: k });
          }
        }
        wait = 1_000; // closed by the server: open the next one at once
      } catch {
        /* aborted or network down: try again */
      }
      later(wait);
    }

    void connect();
    return () => {
      stopped = true;
      ctrl?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [token]);
}
