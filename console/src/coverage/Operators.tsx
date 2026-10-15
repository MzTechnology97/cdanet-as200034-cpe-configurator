import { useState } from 'react';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Notice } from '../ui';
import type { Point } from './parts';

/**
 * Copertura → «Altri operatori» (admins): who else covers the point checked, fibre, FTTC, radio and
 * mobile, grouped by the AGCOM sticker we compute from technology and speed. Read on request (each
 * reading goes to an external service), then reused for some days.
 */

type Sticker = 'F' | 'FWA' | 'FR' | 'R';
type State = 'available' | 'planned' | 'none';
interface Row {
  operator: string;
  technology: string;
  technologyLabel: string;
  family: string;
  kind: string;
  state: State;
  maxMbps: number | null;
  downMbps: number | null;
  upMbps: number | null;
}
interface Group {
  sticker: Sticker;
  label: string;
  color: string;
  available: number;
  rows: Row[];
}
interface Answer {
  at: string;
  cached: boolean;
  address: { label: string; city: string; lat: number | null; lon: number | null; geoid: string | null } | null;
  best: Sticker | null;
  available: number;
  groups: Group[];
}

const STATE: Record<State, [string, 'good' | 'warn' | 'neutral']> = { available: ['attivabile', 'good'], planned: ['in studio', 'warn'], none: ['non disponibile', 'neutral'] };
const KIND: Record<string, string> = { fibra: 'fibra fino a casa', 'fibra-rame': 'misto fibra-rame', 'fibra-radio': 'misto fibra-radio', radio: 'radio', mobile: 'rete mobile', rame: 'rame', altro: '' };
const date = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
const speed = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} Gbit/s` : `${Math.round(m)} Mbit/s`);

/** The AGCOM sticker, in its colour. */
export function StickerChip({ s, color, big = false }: { s: Sticker; color: string; big?: boolean }) {
  return (
    <span className={`op-sticker${big ? ' big' : ''}${s === 'FR' ? ' dark' : ''}`} style={{ background: color }}>
      {s}
    </span>
  );
}

export function OperatorsCard({ point }: { point: Point }) {
  const [a, setA] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const load = async (refresh = false) => {
    setError(null);
    try {
      setA(await api<Answer>(`/api/admin/coverage/operators?lat=${point.la}&lon=${point.lo}${refresh ? '&refresh=1' : ''}`));
    } catch (e) {
      const err = e as Error & { body?: { error?: string } };
      setError(err.body?.error === 'operators_not_configured' ? 'Il connettore della copertura multi-operatore non è configurato o è spento: Connettori → MyWic.' : err.message);
    }
  };
  const hidden = a ? a.groups.reduce((n, g) => n + g.rows.filter((r) => r.state === 'none').length, 0) : 0;

  return (
    <Card
      title="Altri operatori"
      actions={
        a ? (
          <AsyncButton icon="refresh" onClick={() => load(true)}>
            Rileggi
          </AsyncButton>
        ) : null
      }
    >
      {!a && (
        <>
          <p className="ui-muted ui-small">Fibra, FTTC, radio e rete mobile degli altri operatori in questo punto, con il bollino AGCOM. La verifica usa un servizio esterno: parte solo quando la chiedi.</p>
          <AsyncButton variant="primary" icon="search" onClick={() => load()}>
            Verifica gli altri operatori
          </AsyncButton>
        </>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      {a && (
        <>
          <div className="op-head">
            {a.best ? <StickerChip s={a.best} color={a.groups.find((g) => g.sticker === a.best)!.color} big /> : <span className="op-sticker big none">—</span>}
            <div>
              <strong>{a.best ? `Il migliore attivabile: ${a.groups.find((g) => g.sticker === a.best)!.label}` : 'Nessuna offerta attivabile'}</strong>
              <div className="ui-muted ui-small">
                {a.address ? `Indirizzo riconosciuto: ${a.address.label}` : 'Indirizzo non riconosciuto: risultato affidabile solo per le reti radio'} · {a.cached ? `verificato il ${date(a.at)}` : 'verificato ora'}
              </div>
            </div>
          </div>
          {a.groups.map((g) => {
            const rows = all ? g.rows : g.rows.filter((r) => r.state !== 'none');
            if (!rows.length) return null;
            return (
              <section key={g.sticker} className="op-group">
                <h4 className="op-title">
                  <StickerChip s={g.sticker} color={g.color} /> {g.label}
                </h4>
                <ul className="hl-list">
                  {rows.map((r) => (
                    <li key={`${r.operator}:${r.technology}`} className="hl-row">
                      <div className="hl-main">
                        <div className="hl-name">
                          <strong>{r.operator}</strong>
                          <span>{r.technologyLabel}</span>
                          <Badge tone={STATE[r.state][1]}>{STATE[r.state][0]}</Badge>
                        </div>
                        <div className="hl-sub ui-small">
                          {[KIND[r.kind], r.downMbps ? `stimati ${Math.round(r.downMbps)}/${Math.round(r.upMbps ?? 0)} Mbit/s` : r.maxMbps ? `fino a ${speed(r.maxMbps)}` : null].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {hidden > 0 && (
            <label className="ui-check ui-small">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Mostra anche le {hidden} offerte non disponibili
            </label>
          )}
          <p className="ui-muted ui-small">Bollino AGCOM calcolato da tecnologia e velocità: F fibra fino a casa; FR misto fibra-rame (FTTC) o fibra-radio (FWA da 30 Mbit/s); FWA blu per le reti radio VHCN indicate in Impostazioni server; R rame, radio sotto 30 Mbit/s e rete mobile.</p>
        </>
      )}
    </Card>
  );
}
