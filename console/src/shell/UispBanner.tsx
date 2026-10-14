import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Icon } from '../ui';

/**
 * Admins: when UISP does not answer, or the network data the pages show is older than a few
 * minutes, one line over every page says so (the server keeps serving its last copy, so the pages
 * still work). Nothing is shown while UISP answers.
 */
interface Health {
  configured: boolean;
  online?: boolean;
  dataAt?: string | null;
  lastError?: string | null;
}

const STALE_MS = 5 * 60_000;

/** "3 minuti fa", "2 ore fa", "ieri alle 18:40". */
export function ago(iso: string, now = Date.now()) {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'meno di un minuto fa';
  if (min < 60) return `${min} ${min === 1 ? 'minuto' : 'minuti'} fa`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${h === 1 ? 'ora' : 'ore'} fa`;
  return `del ${new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}`;
}

/** Whether data read at [dataAt] is older than what a page should show without a word. */
export const isStale = (dataAt?: string | null, now = Date.now()) => !!dataAt && now - new Date(dataAt).getTime() > STALE_MS;

export function UispBanner() {
  const q = useQuery({ queryKey: ['uisp', 'health'], queryFn: () => api<Health>('/api/uisp/health'), refetchInterval: 60_000, retry: false });
  const h = q.data;
  if (!h?.configured) return null;
  const stale = isStale(h.dataAt);
  if (h.online !== false && !stale) return null;
  const age = h.dataAt ? `Dati UISP ${ago(h.dataAt)}` : 'Nessun dato UISP ancora letto';
  return (
    <div className="cx-banner ui-tone-warn" role="status">
      <Icon name="warning_filled" />
      <span>
        <strong>{h.online === false ? 'UISP non risponde' : 'UISP lento'}</strong> · {age}: le pagine mostrano l’ultima copia.
        {h.lastError && <span className="cx-banner-detail"> {h.lastError}</span>}
      </span>
      <a href="#/connectors">Connettori</a>
    </div>
  );
}
