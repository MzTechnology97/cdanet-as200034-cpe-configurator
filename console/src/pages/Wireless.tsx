import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { toast } from '../lib/toast';
import { api, ApiError } from '../lib/api';
import { AsyncButton, Badge, Button, Card, Field, Icon, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * Reti Wi-Fi (admins): the WPA2 keys of the APs' SSIDs, encrypted on the server (AES-256-GCM) and
 * never shown. One key at a time, a shared key for the SSIDs read from UISP, a CSV import with a
 * preview, the list with multiple selection and the export with the keys in clear (the admin's
 * password again; recorded and notified).
 */

/** CDA-NET-N{nodo}-D{distretto}, -R{n} for a relay ("rilancio") AP of the district. */
const SSID_RX = /^CDA-NET-N(\d+)-D(\d+)(?:-R(\d+))?$/;
const ssidOf = (n: string, d: string, r: string) => `CDA-NET-N${n}-D${String(d).padStart(2, '0')}${Number(r) ? `-R${r}` : ''}`;
/** Natural order: N2 before N11, D02 before D10, the district's AP before its relays. */
const sortKey = (s: string) => {
  const m = SSID_RX.exec(s);
  return m ? Number(m[1]) * 100000 + Number(m[2]) * 100 + Number(m[3] ?? 0) : Number.MAX_SAFE_INTEGER;
};
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const matches = (ssid: string, q: string) => {
  const t = q.trim().toUpperCase();
  return !t || ssid.includes(t) || ssid.replace('CDA-NET-', '').includes(t);
};

interface Network {
  ssid: string;
  updatedAt: string;
}
const KEY = ['admin', 'wireless'];

export function Wireless() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: async () => (await api<Network[]>('/api/admin/wireless-networks')).sort((a, b) => sortKey(a.ssid) - sortKey(b.ssid)) });
  const reload = () => qc.invalidateQueries({ queryKey: KEY });
  const networks = q.data ?? [];
  const formRef = useRef<{ edit: (ssid: string) => void } | null>(null);

  return (
    <div className="ui-page">
      <PageHeader icon="wifi_find" title="Reti Wi-Fi" subtitle="Le chiavi WPA2 sono cifrate (AES-256-GCM) e non vengono mai mostrate. Salvare di nuovo una rete esistente ne sostituisce la chiave." />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      <UispImport onDone={reload} />
      <KeyForm networks={networks} apiRef={formRef} onSaved={reload} />
      <CsvImport onDone={reload} />
      {!q.data && !q.error ? <Skeleton lines={6} /> : <NetworkList networks={networks} onEdit={(s) => formRef.current?.edit(s)} onChanged={reload} />}
    </div>
  );
}

/** One network: node, district and relay make the SSID; its key is replaced when it exists. */
function KeyForm({ networks, apiRef, onSaved }: { networks: Network[]; apiRef: { current: { edit: (ssid: string) => void } | null }; onSaved: () => Promise<void> }) {
  const [node, setNode] = useState('2');
  const [district, setDistrict] = useState('1');
  const [relay, setRelay] = useState('0');
  const [psk, setPsk] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pskRef = useRef<HTMLInputElement>(null);
  const ssid = ssidOf(node, district, relay);
  const exists = networks.some((n) => n.ssid === ssid);
  apiRef.current = {
    edit: (s) => {
      const m = SSID_RX.exec(s);
      if (!m) return;
      setNode(String(Number(m[1])));
      setDistrict(String(Number(m[2])));
      setRelay(String(Number(m[3] ?? 0)));
      setPsk('');
      box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      requestAnimationFrame(() => pskRef.current?.focus());
    },
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/admin/wireless-networks/${encodeURIComponent(ssid)}`, { method: 'PUT', body: { wpa2Password: psk } });
      setPsk('');
      toast(`WPA2 di ${ssid} ${exists ? 'aggiornata' : 'salvata'}`);
      await onSaved();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return (
    <div ref={box}>
      <Card title="Aggiungi o aggiorna una rete" actions={exists ? <Badge tone="warn">già configurata: verrà sostituita</Badge> : <Badge tone="good">nuova rete</Badge>}>
        <form className="wf-form" onSubmit={submit}>
          <Field label="Nodo">
            <select value={node} onChange={(e) => setNode(e.target.value)}>
              {range(2, 99).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Distretto">
            <select value={district} onChange={(e) => setDistrict(e.target.value)}>
              {range(1, 99).map((d) => (
                <option key={d} value={d}>
                  {String(d).padStart(2, '0')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rilancio">
            <select value={relay} onChange={(e) => setRelay(e.target.value)}>
              <option value="0">nessuno (AP del distretto)</option>
              {range(1, 9).map((r) => (
                <option key={r} value={r}>
                  R{r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="SSID">
            <input className="ui-mono" value={ssid} readOnly />
          </Field>
          <Field label="Chiave WPA2 (8-63 caratteri)">
            <input ref={pskRef} type={show ? 'text' : 'password'} autoComplete="new-password" minLength={8} maxLength={63} value={psk} onChange={(e) => setPsk(e.target.value)} required />
          </Field>
          <Button type="submit" variant="primary" busy={busy}>
            {exists ? 'Aggiorna chiave' : 'Salva chiave'}
          </Button>
        </form>
        <label className="ui-check ui-small">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Mostra chiave mentre scrivi
        </label>
      </Card>
    </div>
  );
}

interface ImportResult {
  ok: boolean;
  rows: number;
  errorCount: number;
  errors: Array<{ line: number; error: string }>;
  created: string[];
  updated: string[];
  unchanged: string[];
}

/** CSV: a preview first; nothing is saved while a row has an error. */
function CsvImport({ onDone }: { onDone: () => Promise<void> }) {
  const [csv, setCsv] = useState<{ text: string; name: string } | null>(null);
  const [r, setR] = useState<{ d?: ImportResult; error?: string; loading?: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pick = async (f: File) => {
    const text = await f.text();
    setCsv({ text, name: f.name });
    setR({ loading: true });
    try {
      setR({ d: await api<ImportResult>('/api/admin/wireless-networks/import', { method: 'POST', body: { csv: text, dryRun: true } }) });
    } catch (e) {
      setR({ error: (e as Error).message });
    }
  };
  const confirmImport = async () => {
    const done = await api<ImportResult>('/api/admin/wireless-networks/import', { method: 'POST', body: { csv: csv!.text, dryRun: false } });
    toast(`Import completato: ${done.created.length} nuove, ${done.updated.length} aggiornate`);
    if (input.current) input.current.value = '';
    setCsv(null);
    setR(null);
    await onDone();
  };
  const d = r?.d;
  const list = (title: string, xs: string[], tone: 'good' | 'warn' | 'neutral') =>
    xs.length > 0 && (
      <details className="ui-details">
        <summary>
          <Badge tone={tone}>
            {xs.length} {title}
          </Badge>
        </summary>
        <p className="ui-mono ui-small wf-p">{xs.join(', ')}</p>
      </details>
    );
  return (
    <Card title="Importa da CSV">
      <p className="ui-muted ui-small wf-p">Colonne: nodo;distretto;wpa2 (oppure ssid;wpa2). Separatore ; o , e una riga per rete. Le reti già presenti vengono aggiornate. Prima di salvare viene mostrata un’anteprima; se una riga è errata non viene importato nulla.</p>
      <div className="ui-row">
        <label className="ui-btn ui-btn-secondary fw-file">
          <input ref={input} type="file" accept=".csv,text/csv,text/plain" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
          {csv?.name ?? 'Scegli il file CSV'}
        </label>
        <a className="ui-btn ui-btn-ghost" href="/assets/esempio-reti-wifi.csv" download="esempio-reti-wifi.csv">
          Scarica CSV di esempio
        </a>
      </div>
      {r?.loading && <p className="ui-muted ui-small wf-p">Verifica del file…</p>}
      {r?.error && <Notice tone="bad">{r.error}</Notice>}
      {d && csv && (
        <>
          <Notice tone={d.ok ? 'good' : 'bad'}>
            {d.ok ? `${csv.name}: ${d.rows} righe valide. Nessuna modifica è stata ancora salvata.` : `${csv.name}: ${d.errorCount} righe con errori. Correggi il file e ricaricalo: finché ci sono errori non viene importato nulla.`}
          </Notice>
          {d.errors.length > 0 && (
            <Table
              rows={d.errors}
              rowKey={(e) => `${e.line}-${e.error}`}
              columns={[
                { label: 'Riga', render: (e) => e.line },
                { label: 'Errore', render: (e) => e.error },
              ]}
            />
          )}
          <div className="ui-row">
            {list('nuove', d.created, 'good')}
            {list('da aggiornare', d.updated, 'warn')}
            {list('invariate', d.unchanged, 'neutral')}
          </div>
          {d.ok && d.created.length + d.updated.length > 0 ? (
            <div className="ui-row">
              <AsyncButton variant="primary" onClick={confirmImport} onError={fail}>
                Importa {d.created.length + d.updated.length} reti
              </AsyncButton>
            </div>
          ) : d.ok ? (
            <p className="ui-muted ui-small wf-p">Tutte le chiavi sono già aggiornate.</p>
          ) : null}
        </>
      )}
    </Card>
  );
}

interface UispFound {
  pending: Array<{ ssid: string; aps: string[] }>;
  imported: number;
  skipped: Array<{ ssid: string }>;
}

/** From UISP: the SSIDs not yet imported, one shared WPA2 key (dry run and confirmation first). */
function UispImport({ onDone }: { onDone: () => Promise<void> }) {
  const [found, setFound] = useState<UispFound | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [all, setAll] = useState(false);

  const read = async () => {
    const f = await api<UispFound>('/api/admin/wireless-networks/uisp');
    setFound(f);
    setChosen(new Set(f.pending.map((p) => p.ssid)));
    setFilter('');
  };
  const apply = async () => {
    if (key.length < 8 || key.length > 63) throw new Error('La chiave WPA2 deve avere da 8 a 63 caratteri');
    const body = { wpa2Password: key, ssids: [...chosen], scope: all ? 'all' : 'new' };
    const preview = await api<{ created: string[]; updated: string[] }>('/api/admin/wireless-networks/uisp-import', { method: 'POST', body: { ...body, dryRun: true } });
    const n = preview.created.length + preview.updated.length;
    if (!n) return void toast('Tutte le reti hanno già questa chiave');
    const parts = [preview.created.length ? `${preview.created.length} nuove` : '', preview.updated.length ? `${preview.updated.length} già importate (la chiave verrà sostituita)` : ''].filter(Boolean);
    if (!confirm(`Applicare la chiave a ${n} reti?\n${parts.join(', ')}.`)) return;
    const r = await api<{ created: string[]; updated: string[] }>('/api/admin/wireless-networks/uisp-import', { method: 'POST', body: { ...body, dryRun: false } });
    setKey('');
    setAll(false);
    toast(`Chiave applicata: ${r.created.length} nuove, ${r.updated.length} aggiornate`);
    await read();
    await onDone();
  };

  // one compact row per node: N2 · D01 D02 D02-R1 … (AP names on hover)
  const byNode = useMemo(() => {
    const m = new Map<number, Array<{ ssid: string; aps: string[] }>>();
    for (const s of found?.pending ?? []) {
      if (!matches(s.ssid, filter)) continue;
      const n = Number(SSID_RX.exec(s.ssid)?.[1] ?? 0);
      m.set(n, [...(m.get(n) ?? []), s]);
    }
    return [...m].sort((a, b) => a[0] - b[0]).map(([n, list]) => [n, list.sort((a, b) => sortKey(a.ssid) - sortKey(b.ssid))] as const);
  }, [found, filter]);
  const toggle = (ssid: string, on: boolean) => {
    const n = new Set(chosen);
    if (on) n.add(ssid);
    else n.delete(ssid);
    setChosen(n);
  };
  const count = chosen.size + (all ? (found?.imported ?? 0) : 0);
  const keyFields = (
    <>
      <div className="wf-inline">
        <Field label="Chiave WPA2 comune (8-63 caratteri)">
          <input type={show ? 'text' : 'password'} autoComplete="new-password" minLength={8} maxLength={63} value={key} placeholder="chiave WPA2 comune a tutti gli AP" onChange={(e) => setKey(e.target.value)} />
        </Field>
        <AsyncButton variant="primary" disabled={count === 0} onClick={apply} onError={fail}>
          {chosen.size ? `Importa ${chosen.size} SSID` : all ? `Aggiorna ${found?.imported ?? 0} reti` : 'Importa'}
        </AsyncButton>
      </div>
      <label className="ui-check ui-small">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Mostra chiave mentre scrivi
      </label>
      {!!found?.imported && (
        <label className="ui-check ui-small">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Sostituisci la chiave anche sulle {found.imported} reti già importate
        </label>
      )}
    </>
  );
  const skipped = !!found?.skipped.length && (
    <details className="ui-details">
      <summary className="ui-muted ui-small">{found.skipped.length} SSID non nel formato CDA-NET-N{'{nodo}'}-D{'{distretto}'} (non importabili)</summary>
      <p className="ui-mono ui-small wf-p">{found.skipped.map((s) => s.ssid).join(', ')}</p>
    </details>
  );

  return (
    <Card title="Importa da UISP">
      <p className="ui-muted ui-small wf-p">Gli SSID degli AP dei clienti presi da UISP (rilanci compresi, collegamenti PtP esclusi) che non hanno ancora una chiave: una sola chiave WPA2 comune per tutti, senza inserirli a mano uno per volta.</p>
      <div className="ui-row">
        <AsyncButton onClick={read} onError={fail}>
          {found ? 'Rileggi gli SSID da UISP' : 'Leggi gli SSID da UISP'}
        </AsyncButton>
      </div>
      {found &&
        (!found.pending.length ? (
          !found.imported ? (
            <>
              <p className="ui-muted wf-p">Nessun AP CDA Net trovato in UISP.</p>
              {skipped}
            </>
          ) : (
            <>
              <Notice tone="good">Tutti i {found.imported} SSID degli AP in UISP sono già importati.</Notice>
              {skipped}
              {keyFields}
            </>
          )
        ) : (
          <>
            <div className="ui-row">
              <Badge tone="good">{found.pending.length} da importare</Badge>
              <Badge>{found.imported} già importati</Badge>
            </div>
            <div className="wf-inline">
              <label className="hl-search">
                <Icon name="search" />
                <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtra: N12, D05…" aria-label="Filtra" />
              </label>
              <Button onClick={() => setChosen(new Set([...chosen, ...found.pending.filter((p) => matches(p.ssid, filter)).map((p) => p.ssid)]))}>Tutti</Button>
              <Button onClick={() => setChosen(new Set([...chosen].filter((s) => !matches(s, filter))))}>Nessuno</Button>
              <span className="ui-muted ui-small">
                {chosen.size} di {found.pending.length} selezionati
              </span>
            </div>
            <div className="wf-pick">
              {byNode.length ? (
                byNode.map(([n, list]) => (
                  <div key={n} className="wf-node">
                    <strong className="ui-mono">N{n}</strong>
                    <div className="wf-ssids">
                      {list.map((s) => (
                        <label key={s.ssid} className={`wf-ssid${chosen.has(s.ssid) ? ' on' : ''}`} title={`${s.ssid}\n${s.aps.join(', ')}`}>
                          <input type="checkbox" checked={chosen.has(s.ssid)} onChange={(e) => toggle(s.ssid, e.target.checked)} aria-label={s.ssid} />
                          {s.ssid.replace(/^CDA-NET-N\d+-/, '')}
                        </label>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <p className="ui-muted ui-small wf-p">Nessun SSID corrisponde al filtro.</p>
              )}
            </div>
            {skipped}
            {keyFields}
          </>
        ))}
    </Card>
  );
}

/** The networks with a key: search, multiple selection, delete, export with the keys in clear. */
function NetworkList({ networks, onEdit, onChanged }: { networks: Network[]; onEdit: (ssid: string) => void; onChanged: () => Promise<void> }) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [pw, setPw] = useState('');
  const rows = networks.filter((n) => matches(n.ssid, filter));
  // a network removed meanwhile is not selected any more
  const sel = new Set([...selected].filter((s) => networks.some((n) => n.ssid === s)));
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.ssid));
  const someOn = rows.some((r) => sel.has(r.ssid));
  const toggle = (s: string, on: boolean) => {
    const n = new Set(sel);
    if (on) n.add(s);
    else n.delete(s);
    setSelected(n);
  };
  const remove = async () => {
    const ssids = [...sel];
    const preview = ssids.slice(0, 8).join('\n') + (ssids.length > 8 ? `\n… e altre ${ssids.length - 8}` : '');
    if (!confirm(`Eliminare la chiave WPA2 di ${ssids.length} reti?\n\n${preview}\n\nIl provisioning su queste reti verrà bloccato finché non reinserisci la chiave.`)) return;
    const r = await api<{ deleted: number }>('/api/admin/wireless-networks/bulk-delete', { method: 'POST', body: { ssids } });
    setSelected(new Set());
    toast(`${r.deleted} reti eliminate`);
    await onChanged();
  };
  const exportCsv = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { password: pw, ...(sel.size ? { ssids: [...sel] } : {}) };
      const r = await api<Response>('/api/admin/wireless-networks/export', { method: 'POST', body, raw: true });
      if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => ({})));
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'reti-wifi.csv';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob());
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setExporting(false);
      setPw('');
      toast('CSV scaricato: contiene le chiavi in chiaro, conservalo al sicuro');
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Card padded={false}>
      <div className="us-head">
        <label className="hl-search">
          <Icon name="search" />
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtra: N12, D05, CDA-NET-N2…" aria-label="Cerca" />
        </label>
        <span className="ui-muted ui-small">
          {networks.length} reti configurate{sel.size ? ` · ${sel.size} selezionate` : ''}
        </span>
        <div className="ui-row">
          <Button variant="ghost" disabled={!sel.size} onClick={() => setSelected(new Set())}>
            Deseleziona
          </Button>
          <AsyncButton variant="danger" disabled={!sel.size} onClick={remove} onError={fail}>
            {sel.size ? `Elimina selezionate (${sel.size})` : 'Elimina selezionate'}
          </AsyncButton>
          <Button onClick={() => setExporting(true)}>Esporta CSV con le chiavi</Button>
        </div>
      </div>
      {exporting && (
        <form className="wf-export" onSubmit={exportCsv}>
          <Notice tone="warn">Il file conterrà {sel.size ? `le ${sel.size} reti selezionate` : `tutte le ${networks.length} reti`} con la chiave WPA2 in chiaro (stesso formato dell’import CSV). L’esportazione viene registrata e segnalata agli amministratori.</Notice>
          <div className="wf-inline">
            <Field label="La tua password">
              <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            </Field>
            <Button type="submit" variant="primary">
              Scarica
            </Button>
            <Button variant="ghost" onClick={() => (setExporting(false), setPw(''))}>
              Annulla
            </Button>
          </div>
        </form>
      )}
      <div className="wf-selectall">
        <label className="ui-check ui-small">
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => {
              if (el) el.indeterminate = !allOn && someOn;
            }}
            onChange={(e) => {
              const n = new Set(sel);
              for (const r of rows) {
                if (e.target.checked) n.add(r.ssid);
                else n.delete(r.ssid);
              }
              setSelected(n);
            }}
          />
          Seleziona tutte le reti visibili
        </label>
      </div>
      <Table
        rows={rows}
        rowKey={(n) => n.ssid}
        empty="Nessuna rete."
        columns={[
          { label: '', render: (n) => <input type="checkbox" className="hl-check" checked={sel.has(n.ssid)} onChange={(e) => toggle(n.ssid, e.target.checked)} aria-label={`Seleziona ${n.ssid}`} /> },
          { label: 'SSID', render: (n) => <span className="ui-mono">{n.ssid}</span> },
          { label: 'Aggiornata', render: (n) => date(n.updatedAt) },
          {
            label: '',
            end: true,
            render: (n) => (
              <Button variant="ghost" onClick={() => onEdit(n.ssid)}>
                Modifica WPA2
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}
