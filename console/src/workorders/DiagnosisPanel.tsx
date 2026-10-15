import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { Badge, Button, Notice, Skeleton } from '../ui';

/**
 * «Diagnosi a distanza» of a line (a work order, a CPE or a PPPoE user): the probable cause, worst
 * first, with what to do, and the facts it comes from. Read again on request (it asks the network).
 */

type Level = 'bad' | 'warn' | 'info' | 'ok';
interface Finding {
  level: Level;
  code: string;
  title: string;
  detail: string;
  action: string;
}
interface Answer {
  at: string;
  verdict: string;
  findings: Finding[];
  subject: { customer: string; pppoeUser: string; mac: string | null; apName: string | null };
  facts: {
    cpe: { found: boolean; online: boolean | null; signal: number | null; ethMbps: number | null; outagesWeek: number | null } | null;
    signal: { acceptance: number | null; monthAvg: number | null; trend: number | null };
    pppoe: { status: string; online: boolean | null } | null;
    ap: { name: string; online: boolean; cpeTotal: number; cpeOffline: number } | null;
    power: { nearAp: { place: string } | null; nearCustomer: { place: string; distanceM: number } | null; popBattery: { soc: number | null; batteryState: string | null } | null };
  };
}
const TONE: Record<Level, 'bad' | 'warn' | 'neutral' | 'good'> = { bad: 'bad', warn: 'warn', info: 'neutral', ok: 'good' };
const LABEL: Record<Level, string> = { bad: 'causa probabile', warn: 'da verificare', info: 'nota', ok: 'regolare' };

export function DiagnosisPanel({ params, auto = true }: { params: Record<string, string>; auto?: boolean }) {
  const [asked, setAsked] = useState(auto);
  const key = new URLSearchParams(params).toString();
  const q = useQuery({ queryKey: ['diagnosis', key], queryFn: () => api<Answer>(`/api/admin/diagnosis?${key}`), enabled: asked, staleTime: 60_000, retry: false });
  if (!asked)
    return (
      <Button icon="troubleshoot" onClick={() => setAsked(true)}>
        Diagnosi a distanza
      </Button>
    );
  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  if (!q.data) return <Skeleton lines={3} />;
  const { findings, facts: f } = q.data;
  const facts = [
    f.cpe ? (f.cpe.found ? `CPE ${f.cpe.online ? 'in linea' : 'non raggiungibile'}${f.cpe.signal != null ? ` · ${f.cpe.signal} dBm` : ''}` : 'CPE non trovata') : null,
    f.signal.acceptance != null ? `al collaudo ${f.signal.acceptance} dBm` : null,
    f.signal.trend != null && f.signal.trend !== 0 ? `mese ${f.signal.trend > 0 ? '+' : ''}${f.signal.trend} dB` : null,
    f.ap ? `AP ${f.ap.name} ${f.ap.online ? 'in linea' : 'giù'} (${f.ap.cpeOffline}/${f.ap.cpeTotal} CPE offline)` : null,
    f.pppoe ? `PPPoE ${f.pppoe.online === true ? 'attivo' : f.pppoe.online === false ? 'non attivo' : '?'} · ${f.pppoe.status.toLowerCase()}` : null,
    f.cpe?.outagesWeek ? `${f.cpe.outagesWeek} interruzioni in 7 giorni` : null,
    f.power.nearAp ? `guasto Enel vicino al POP` : null,
    f.power.nearCustomer ? `guasto Enel a ${f.power.nearCustomer.distanceM} m dal cliente` : null,
  ].filter(Boolean);
  return (
    <div className="dg-panel">
      <ul className="dg-list">
        {findings.map((x) => (
          <li key={x.code} className={`dg-item ui-tone-${TONE[x.level]}`}>
            <div className="ui-row">
              <Badge tone={TONE[x.level]}>{LABEL[x.level]}</Badge>
              <strong>{x.title}</strong>
            </div>
            <div className="ui-small">{x.detail}</div>
            <div className="ui-small dg-action">→ {x.action}</div>
          </li>
        ))}
      </ul>
      <p className="ui-muted ui-small">
        {facts.join(' · ')} · letta alle {new Date(q.data.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}{' '}
        <button type="button" className="ui-link" onClick={() => void q.refetch()}>
          rileggi
        </button>
      </p>
    </div>
  );
}
