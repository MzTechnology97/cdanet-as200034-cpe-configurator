import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Badge, Skeleton, Table } from '../ui';

/**
 * The speedtests of a CPE (by installation or MAC): every attempt the app made over the customer's
 * Wi-Fi, against the profile of the customer, with the Wi-Fi it ran on. In the acceptance test, in
 * interventions on installed CPEs and from the network tools.
 */

interface SpeedTest {
  id: number;
  at: string;
  context: 'acceptance' | 'work_order' | 'cpe' | 'tool';
  downMbps: number | null;
  upMbps: number | null;
  pingMs: number | null;
  jitterMs: number | null;
  wifi: { rssi?: number; band?: string; channel?: number; widthMhz?: number; linkMbps?: number; neighborsSameChannel?: number };
  target: { profile: string; downMbps: number; upMbps: number; minPct: number } | null;
  passed: boolean | null;
  attempt: number;
  username: string | null;
}
const CONTEXT: Record<string, string> = { acceptance: 'collaudo', work_order: 'intervento', cpe: 'CPE installata', tool: 'strumento' };
const when = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
const n = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toLocaleString('it-IT', { maximumFractionDigits: d }));

export function SpeedTests({ jobId, mac }: { jobId?: string; mac?: string | null }) {
  const qs = jobId ? `jobId=${jobId}` : `mac=${encodeURIComponent(mac ?? '')}`;
  const q = useQuery({ queryKey: ['speedtests', qs], queryFn: () => api<{ items: SpeedTest[] }>(`/api/speedtests?${qs}`), enabled: !!(jobId || mac), retry: false });
  if (q.error) return <p className="ui-muted ui-small">Speedtest non disponibili: {(q.error as Error).message}</p>;
  if (!q.data) return <Skeleton lines={2} />;
  if (!q.data.items.length) return <p className="ui-muted ui-small">Nessuno speedtest: l’app lo fa dalla Wi-Fi del router del cliente, nel collaudo, negli interventi e tra gli strumenti di rete.</p>;
  return (
    <Table
      rows={q.data.items}
      rowKey={(t) => t.id}
      columns={[
        { label: 'Quando', render: (t) => <span className="ui-small">{when(t.at)}</span> },
        {
          label: 'Velocità',
          render: (t) => (
            <span>
              <strong>{n(t.downMbps)}</strong> ↓ · <strong>{n(t.upMbps)}</strong> ↑ Mbit/s
              <span className="ui-muted ui-small"> · ping {n(t.pingMs, 0)} ms</span>
            </span>
          ),
        },
        {
          label: 'Profilo',
          render: (t) =>
            t.target ? (
              <span className="ui-small">
                {t.target.downMbps}/{t.target.upMbps} · {t.passed ? <Badge tone="good">ok</Badge> : <Badge tone="warn">sotto soglia ({t.target.minPct}%)</Badge>}
              </span>
            ) : (
              <span className="ui-muted ui-small">non noto</span>
            ),
        },
        {
          label: 'Wi-Fi',
          render: (t) => (
            <span className="ui-small">
              {[t.wifi.rssi != null ? `${t.wifi.rssi} dBm` : null, t.wifi.band ? `${t.wifi.band} GHz` : null, t.wifi.channel ? `can. ${t.wifi.channel}` : null, t.wifi.widthMhz ? `${t.wifi.widthMhz} MHz` : null].filter(Boolean).join(' · ') || '—'}
            </span>
          ),
        },
        { label: 'Dove', render: (t) => <span className="ui-small">{CONTEXT[t.context] ?? t.context}{t.attempt > 1 ? ` · tentativo ${t.attempt}` : ''}{t.username ? ` · ${t.username}` : ''}</span> },
      ]}
    />
  );
}
