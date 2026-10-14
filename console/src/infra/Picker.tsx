import { useState } from 'react';
import { Icon } from '../ui';

/**
 * The POPs and APs read from UISP (and the manual zones of Guasti Enel) as a searchable tree of
 * checkboxes: what is monitored in Guasti Enel, what each installer is assigned in Account.
 */

export interface InfraAp {
  id: string;
  name: string;
  ssid?: string | null;
  stations?: number | null;
  locationFrom?: string | null;
}
export interface InfraPop {
  id: string;
  name: string;
  address?: string | null;
  lat?: number | null;
  stations?: number | null;
  aps: InfraAp[];
}
export interface Infra {
  pops: InfraPop[];
  apsWithoutPop: InfraAp[];
  missing?: { pops: string[]; aps: string[] };
}
export interface Zone {
  id: string;
  name: string;
  radiusKm?: number;
}

/** "POP Nodo 2", "AP N2 D01", "Zona Centro" from an assignment or selection item. */
export const itemLabel = (i: { key: string; name: string }) => (i.key.startsWith('pop:') ? `POP ${i.name}` : i.key.startsWith('ap:') ? i.name : `Zona ${i.name}`);

/** key → name of every POP and AP (and manual zone) that can be picked. */
export function itemNames(inf: Infra, zones: Zone[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of inf.pops) {
    m.set(`pop:${p.id}`, p.name);
    for (const a of p.aps) m.set(`ap:${a.id}`, a.name);
  }
  for (const a of inf.apsWithoutPop) m.set(`ap:${a.id}`, a.name);
  for (const z of zones) m.set(z.id, z.name);
  return m;
}

/**
 * [chosen] / [onChange]: the ticked keys. [only] limits the choice (the monitored ones);
 * [cascade]: a POP ticks or unticks its APs; [popCoversAps]: a POP includes its APs (said in its line).
 */
export function Picker({ inf, zones = [], chosen, onChange, only = null, cascade = false, popCoversAps = false }: { inf: Infra; zones?: Zone[]; chosen: Set<string>; onChange: (next: Set<string>) => void; only?: Set<string> | null; cascade?: boolean; popCoversAps?: boolean }) {
  const [q, setQ] = useState('');
  const t = q.trim().toLowerCase();
  const hit = (...xs: Array<string | null | undefined>) => !t || xs.some((x) => x && x.toLowerCase().includes(t));
  const ok = (k: string) => !only || only.has(k);
  const set = (keys: string[], on: boolean) => {
    const n = new Set(chosen);
    for (const k of keys) {
      if (on) n.add(k);
      else n.delete(k);
    }
    onChange(n);
  };
  const box = (key: string, text: React.ReactNode, extra?: string, also: string[] = []) => (
    <label className="ui-check pk-line">
      <input type="checkbox" checked={chosen.has(key)} onChange={(e) => set([key, ...also], e.target.checked)} />
      <span>
        {text}
        {extra && <span className="ui-muted ui-small"> {extra}</span>}
      </span>
    </label>
  );
  const apLine = (a: InfraAp) => (
    <div key={a.id}>{box(`ap:${a.id}`, a.name, [a.ssid && a.ssid !== a.name ? a.ssid : null, `${a.stations ?? 0} CPE`, a.locationFrom === 'pop' ? 'posizione del POP' : a.locationFrom === null ? 'senza posizione' : null].filter(Boolean).join(' · '))}</div>
  );

  const rows: React.ReactNode[] = [];
  for (const p of inf.pops) {
    const aps = p.aps.filter((a) => ok(`ap:${a.id}`));
    const popOk = ok(`pop:${p.id}`);
    if (!popOk && !aps.length) continue;
    const popHit = hit(p.name, p.address);
    const shown = popHit ? aps : aps.filter((a) => hit(a.name, a.ssid));
    if (!popHit && !shown.length) continue;
    const info = [p.address, p.lat == null ? 'senza posizione' : null, p.stations != null ? `${p.stations} CPE` : null, popCoversAps && p.aps.length ? 'include i suoi AP' : null].filter(Boolean).join(' · ');
    rows.push(
      <div key={p.id} className="pk-pop">
        {popOk ? (
          box(`pop:${p.id}`, <strong>POP {p.name}</strong>, info, cascade ? aps.map((a) => `ap:${a.id}`) : [])
        ) : (
          <div>
            <strong>POP {p.name}</strong> <span className="ui-muted ui-small">{info}</span>
          </div>
        )}
        {shown.length > 0 && <div className="pk-aps">{shown.map(apLine)}</div>}
      </div>,
    );
  }
  const loose = inf.apsWithoutPop.filter((a) => ok(`ap:${a.id}`) && hit(a.name, a.ssid));
  if (loose.length)
    rows.push(
      <div key="loose" className="pk-pop">
        <strong>AP senza POP</strong>
        <div className="pk-aps">{loose.map(apLine)}</div>
      </div>,
    );
  const zs = zones.filter((z) => hit(z.name));
  if (zs.length)
    rows.push(
      <div key="zones" className="pk-pop">
        <strong>Zone Guasti Enel</strong>
        <div className="pk-aps">
          {zs.map((z) => (
            <div key={z.id}>{box(z.id, z.name, `${z.radiusKm} km`)}</div>
          ))}
        </div>
      </div>,
    );

  return (
    <div className="pk">
      <label className="hl-search">
        <Icon name="search" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca POP, AP, SSID o indirizzo…" aria-label="Cerca" />
      </label>
      <div className="pk-list">{rows.length ? rows : <p className="ui-muted ui-small">{only && !only.size ? 'Nessun POP/AP monitorato: selezionali in Guasti Enel.' : 'Nessun risultato.'}</p>}</div>
    </div>
  );
}
