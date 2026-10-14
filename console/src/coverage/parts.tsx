import type { ReactNode } from 'react';
import { Badge } from '../ui';

/** What both Copertura pages (installers and admins) show the same way: the AP, its estimate, its load. */

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
export const km = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);
export const dec = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');

export const RATING: Record<string, [string, Tone]> = { buono: ['buono', 'good'], possibile: ['possibile', 'warn'], 'senza stima': ['senza stima', 'neutral'], improbabile: ['improbabile', 'bad'], 'non attivo': ['non attivo', 'bad'] };
export const CONF: Record<string, Tone> = { alta: 'good', media: 'warn', bassa: 'neutral' };
export const LOAD: Record<string, [string, Tone]> = { libero: ['libero la sera', 'good'], medio: ['medio la sera', 'warn'], carico: ['carico la sera', 'bad'] };

export interface Terrain {
  verdict: 'clear' | 'fresnel' | 'blocked';
  lossDb: number;
  foliageDb?: number;
  foliageM?: number;
  buildings?: boolean;
}
export interface Estimate {
  signalDbm: number | null;
  low?: number;
  high?: number;
  confidence?: string;
  inSector?: boolean;
  beyondServed?: boolean;
  tooFar?: boolean;
  terrain?: Terrain;
  capacityMbps?: number | null;
  eveningMbps?: number | null;
  theoretical?: boolean;
  basis?: number | null;
  nearby?: number;
}
export interface Load {
  level?: 'libero' | 'medio' | 'carico';
  eveningAirtimePct?: number | null;
  eveningUtilizationPct?: number | null;
  eveningPeakMbps?: number | null;
  capacityMbps?: number | null;
  stations?: number | null;
  cpeAirtimePct?: number | null;
  snrDb?: number | null;
  noiseDbm?: number | null;
}
export interface Ap {
  id: string;
  name: string;
  ssid?: string | null;
  siteName?: string | null;
  distanceM: number;
  bearing: number;
  direction: string;
  status: string;
  rating?: string;
  failures?: number;
  stations?: number | null;
  estimate?: Estimate | null;
  load?: Load | null;
  cpe?: { name: string; gainDbi: number; auto?: boolean; proposed?: boolean } | null;
  approx?: unknown;
  lat?: number;
  lon?: number;
}
export interface Result {
  aps: Ap[];
  cpeModels?: Array<{ id: string; name: string; gainDbi: number }>;
  restricted?: boolean;
  assignedCount?: number;
  hiddenWeak?: number;
  hideBelowDbm?: number;
  discarded?: number;
  maxKm: number;
  inRange: number;
  minSignalDbm: number;
}
export interface Profile {
  distanceM: number;
  verdict: 'clear' | 'fresnel' | 'blocked';
  buildings?: boolean;
  chart: Array<{ d: number; los: number; ground: number; top?: number }>;
  worst?: { d: number; clearanceM: number; fresnel60M: number } | null;
  raiseCpeM?: number;
  roofM?: number | null;
  mountedM?: number;
}
export interface Point {
  la: number;
  lo: number;
  label: string;
}

/** What the hills between the point and the AP do to the signal (same profile as Visibilità). */
export function terrainText(t: Terrain) {
  const db = Math.round(t.lossDb - (t.foliageDb ?? 0));
  const main = t.verdict === 'clear' ? 'terreno libero fino all’AP' : t.verdict === 'fresnel' ? `${t.buildings ? 'degli edifici sfiorano' : 'una collina sfiora'} la linea di vista (−${db} dB)` : `ostruito ${t.buildings ? 'da edifici' : 'dal terreno'} (−${db} dB): verifica con Visibilità`;
  return [main, t.foliageM ? `attraversa ${t.foliageM} m di vegetazione (−${Math.round(t.foliageDb ?? 0)} dB)` : null].filter(Boolean).join(' · ');
}

/** Expected signal of a new CPE: theory, terrain and the customers already on the AP. */
export function EstimateCell({ e }: { e?: Estimate | null }) {
  if (!e || e.signalDbm == null) return <span className="ui-muted ui-small">nessun cliente con segnale</span>;
  const line = (t: ReactNode) => <div className="ui-small">{t}</div>;
  return (
    <div className="cv-estimate">
      <div className="ui-row">
        <strong>{e.signalDbm} dBm</strong>
        <span className="ui-muted ui-small">
          ({e.low}…{e.high})
        </span>
        {e.confidence && <Badge tone={CONF[e.confidence] ?? 'neutral'}>affidabilità {e.confidence}</Badge>}
      </div>
      {e.inSector === false && line('fuori dal settore già servito')}
      {e.beyondServed && line('più lontano dei clienti attuali')}
      {e.tooFar && line('oltre 20 km: troppo lontano per un aggancio')}
      {e.terrain && line(terrainText(e.terrain))}
      {!!e.capacityMbps && line(`capacità del collegamento ~${e.capacityMbps} Mbit/s${e.eveningMbps != null ? `, la sera ~${e.eveningMbps}` : ''}`)}
      {e.theoretical ? (
        <div className="ui-muted ui-small">stima teorica: l’AP non ha ancora clienti</div>
      ) : e.basis != null ? (
        <div className="ui-muted ui-small">
          calibrata su {e.basis} {e.basis === 1 ? 'cliente' : 'clienti'}
          {e.nearby ? `, ${e.nearby} ${e.nearby === 1 ? 'vicino' : 'vicini'}` : ''}
        </div>
      ) : null}
    </div>
  );
}

/** Evening load of the AP: the verdict, and the numbers behind it. */
export function LoadCell({ l }: { l?: Load | null }) {
  if (!l?.level) return null;
  const n = (v: number | null | undefined, u: string) => (v == null ? null : `${v}${u}`);
  const details = [
    n(l.eveningAirtimePct, '% airtime'),
    n(l.eveningUtilizationPct, '% canale'),
    l.eveningPeakMbps != null ? `picco ${l.eveningPeakMbps}${l.capacityMbps ? `/${l.capacityMbps}` : ''} Mbit/s` : null,
    n(l.stations, ' CPE'),
    n(l.cpeAirtimePct, '% airtime per CPE'),
    l.snrDb != null ? `SNR ${l.snrDb} dB` : null,
    l.noiseDbm != null ? `rumore ${l.noiseDbm} dBm` : null,
  ].filter(Boolean);
  return (
    <div>
      <Badge tone={LOAD[l.level]![1]}>{LOAD[l.level]![0]}</Badge>
      {details.length > 0 && <div className="ui-muted ui-small">{details.join(' · ')}</div>}
    </div>
  );
}
