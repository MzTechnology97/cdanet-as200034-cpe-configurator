import { useMemo, useState } from 'react';
import { Button, Icon } from '../ui';

/**
 * The POPs and APs read from UISP (and the manual zones of Guasti Enel) as a tree of checkboxes,
 * made for networks with many POPs: POPs closed (their APs open with the arrow, or by themselves
 * when the search finds them), how many APs of each are ticked, «Solo selezionati», the count of
 * what is ticked, «Seleziona i risultati» of a search and who else has a POP or an AP.
 * Used for what is monitored in Guasti Enel and for what each installer is assigned in Account.
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

/** "2 POP · 5 AP · 1 zona" of a set of keys. */
export function countLabel(keys: Iterable<string>) {
  let pops = 0;
  let aps = 0;
  let zones = 0;
  for (const k of keys) {
    if (k.startsWith('pop:')) pops++;
    else if (k.startsWith('ap:')) aps++;
    else zones++;
  }
  const parts = [pops ? `${pops} POP` : '', aps ? `${aps} AP` : '', zones ? `${zones} ${zones === 1 ? 'zona' : 'zone'}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'nessuno';
}

const sortByName = <T extends { name: string }>(xs: T[]) => [...xs].sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }));

/**
 * [chosen] / [onChange]: the ticked keys. [only] limits the choice (the monitored ones);
 * [cascade]: a POP ticks or unticks its APs; [popCoversAps]: a ticked POP includes all its APs
 * (they show as included); [others]: key → who else has it («anche: …»).
 */
export function Picker({
  inf,
  zones = [],
  chosen,
  onChange,
  only = null,
  cascade = false,
  popCoversAps = false,
  others,
}: {
  inf: Infra;
  zones?: Zone[];
  chosen: Set<string>;
  onChange: (next: Set<string>) => void;
  only?: Set<string> | null;
  cascade?: boolean;
  popCoversAps?: boolean;
  others?: Map<string, string[]>;
}) {
  const [q, setQ] = useState('');
  const [onlyChosen, setOnlyChosen] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const t = q.trim().toLowerCase();
  const hit = (...xs: Array<string | null | undefined>) => !t || xs.some((x) => x && x.toLowerCase().includes(t));
  const ok = (k: string) => !only || only.has(k);
  const pops = useMemo(() => sortByName(inf.pops).map((p) => ({ ...p, aps: sortByName(p.aps) })), [inf.pops]);
  const loose = useMemo(() => sortByName(inf.apsWithoutPop), [inf.apsWithoutPop]);

  const set = (keys: string[], on: boolean) => {
    const n = new Set(chosen);
    for (const k of keys) {
      if (on) n.add(k);
      else n.delete(k);
    }
    onChange(n);
  };
  const toggleOpen = (id: string) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const also = (key: string) => {
    const who = others?.get(key);
    return who?.length ? <span className="pk-also"> · anche: {who.join(', ')}</span> : null;
  };

  // what the list shows: by the search, by «Solo selezionati» and by [only]
  const visible = [];
  const resultKeys: string[] = [];
  for (const p of pops) {
    const popKey = `pop:${p.id}`;
    const popOk = ok(popKey);
    const aps = p.aps.filter((a) => ok(`ap:${a.id}`));
    if (!popOk && !aps.length) continue;
    const popCovers = popCoversAps && chosen.has(popKey);
    const popHit = hit(p.name, p.address);
    const apsHit = aps.filter((a) => hit(a.name, a.ssid));
    if (!popHit && !apsHit.length) continue;
    const chosenAps = aps.filter((a) => chosen.has(`ap:${a.id}`));
    if (onlyChosen && !chosen.has(popKey) && !chosenAps.length) continue;
    const shownAps = (onlyChosen && !popCovers ? chosenAps : popHit ? aps : apsHit).filter((a) => !onlyChosen || popCovers || chosen.has(`ap:${a.id}`));
    // closed unless opened, or the search found its APs (not the POP itself)
    const expanded = open.has(p.id) || (!!t && !popHit && apsHit.length > 0) || (onlyChosen && !popCovers && chosenAps.length > 0);
    // «Seleziona i risultati»: the POP when the search found the POP, else only the APs it found
    if (popOk && popHit) resultKeys.push(popKey);
    else resultKeys.push(...apsHit.map((a) => `ap:${a.id}`));
    visible.push({ p, popKey, popOk, aps, shownAps, chosenAps, popCovers, expanded });
  }
  const looseShown = loose.filter((a) => ok(`ap:${a.id}`) && hit(a.name, a.ssid) && (!onlyChosen || chosen.has(`ap:${a.id}`)));
  resultKeys.push(...looseShown.map((a) => `ap:${a.id}`));
  const zonesShown = zones.filter((z) => hit(z.name) && (!onlyChosen || chosen.has(z.id)));
  resultKeys.push(...zonesShown.map((z) => z.id));

  const apInfo = (a: InfraAp) => [a.ssid && a.ssid !== a.name ? a.ssid : null, `${a.stations ?? 0} CPE`, a.locationFrom === 'pop' ? 'posizione del POP' : a.locationFrom === null ? 'senza posizione' : null].filter(Boolean).join(' · ');
  const apLine = (a: InfraAp, covered = false) => {
    const key = `ap:${a.id}`;
    return (
      <label key={a.id} className={`ui-check pk-line${covered ? ' covered' : ''}`}>
        <input type="checkbox" checked={covered || chosen.has(key)} disabled={covered} onChange={(e) => set([key], e.target.checked)} />
        <span>
          {a.name}
          <span className="ui-muted ui-small"> {covered ? 'incluso nel POP' : apInfo(a)}</span>
          {!covered && also(key)}
        </span>
      </label>
    );
  };

  return (
    <div className="pk">
      <div className="pk-bar">
        <label className="hl-search">
          <Icon name="search" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca POP, AP, SSID o indirizzo…" aria-label="Cerca" />
        </label>
        <label className="ui-check ui-small">
          <input type="checkbox" checked={onlyChosen} onChange={(e) => setOnlyChosen(e.target.checked)} />
          Solo selezionati
        </label>
      </div>
      <div className="pk-bar">
        <strong className="pk-count">Selezionati: {countLabel(chosen)}</strong>
        {!!t && resultKeys.length > 0 && (
          <Button variant="ghost" onClick={() => set(resultKeys, true)}>
            {resultKeys.length === 1 ? 'Seleziona il risultato' : `Seleziona i ${resultKeys.length} risultati`}
          </Button>
        )}
        {chosen.size > 0 && (
          <Button variant="ghost" onClick={() => onChange(new Set())}>
            Svuota
          </Button>
        )}
      </div>
      <div className="pk-list">
        {visible.map(({ p, popKey, popOk, aps, shownAps, chosenAps, popCovers, expanded }) => {
          const partial = !chosen.has(popKey) && chosenAps.length > 0;
          const info = [p.address, p.lat == null ? 'senza posizione' : null, p.stations != null ? `${p.stations} CPE` : null].filter(Boolean).join(' · ');
          return (
            <div key={p.id} className={`pk-pop${chosen.has(popKey) ? ' on' : partial ? ' partial' : ''}`}>
              <div className="pk-pop-row">
                <button type="button" className="pk-toggle" aria-expanded={expanded} aria-label={`${expanded ? 'Chiudi' : 'Apri'} gli AP di ${p.name}`} onClick={() => toggleOpen(p.id)} disabled={!aps.length}>
                  <Icon name="chevron_right" className={`icon pk-chev${expanded ? ' open' : ''}`} />
                </button>
                {popOk ? (
                  <label className="ui-check pk-line">
                    <input
                      type="checkbox"
                      checked={chosen.has(popKey)}
                      ref={(el) => {
                        if (el) el.indeterminate = cascade && partial;
                      }}
                      onChange={(e) => set([popKey, ...(cascade ? aps.map((a) => `ap:${a.id}`) : [])], e.target.checked)}
                    />
                    <span>
                      <strong>POP {p.name}</strong>
                      {info && <span className="ui-muted ui-small"> {info}</span>}
                      {also(popKey)}
                    </span>
                  </label>
                ) : (
                  <span className="pk-line">
                    <strong>POP {p.name}</strong> <span className="ui-muted ui-small">{info}</span>
                  </span>
                )}
                <span className="pk-badge">{popCovers ? `tutti i ${aps.length} AP` : `${chosenAps.length}/${aps.length} AP`}</span>
              </div>
              {expanded && shownAps.length > 0 && <div className="pk-aps">{shownAps.map((a) => apLine(a, popCovers))}</div>}
            </div>
          );
        })}
        {looseShown.length > 0 && (
          <div className="pk-pop">
            <div className="pk-pop-row">
              <strong>AP senza POP</strong>
            </div>
            <div className="pk-aps">{looseShown.map((a) => apLine(a))}</div>
          </div>
        )}
        {zonesShown.length > 0 && (
          <div className="pk-pop">
            <div className="pk-pop-row">
              <strong>Zone Guasti Enel</strong>
            </div>
            <div className="pk-aps">
              {zonesShown.map((z) => (
                <label key={z.id} className="ui-check pk-line">
                  <input type="checkbox" checked={chosen.has(z.id)} onChange={(e) => set([z.id], e.target.checked)} />
                  <span>
                    {z.name}
                    <span className="ui-muted ui-small"> {z.radiusKm} km</span>
                    {also(z.id)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        {!visible.length && !looseShown.length && !zonesShown.length && (
          <p className="ui-muted ui-small">{only && !only.size ? 'Nessun POP/AP monitorato: selezionali in Guasti Enel.' : onlyChosen ? 'Niente di selezionato.' : 'Nessun risultato.'}</p>
        )}
      </div>
    </div>
  );
}
