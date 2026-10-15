import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Field, Notice } from '../ui';

/**
 * Connettori → Victron VRM: the solar and battery systems that power the POPs. A personal access
 * token of a VRM user, sealed on the server; the test reads the installations it sees (counts
 * only) and writes nothing to VRM. Below, each installation is linked by hand to the POP it
 * powers (the GPS of the GX only suggests one): Stato rete and Guasti Enel then show its battery.
 */

const ERRORS: Record<string, string> = {
  vrm_incomplete: 'Serve il token di accesso VRM.',
  vrm_unreachable: 'VRM non raggiungibile dal server (DNS o firewall).',
  vrm_auth_failed: 'Token rifiutato da VRM: controlla di averlo copiato tutto e che non sia scaduto o revocato.',
  vrm_forbidden: 'VRM ha negato l’accesso con questo token.',
  vrm_rate_limited: 'Troppe richieste a VRM: riprova tra qualche secondo.',
  vrm_error: 'VRM ha risposto con un errore.',
  vrm_site_not_found: 'Impianto non più presente in VRM: rileggi gli impianti.',
  pop_not_found: 'POP non trovato: ricarica la pagina.',
};
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const apiError = (e: unknown) => {
  const err = e as Error & { body?: { error?: string; issues?: Array<{ message: string }> } };
  return new Error(ERRORS[err.body?.error ?? ''] ?? err.body?.issues?.[0]?.message ?? err.message);
};
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export interface Victron {
  configured: boolean;
  enabled: boolean;
  tokenSet: boolean;
  tokenHint?: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
}
interface Test {
  ok: boolean;
  error?: string;
  status?: number | null;
  detail?: string;
  latencyMs?: number;
  user?: string;
  installations?: number;
  withAlarms?: number;
  silent?: number;
}

export function VictronCard({ v, onSaved }: { v: Victron; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ enabled: v.configured ? v.enabled : true, token: '' });
  const [test, setTest] = useState<{ r?: Test; loading?: boolean } | null>(null);
  const body = () => ({ enabled: f.enabled, ...(f.token.trim() ? { token: f.token.trim() } : {}) });
  const on = v.configured && v.enabled;
  const runTest = async () => {
    setTest({ loading: true });
    try {
      setTest({ r: await api<Test>('/api/admin/connectors/victron/test', { method: 'POST', body: body() }) });
    } catch (e) {
      setTest(null);
      throw apiError(e);
    }
  };
  const save = async () => {
    try {
      const r = await api<{ enabled: boolean }>('/api/admin/connectors/victron', { method: 'PUT', body: body() });
      toast(r.enabled ? 'Connettore Victron salvato e attivo' : 'Connettore Victron salvato (disattivato)');
      setF({ ...f, token: '' });
      await onSaved();
    } catch (e) {
      throw apiError(e);
    }
  };
  const remove = async () => {
    if (!confirm('Rimuovere il connettore Victron? Il token salvato viene cancellato dal server.')) return;
    await api('/api/admin/connectors/victron', { method: 'DELETE' });
    toast('Connettore Victron rimosso');
    await onSaved();
  };
  const r = test?.r;
  return (
    <Card title="Victron VRM" actions={<Badge tone={on ? 'good' : v.configured ? 'neutral' : 'warn'}>{on ? 'attivo' : v.configured ? 'disattivato' : 'non configurato'}</Badge>}>
      <p className="ui-muted ui-small cn-p">Impianti fotovoltaici e batterie che alimentano i POP: stato, allarmi e ultimo dato ricevuto, in sola lettura.</p>
      {v.updatedAt && (
        <p className="ui-muted ui-small cn-p">
          Ultima modifica {date(v.updatedAt)}
          {v.updatedBy ? ` · ${v.updatedBy}` : ''}
        </p>
      )}
      <label className="ui-check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        Connettore attivo
      </label>
      <div className="ui-grid-form">
        <Field label="Token di accesso VRM">
          <input type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} placeholder={v.tokenSet ? `Impostato (${v.tokenHint}): lascia vuoto per non cambiarlo` : 'Token di accesso'} />
        </Field>
      </div>
      <p className="ui-muted ui-small cn-p">
        Crea il token in VRM con l’utente che vede gli impianti dei POP: Preferenze → Integrazioni → Token di accesso. Il token resta cifrato sul server e non viene mai mostrato; il server legge soltanto, non cambia nulla in VRM. Gli installatori non vedono questa fonte.
      </p>
      <div className="ui-row">
        <AsyncButton onClick={runTest} onError={fail}>
          Testa connessione
        </AsyncButton>
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva
        </AsyncButton>
        {v.configured && (
          <AsyncButton variant="danger" onClick={remove} onError={fail}>
            Rimuovi configurazione
          </AsyncButton>
        )}
      </div>
      {test?.loading && <p className="ui-muted ui-small cn-p">Test in corso…</p>}
      {r &&
        (r.ok ? (
          <Notice tone={r.installations ? 'good' : 'warn'}>
            Token valido{r.user ? ` · utente ${r.user}` : ''} · {r.installations ?? 0} impianti visibili
            {r.installations ? ` · ${r.withAlarms ?? 0} con allarmi attivi · ${r.silent ?? 0} senza dati da oltre un’ora` : ': questo utente VRM non vede nessun impianto'} · {r.latencyMs} ms
          </Notice>
        ) : (
          <Notice tone="bad">
            {ERRORS[r.error ?? ''] ?? r.error}
            {r.status ? ` (HTTP ${r.status})` : ''}
            {r.detail && <div className="ui-mono ui-small">{r.detail}</div>}
          </Notice>
        ))}
      {on && <VictronSites />}
    </Card>
  );
}

type PowerStatus = 'ok' | 'warn' | 'alarm' | 'silent';
interface Site {
  idSite: number;
  name: string;
  lastTs: number | null;
  status: PowerStatus;
  soc: number | null;
  voltage: number | null;
  pvW: number | null;
  batteryState: 'charging' | 'discharging' | 'idle' | null;
  alarms: number;
  offGrid: boolean;
  /** VRM: no grid on the AC input of the GX. */
  offGridHint: boolean;
  popId: string | null;
  popName: string | null;
  suggestion: { popId: string; popName: string; distanceM: number | null } | null;
}
interface Sites {
  configured: boolean;
  running?: boolean;
  at: string | null;
  error: string | null;
  sites: Site[];
  pops: Array<{ id: string; name: string }>;
}
const STATUS: Record<PowerStatus, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  ok: { label: 'ok', tone: 'good' },
  warn: { label: 'batteria bassa', tone: 'warn' },
  alarm: { label: 'allarme', tone: 'bad' },
  silent: { label: 'nessun dato', tone: 'neutral' },
};
const BATTERY: Record<string, string> = { charging: 'in carica', discharging: 'in scarica', idle: 'a riposo' };
const ago = (ts: number | null) => {
  if (!ts) return 'mai';
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 60 ? `${m} min fa` : m < 48 * 60 ? `${Math.round(m / 60)} h fa` : `${Math.round(m / 1440)} giorni fa`;
};

/** The installations read from VRM and the POP each one powers, chosen by the admin. */
function VictronSites() {
  const q = useQuery({ queryKey: ['admin', 'victron'], queryFn: () => api<Sites>('/api/admin/victron'), refetchInterval: (x) => (x.state.data?.running ? 4000 : false) });
  const d = q.data;
  const link = async (s: Site, popId: string | null, offGrid?: boolean) => {
    try {
      // a new link starts from VRM's hint about the grid; then the admin's choice is kept
      const og = offGrid ?? (s.popId ? undefined : s.offGridHint);
      const r = await api<{ popName: string | null; offGrid: boolean }>(`/api/admin/victron/${s.idSite}/link`, { method: 'PUT', body: { popId, ...(og !== undefined && popId ? { offGrid: og } : {}) } });
      toast(r.popName ? `${s.name} → ${r.popName}${r.offGrid ? ' (off-grid)' : ''}` : `${s.name}: nessun POP`);
      await q.refetch();
    } catch (e) {
      throw apiError(e);
    }
  };
  if (!d) return null;
  const linked = d.sites.filter((s) => s.popId).length;
  return (
    <section className="cn-sec">
      <h3>Impianti e POP</h3>
      <p className="ui-muted ui-small cn-p">
        {d.at ? `Letti ${date(d.at)}: ${d.sites.length} impianti, ${linked} collegati a un POP.` : 'Non ancora letti: la prima lettura parte entro un minuto dal salvataggio, poi ogni 5 minuti.'} Scegli per ogni impianto il POP che alimenta: lo stato della batteria comparirà in Stato rete e in Guasti Enel. Il POP suggerito (dal GPS del GX entro 1 km o dal nome) va confermato. Segna «Off-grid» i POP alimentati solo dal fotovoltaico: un guasto Enel lì colpisce solo i clienti, non il POP.
      </p>
      {d.error && <Notice tone="warn">Ultima lettura non riuscita: {ERRORS[d.error] ?? d.error}</Notice>}
      <div className="ui-row">
        <AsyncButton
          onClick={async () => {
            try {
              await api('/api/admin/victron/sync', { method: 'POST' });
            } catch (e) {
              throw apiError(e);
            }
            await q.refetch();
            toast('Impianti riletti da VRM');
          }}
          onError={fail}
        >
          Rileggi ora
        </AsyncButton>
      </div>
      {d.sites.length > 0 && (
        <ul className="cn-modules">
          {d.sites.map((s) => (
            <li key={s.idSite}>
              <span>
                <b>{s.name}</b> <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                <span className="ui-muted ui-small">
                  {' '}
                  {s.soc !== null ? `${Math.round(s.soc)}%` : '—'}
                  {s.voltage !== null ? ` · ${s.voltage.toFixed(1)} V` : ''}
                  {s.batteryState ? ` · ${BATTERY[s.batteryState]}` : ''}
                  {s.pvW !== null ? ` · FV ${s.pvW} W` : ''}
                  {s.alarms ? ` · ${s.alarms} allarmi` : ''} · ultimo dato {ago(s.lastTs)}
                </span>
              </span>
              <span className="ui-row">
                <select aria-label={`POP alimentato da ${s.name}`} value={s.popId ?? ''} onChange={(e) => void link(s, e.target.value || null).catch(fail)}>
                  <option value="">Nessun POP</option>
                  {d.pops.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {s.popId && (
                  <label className="ui-check" title={s.offGridHint ? 'VRM: nessuna rete sull’ingresso AC del GX' : undefined}>
                    <input type="checkbox" checked={s.offGrid} onChange={(e) => void link(s, s.popId, e.target.checked).catch(fail)} />
                    Off-grid{s.offGridHint && !s.offGrid ? ' (VRM: senza rete?)' : ''}
                  </label>
                )}
                {s.suggestion && (
                  <AsyncButton onClick={() => link(s, s.suggestion!.popId)} onError={fail}>
                    {`Usa ${s.suggestion.popName}${s.suggestion.distanceM !== null ? ` (${s.suggestion.distanceM} m)` : ''}`}
                  </AsyncButton>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
