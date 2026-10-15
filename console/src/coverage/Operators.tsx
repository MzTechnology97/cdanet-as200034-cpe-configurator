import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { AsyncButton, Badge, Button, Card, Field, Notice } from '../ui';
import type { Point } from './parts';

/**
 * Copertura → «Altri operatori»: who else covers the point checked, or an exact address found step by
 * step (town → street → house number → stair): fibre, FTTC, radio and mobile, grouped by the AGCOM
 * sticker we compute from technology and speed. Admins see the operators; installers the same
 * answer without their names. Read on request (each reading goes to an external service), then
 * reused for some days.
 */

type Sticker = 'F' | 'FWA' | 'FR' | 'R';
type State = 'available' | 'planned' | 'none';
interface Row {
  /** Admins only. */
  operator?: string;
  /** Installers: how many operators offer it. */
  count?: number;
  technology: string;
  technologyLabel: string;
  family: string;
  kind: string;
  state: State;
  maxMbps: number | null;
  downMbps?: number | null;
  upMbps?: number | null;
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
interface Address {
  city: string;
  cityLabel: string;
  street: string;
  streetType: string;
  number: string;
  stair: string | null;
}

const STATE: Record<State, [string, 'good' | 'warn' | 'neutral']> = { available: ['attivabile', 'good'], planned: ['in studio', 'warn'], none: ['non disponibile', 'neutral'] };
const KIND: Record<string, string> = { fibra: 'fibra fino a casa', 'fibra-rame': 'misto fibra-rame', 'fibra-radio': 'misto fibra-radio', radio: 'radio', mobile: 'rete mobile', rame: 'rame', altro: '' };
const ERRORS: Record<string, string> = {
  operators_not_configured: 'La verifica degli altri operatori non è configurata o è spenta.',
  operators_address_not_found: 'Indirizzo non trovato: controlla via e civico.',
  operators_busy: 'Troppe verifiche in un minuto: riprova tra poco.',
};
const date = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
const speed = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} Gbit/s` : `${Math.round(m)} Mbit/s`);
const message = (e: unknown) => {
  const err = e as Error & { body?: { error?: string } };
  return ERRORS[err.body?.error ?? ''] ?? err.message;
};

/** The AGCOM sticker, in its colour. */
export function StickerChip({ s, color, big = false }: { s: Sticker; color: string; big?: boolean }) {
  return (
    <span className={`op-sticker${big ? ' big' : ''}${s === 'FR' ? ' dark' : ''}`} style={{ background: color }}>
      {s}
    </span>
  );
}

/** One step of the address: a text with the service's suggestions under it. */
function StepInput<T>({ label, placeholder, min, fetch, render, onPick, inputMode }: { label: string; placeholder: string; min: number; fetch: (q: string) => Promise<T[]>; render: (x: T) => string; onPick: (x: T) => void; inputMode?: 'numeric' }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < min) return void setItems(null);
    const t = setTimeout(() => {
      fetch(q.trim())
        .then((x) => (setItems(x), setError(null)))
        .catch((e) => setError(message(e)));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return (
    <div>
      <Field label={label}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoComplete="off" inputMode={inputMode} />
      </Field>
      {error && <p className="ui-small op-bad">{error}</p>}
      {items && (items.length ? (
        <div className="op-choices">
          {items.slice(0, 12).map((x) => (
            <button key={render(x)} type="button" className="op-choice" onClick={() => onPick(x)}>
              {render(x)}
            </button>
          ))}
        </div>
      ) : (
        <p className="ui-muted ui-small">Nessun risultato.</p>
      ))}
    </div>
  );
}

/** Town → street → house number → stair, each from the service's own lists: the exact building. */
function AddressSteps({ base, onCheck }: { base: string; onCheck: (a: Address) => Promise<void> }) {
  const [a, setA] = useState<Partial<Address>>({});
  const [stairs, setStairs] = useState<Array<string | null> | null>(null);
  const places = <T,>(params: Record<string, string>) => api<{ items: T[] }>(`${base}/places?${new URLSearchParams(params)}`).then((r) => r.items);
  const pickNumber = async (number: string) => {
    setA((x) => ({ ...x, number, stair: null }));
    setStairs(null);
    const s = await places<{ stair: string | null }>({ city: a.city!, street: a.street!, streetType: a.streetType ?? '', number }).catch(() => []);
    setStairs([...new Set(s.map((x) => x.stair))]);
  };
  const chip = (text: string, reset: () => void) => (
    <div className="op-picked">
      <strong>{text}</strong>
      <button type="button" className="ui-link ui-small" onClick={reset}>
        cambia
      </button>
    </div>
  );
  return (
    <div className="op-steps">
      {!a.city ? (
        <StepInput<{ city: string; label: string }> label="Comune" placeholder="Almeno 2 lettere" min={2} fetch={(q) => places({ q })} render={(x) => x.label} onPick={(x) => setA({ city: x.city, cityLabel: x.label })} />
      ) : (
        chip(a.cityLabel!, () => (setA({}), setStairs(null)))
      )}
      {a.city &&
        (!a.street ? (
          <StepInput<{ street: string; streetType: string; label: string }> label="Via" placeholder="Il nome, senza «via»" min={2} fetch={(q) => places({ city: a.city!, q })} render={(x) => x.label} onPick={(x) => setA({ ...a, street: x.street, streetType: x.streetType })} />
        ) : (
          chip([a.streetType, a.street].filter(Boolean).join(' '), () => (setA({ city: a.city, cityLabel: a.cityLabel }), setStairs(null)))
        ))}
      {a.street &&
        (!a.number ? (
          <StepInput<{ number: string }> label="Civico" placeholder="Le prime cifre" min={1} inputMode="numeric" fetch={(q) => places({ city: a.city!, street: a.street!, streetType: a.streetType ?? '', q })} render={(x) => x.number} onPick={(x) => void pickNumber(x.number)} />
        ) : (
          chip(`n. ${a.number}`, () => (setA({ ...a, number: undefined, stair: null }), setStairs(null)))
        ))}
      {a.number && stairs && stairs.some(Boolean) && (
        <Field label="Scala">
          <select value={a.stair ?? ''} onChange={(e) => setA({ ...a, stair: e.target.value || null })}>
            {stairs.map((s) => (
              <option key={s ?? ''} value={s ?? ''}>
                {s ?? 'non presente'}
              </option>
            ))}
          </select>
        </Field>
      )}
      {a.number && (
        <AsyncButton variant="primary" icon="search" onClick={() => onCheck(a as Address)}>
          Verifica questo indirizzo
        </AsyncButton>
      )}
    </div>
  );
}

export function OperatorsCard({ point, admin = true }: { point: Point | null; admin?: boolean }) {
  const base = admin ? '/api/admin/coverage/operators' : '/api/field/coverage/operators';
  const [a, setA] = useState<Answer | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const load = async (params: string, refresh = false) => {
    setError(null);
    try {
      setA(await api<Answer>(`${base}?${params}${refresh ? '&refresh=1' : ''}`));
      setLast(params);
    } catch (e) {
      setError(message(e));
    }
  };
  const atAddress = (x: Address) =>
    load(new URLSearchParams({ city: x.city, street: x.street, streetType: x.streetType, number: x.number, ...(x.stair ? { stair: x.stair } : {}) }).toString());
  const hidden = a ? a.groups.reduce((n, g) => n + g.rows.filter((r) => r.state === 'none').length, 0) : 0;

  return (
    <Card
      title="Altri operatori"
      actions={
        a ? (
          <>
            {admin && last && (
              <AsyncButton icon="refresh" onClick={() => load(last, true)}>
                Rileggi
              </AsyncButton>
            )}
            <Button onClick={() => (setA(null), setLast(null))}>Altro indirizzo</Button>
          </>
        ) : null
      }
    >
      {!a && (
        <>
          <p className="ui-muted ui-small">Fibra, FTTC, radio e rete mobile degli altri operatori, con il bollino AGCOM. La verifica usa un servizio esterno: parte solo quando la chiedi.</p>
          {point && (
            <AsyncButton variant="primary" icon="search" onClick={() => load(`lat=${point.la}&lon=${point.lo}`)}>
              Verifica nel punto scelto
            </AsyncButton>
          )}
          <details className="ui-details op-exact" open={!point}>
            <summary>{point ? 'Oppure l’indirizzo esatto (comune, via, civico)' : 'Indirizzo esatto (comune, via, civico)'}</summary>
            <AddressSteps base={base} onCheck={atAddress} />
          </details>
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
                {a.address ? `Indirizzo: ${a.address.label}` : 'Indirizzo non riconosciuto: risultato affidabile solo per le reti radio'} · {a.cached ? `verificato il ${date(a.at)}` : 'verificato ora'}
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
                    <li key={`${r.operator ?? ''}:${r.technology}:${r.state}:${r.maxMbps ?? ''}`} className="hl-row">
                      <div className="hl-main">
                        <div className="hl-name">
                          {r.operator ? <strong>{r.operator}</strong> : null}
                          <span>{r.technologyLabel}</span>
                          <Badge tone={STATE[r.state][1]}>{STATE[r.state][0]}</Badge>
                          {r.count != null && <span className="ui-muted ui-small">{r.count === 1 ? '1 operatore' : `${r.count} operatori`}</span>}
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
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Mostra anche le offerte non disponibili
            </label>
          )}
          <p className="ui-muted ui-small">Bollino AGCOM calcolato da tecnologia e velocità: F fibra fino a casa; FR misto fibra-rame (FTTC) o fibra-radio (radio da 30 Mbit/s); FWA blu per le reti radio VHCN; R rame, radio sotto 30 Mbit/s e rete mobile.</p>
        </>
      )}
    </Card>
  );
}
