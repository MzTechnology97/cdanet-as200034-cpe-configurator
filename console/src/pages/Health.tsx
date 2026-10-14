import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from '../lib/toast';
import { isOn } from '../lib/modules';
import { api, download } from '../lib/api';
import { keys } from '../lib/query';
import type { PageContext } from '../shell/routes';
import { matches } from '../shell/search';
import { AsyncButton, Badge, Button, Card, EmptyState, Field, Icon, Notice, PageHeader, Skeleton, Stat } from '../ui';

/**
 * Salute CPE (admins: every customer CPE in UISP, with assignment to installers) / Le mie CPE
 * (installers: the CPEs they installed with the app plus those assigned to them). The same data
 * and the same rules as before (/api/cpe-health), shown as in the app: four tiles that filter,
 * the search, the other filters in a panel, one row per CPE.
 */

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';
const ISSUES: Record<string, [string, Tone]> = {
  offline: ['offline', 'bad'],
  not_in_uisp: ['non trovata in rete', 'bad'],
  weak_signal: ['segnale debole', 'bad'],
  signal_drop: ['segnale calato', 'warn'],
  ethernet: ['porta LAN', 'warn'],
  pending: ['da accettare', 'warn'],
  low_capacity: ['capacità bassa', 'warn'],
  firmware: ['firmware da aggiornare', 'neutral'],
};
/** Admins with the CRM connected: from the RADIUS state. */
const RADIUS_ISSUES: Record<string, [string, Tone]> = {
  pppoe_offline: ['PPPoE offline', 'bad'],
  account_suspended: ['account sospeso', 'warn'],
  account_terminated: ['cliente cessato', 'warn'],
};
const ALL_ISSUES = { ...ISSUES, ...RADIUS_ISSUES };
/** Firmware against the reference version (newer is fine; the M series cannot run airOS 8). */
const FW_STATE: Record<string, [string, Tone]> = { ok: ['aggiornato', 'good'], old: ['da aggiornare', 'warn'], legacy: ['serie M, non aggiornabile', 'neutral'], unknown: ['versione non letta', 'neutral'] };
/** Customer state from the RADIUS account and the CRM (admins with ISP Billing). */
const ACCOUNT_STATE: Record<string, [string, Tone]> = {
  online: ['attivo, PPPoE online', 'good'],
  offline: ['attivo, PPPoE offline', 'bad'],
  services_suspended: ['servizi sospesi', 'warn'],
  suspended: ['sospeso', 'warn'],
  terminating: ['in cessazione', 'warn'],
  terminated: ['cessato', 'bad'],
  unknown: ['stato non letto', 'neutral'],
};

interface Radius {
  username: string;
  state: string;
  online?: boolean | null;
  suspended?: boolean;
  customerName?: string;
  profile?: string;
  speed?: { down: number; up: number } | null;
  clientIp?: string;
}
interface Cpe {
  jobId?: string | null;
  deviceId?: string | null;
  source: 'app' | 'uisp';
  deviceName: string;
  mac: string;
  ssid?: string;
  model?: string;
  createdAt?: string;
  installer?: string;
  assignedTo?: { id: number; username: string } | null;
  acceptanceSignal?: number | null;
  signalDelta?: number | null;
  now?: { status?: string; signal?: number | null; apName?: string | null; ethMbps?: number | null; ethHalfDuplex?: boolean } | null;
  issues: string[];
  firmware?: { version: string; state: string } | null;
  radius?: Radius | null;
}
interface HealthData {
  generatedAt: string;
  uisp: boolean;
  thresholds: { signalDropDb: number };
  totals: Record<string, number>;
  cpes: Cpe[];
  installers?: Array<{ id: number; username: string }>;
  firmwareVersions?: Array<{ version: string; state: string; count: number }>;
  targetFirmware?: string;
  stale?: { count: number; months: number } | null;
}

type StateFilter = 'all' | 'online' | 'offline' | 'issues';
const PAGE = 100;
const planOf = (r?: Radius | null) => (r?.speed ? `${r.speed.down}M/${r.speed.up}M` : r?.profile || null);
const online = (c: Cpe) => c.now?.status === 'active';
// not found in the network: neither online nor offline (a problem of its own)
const offline = (c: Cpe) => !!c.now && c.now.status !== 'active';
const date = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('it-IT') : '');

export function Health({ user, params }: PageContext) {
  const admin = user.role === 'admin';
  const qc = useQueryClient();
  const [showStale, setShowStale] = useState(false);
  const health = useQuery({
    queryKey: [...keys.cpeHealth, showStale ? 'stale' : 'live'],
    queryFn: () => api<HealthData>(`/api/cpe-health${showStale ? '?stale=1' : ''}`),
    staleTime: 60_000,
  });
  // the shared list (search of the console) is this one too
  useEffect(() => {
    if (health.data && !showStale) qc.setQueryData(keys.cpeHealth, health.data);
  }, [health.data, showStale, qc]);

  const [q, setQ] = useState(params.get('q') ?? '');
  const [state, setState] = useState<StateFilter>(params.get('q') ? 'all' : 'issues');
  const [issue, setIssue] = useState('');
  const [origin, setOrigin] = useState('');
  const [fw, setFw] = useState('');
  const [account, setAccount] = useState('');
  const [plan, setPlan] = useState('');
  const [panel, setPanel] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setLimit(PAGE), [q, state, issue, origin, fw, account, plan]);

  const d = health.data;
  const cpes = d?.cpes ?? [];
  const withRadius = admin && cpes.some((c) => 'radius' in c);
  // every filter but the tiles: the tiles count within them, so their numbers match the list
  const base = useMemo(
    () =>
      cpes.filter(
        (c) =>
          (!issue || c.issues.includes(issue)) &&
          (origin === 'app' ? c.source === 'app' : origin === 'uisp' ? c.source === 'uisp' : origin === 'assigned' ? !!c.assignedTo : origin === 'unassigned' ? !c.assignedTo : true) &&
          (!fw || (fw.startsWith('v:') ? c.firmware?.version === fw.slice(2) : c.firmware?.state === fw)) &&
          (!account || (account === 'none' ? 'radius' in c && !c.radius : c.radius?.state === account)) &&
          (!plan || planOf(c.radius) === plan) &&
          (!q.trim() || matches(q, c.deviceName, c.mac, c.now?.apName, c.installer, c.ssid, c.assignedTo?.username, c.radius?.username, c.radius?.customerName, planOf(c.radius))),
      ),
    [cpes, issue, origin, fw, account, plan, q],
  );
  const inState = (c: Cpe, s: StateFilter) => (s === 'all' ? true : s === 'online' ? online(c) : s === 'offline' ? offline(c) : c.issues.length > 0);
  const rows = base.filter((c) => inState(c, state));
  const activeFilters = [issue, origin, fw, account, plan].filter(Boolean).length;

  const accountOptions = useMemo(() => {
    const n = (pred: (c: Cpe) => boolean) => cpes.filter(pred).length;
    return [...Object.entries(ACCOUNT_STATE).map(([k, [label]]) => [k, `${label} (${n((c) => c.radius?.state === k)})`] as const), ['none', `senza account PPPoE (${n((c) => 'radius' in c && !c.radius)})`] as const];
  }, [cpes]);
  const plans = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cpes) {
      const p = planOf(c.radius);
      if (p) m.set(p, (m.get(p) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [cpes]);

  const toggle = (mac: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(mac)) n.delete(mac);
      else n.add(mac);
      return n;
    });

  const headerActions = (
    <>
      <Button icon="refresh" busy={health.isFetching} onClick={() => void health.refetch()}>
        Aggiorna
      </Button>
      {isOn('csv_export') && (
        <AsyncButton onClick={() => download('/api/cpe-health.csv', 'salute-cpe.csv')} onError={(e) => toast((e as Error).message, 'bad')}>
          Esporta CSV
        </AsyncButton>
      )}
    </>
  );

  const title = admin ? 'Salute CPE' : 'Le mie CPE';
  const subtitle = admin
    ? 'Tutte le CPE dei clienti presenti in UISP: stato attuale, confronto con il collaudo per quelle installate con l’app, assegnazione agli installatori.'
    : 'Le CPE che hai installato con l’app e quelle che ti sono state assegnate.';

  if (health.error) {
    const code = (health.error as { body?: { error?: string } }).body?.error;
    return (
      <div className="ui-page">
        <PageHeader icon="monitor_heart" title={title} subtitle={subtitle} actions={headerActions} />
        <Notice tone="bad">{code === 'uisp_not_configured' ? (admin ? 'UISP non configurato: impostalo in Connettori.' : 'Servizio non disponibile: contatta l’amministratore.') : (health.error as Error).message}</Notice>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="ui-page">
        <PageHeader icon="monitor_heart" title={title} subtitle={subtitle} actions={headerActions} />
        <Skeleton lines={8} />
      </div>
    );
  }

  const t = d.totals;
  const cnt = (s: StateFilter) => base.filter((c) => inState(c, s)).length;
  return (
    <div className="ui-page">
      <PageHeader icon="monitor_heart" title={title} subtitle={subtitle} actions={headerActions} />

      <section className="ui-stats" aria-label="Stato">
        <Stat label="Tutte" value={cnt('all')} active={state === 'all'} onClick={() => setState('all')} />
        <Stat label="Online" value={cnt('online')} tone="good" active={state === 'online'} onClick={() => setState('online')} />
        <Stat label="Offline" value={cnt('offline')} tone="bad" active={state === 'offline'} onClick={() => setState('offline')} />
        <Stat label="Problemi" value={cnt('issues')} tone="warn" hint={`${t.ok ?? 0} senza problemi su ${t.cpes ?? 0}`} active={state === 'issues'} onClick={() => setState('issues')} />
      </section>

      {!d.uisp && <Notice tone="warn">{admin ? 'UISP non raggiungibile: stato attuale non disponibile.' : 'Stato attuale non disponibile, riprova più tardi.'}</Notice>}

      <div className="hl-toolbar">
        <label className="hl-search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={admin ? 'Cliente, MAC, AP, installatore, utente PPPoE…' : 'Cliente, MAC, AP…'} aria-label="Cerca" />
          {q && (
            <button type="button" className="hl-clear" onClick={() => setQ('')} aria-label="Cancella">
              <Icon name="close" />
            </button>
          )}
        </label>
        <Button icon="manage_search" variant={panel || activeFilters ? 'primary' : 'secondary'} onClick={() => setPanel(!panel)} aria-expanded={panel}>
          {activeFilters ? `Filtri (${activeFilters})` : 'Filtri'}
        </Button>
      </div>

      {panel && (
        <Card>
          <div className="hl-filters">
            <Field label="Problema">
              <select value={issue} onChange={(e) => setIssue(e.target.value)}>
                <option value="">Qualsiasi</option>
                {Object.entries(admin ? ALL_ISSUES : ISSUES).map(([k, [label]]) => (
                  <option key={k} value={k}>
                    {label} ({cpes.filter((c) => c.issues.includes(k)).length})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Origine">
              <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
                <option value="">Tutte le CPE</option>
                <option value="app">Installate con l’app</option>
                <option value="uisp">{admin ? 'Solo in UISP (installate prima o senza app)' : 'Assegnate a me'}</option>
                {admin && <option value="assigned">Assegnate a un installatore</option>}
                {admin && <option value="unassigned">Non assegnate</option>}
              </select>
            </Field>
            <Field label="Firmware">
              <select value={fw} onChange={(e) => setFw(e.target.value)}>
                <option value="">Tutti i firmware</option>
                {Object.entries(FW_STATE).map(([k, [label]]) => (
                  <option key={k} value={k}>
                    Firmware {label}
                  </option>
                ))}
                {(d.firmwareVersions ?? []).map((v) => (
                  <option key={v.version} value={`v:${v.version}`}>
                    Versione {v.version} ({v.count})
                  </option>
                ))}
              </select>
            </Field>
            {withRadius && (
              <>
                <Field label="Stato cliente (ISP Billing)">
                  <select value={account} onChange={(e) => setAccount(e.target.value)}>
                    <option value="">Tutti gli stati</option>
                    {accountOptions.map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Profilo RADIUS">
                  <select value={plan} onChange={(e) => setPlan(e.target.value)}>
                    <option value="">Tutti i profili</option>
                    {plans.map(([p, n]) => (
                      <option key={p} value={p}>
                        {p} ({n})
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>
          {/* admins only: the server does not send it to installers, who never see the gone CPEs */}
          {admin && d.stale && d.stale.count > 0 && (
            <label className="ui-check">
              <input type="checkbox" checked={showStale} onChange={(e) => setShowStale(e.target.checked)} />
              <span>
                Mostra anche le {d.stale.count} CPE offline da più di {d.stale.months} mesi (probabilmente clienti dismessi ancora in UISP; il limite si cambia in Impostazioni server)
              </span>
            </label>
          )}
          <div className="ui-row">
            <Button
              variant="ghost"
              disabled={!activeFilters && !showStale}
              onClick={() => {
                setIssue('');
                setOrigin('');
                setFw('');
                setAccount('');
                setPlan('');
                setShowStale(false);
              }}
            >
              Azzera filtri
            </Button>
          </div>
        </Card>
      )}

      {(d.firmwareVersions?.length ?? 0) > 0 && (
        <details className="ui-card ui-details">
          <summary>Firmware delle CPE · riferimento {d.targetFirmware}</summary>
          <div className="hl-fw">
            {d.firmwareVersions!.map((v) => (
              <button key={v.version} type="button" className={`hl-fw-chip${fw === `v:${v.version}` ? ' on' : ''}`} title={FW_STATE[v.state]?.[0]} onClick={() => setFw(fw === `v:${v.version}` ? '' : `v:${v.version}`)}>
                <Badge tone={FW_STATE[v.state]?.[1] ?? 'neutral'}>{v.version}</Badge>
                <span>{v.count}</span>
              </button>
            ))}
          </div>
          <p className="ui-muted ui-small">Uguale o più recente del riferimento è a posto, più vecchio è «da aggiornare». La serie M (airOS 6) non può passare all’8.x: è solo un’informazione. Clic su una versione per vedere quelle CPE.</p>
        </details>
      )}

      <Card padded={false}>
        <div className="hl-count">
          {rows.length ? `${rows.length} CPE` : 'Nessuna CPE'}
          {state !== 'all' && ` · ${state === 'issues' ? 'con problemi' : state}`}
          <span className="ui-muted">
            {' '}
            · stato del {new Date(d.generatedAt).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })} · «segnale calato»: almeno {d.thresholds.signalDropDb} dB sotto il collaudo
          </span>
        </div>
        {!rows.length ? (
          <EmptyState title={state === 'issues' && !q && !activeFilters ? 'Nessuna CPE con problemi' : 'Nessuna CPE con questi filtri'} />
        ) : (
          <ul className="hl-list">
            {rows.slice(0, limit).map((c) => (
              <CpeRow key={c.mac} c={c} admin={admin} withRadius={withRadius} selected={selected.has(c.mac)} onSelect={admin ? () => toggle(c.mac) : undefined} />
            ))}
          </ul>
        )}
        {rows.length > limit && (
          <div className="hl-more">
            <Button onClick={() => setLimit(limit + PAGE)}>Mostra altre {Math.min(PAGE, rows.length - limit)}</Button>
          </div>
        )}
      </Card>

      {admin && (
        <AssignBar
          installers={d.installers ?? []}
          selected={selected}
          visible={rows}
          onSelectAll={() => setSelected(new Set([...selected, ...rows.map((c) => c.mac)]))}
          onClear={() => setSelected(new Set())}
          onDone={async () => {
            setSelected(new Set());
            await health.refetch();
          }}
        />
      )}

      {withRadius && <RadiusPanel />}
    </div>
  );
}

function CpeRow({ c, admin, withRadius, selected, onSelect }: { c: Cpe; admin: boolean; withRadius: boolean; selected: boolean; onSelect?: () => void }) {
  const tone: Tone = c.issues.some((i) => ALL_ISSUES[i]?.[1] === 'bad') ? 'bad' : c.issues.length ? 'warn' : 'good';
  const plan = planOf(c.radius);
  return (
    <li className={`hl-row${selected ? ' selected' : ''}`}>
      {onSelect && <input type="checkbox" className="hl-check" checked={selected} onChange={onSelect} aria-label={`Seleziona ${c.deviceName || c.mac}`} />}
      <span className={`hl-dot ui-tone-${tone}`} aria-hidden="true" />
      <div className="hl-main">
        <div className="hl-name">
          <strong>{c.deviceName || c.mac}</strong>
          <span className="ui-mono ui-small ui-muted">{c.mac}</span>
        </div>
        <div className="hl-sub">
          {c.now?.apName ?? c.ssid ?? '—'}
          {c.now?.ethMbps ? ` · LAN ${c.now.ethMbps}${c.now.ethHalfDuplex ? ' half' : ''}` : ''}
          {c.firmware ? ` · ${c.firmware.version}` : ''}
          {' · '}
          {c.source === 'app' ? `app ${date(c.createdAt)}${admin && c.installer ? ` (${c.installer})` : ''}` : admin ? 'UISP' : 'assegnata'}
          {admin && c.assignedTo ? ` · assegnata a ${c.assignedTo.username}` : ''}
        </div>
        <div className="ui-row hl-badges">
          {c.issues.length ? c.issues.map((i) => <Badge key={i} tone={ALL_ISSUES[i]?.[1] ?? 'neutral'}>{ALL_ISSUES[i]?.[0] ?? i}</Badge>) : <Badge tone="good">ok</Badge>}
          {withRadius && c.radius && <PppoeBadge r={c.radius} />}
          {withRadius && plan && <Badge tone="info">{plan}</Badge>}
        </div>
      </div>
      <div className="hl-signal">
        <strong>{c.now?.signal != null ? `${c.now.signal} dBm` : '—'}</strong>
        {c.acceptanceSignal != null && (
          <span className="ui-small ui-muted">
            collaudo {c.acceptanceSignal}
            {c.signalDelta != null && c.signalDelta !== 0 && <span className={c.signalDelta < 0 ? 'hl-down' : 'hl-up'}> ({c.signalDelta > 0 ? '+' : ''}{c.signalDelta})</span>}
          </span>
        )}
      </div>
      <div className="hl-actions">
        {/* admins: the CPE as in the UISP app (detail, restart, firmware, backups…) */}
        {admin && c.deviceId && (
          <a className="ui-btn ui-btn-secondary" href={`#/cpe?id=${encodeURIComponent(c.deviceId)}`}>
            Gestisci
          </a>
        )}
        {c.jobId && (
          <a className="ui-btn ui-btn-ghost" href={`#/jobs?q=${encodeURIComponent(c.mac)}`}>
            Storico
          </a>
        )}
      </div>
    </li>
  );
}

function PppoeBadge({ r }: { r: Radius }) {
  const [label, tone]: [string, Tone] =
    r.state === 'terminated' ? ['PPPoE cessato', 'neutral'] : r.state === 'terminating' ? ['in cessazione', 'warn'] : r.suspended ? ['PPPoE sospeso', 'warn'] : r.online === true ? ['PPPoE online', 'good'] : r.online === false ? ['PPPoE offline', 'bad'] : ['PPPoE ?', 'neutral'];
  return (
    <span title={[r.username, r.customerName, r.clientIp].filter(Boolean).join(' · ')}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

/** Admin: assign the selected CPEs to an installer (or remove the assignment); shown with a selection. */
function AssignBar({ installers, selected, visible, onSelectAll, onClear, onDone }: { installers: Array<{ id: number; username: string }>; selected: Set<string>; visible: Cpe[]; onSelectAll: () => void; onClear: () => void; onDone: () => Promise<void> }) {
  const [who, setWho] = useState('');
  const send = async (userId: number | null) => {
    if (!selected.size) throw new Error('Seleziona almeno una CPE');
    await api('/api/admin/cpe-assignments', { method: 'PUT', body: { macs: [...selected], userId } });
    toast(userId ? `${selected.size} CPE assegnate` : `Assegnazione rimossa da ${selected.size} CPE`);
    await onDone();
  };
  const err = (e: unknown) => toast((e as Error).message, 'bad');
  if (!selected.size) {
    return (
      <p className="ui-muted ui-small">
        Per assegnare CPE a un installatore spuntale nell’elenco (o{' '}
        <button type="button" className="ui-link" onClick={onSelectAll}>
          seleziona tutte le {visible.length} filtrate
        </button>
        ): compariranno in «Le mie CPE» dell’installatore, sito e app.
      </p>
    );
  }
  return (
    <div className="hl-assign" role="region" aria-label="Assegna CPE">
      <strong>{selected.size} selezionate</strong>
      <Button variant="ghost" onClick={onSelectAll}>
        Tutte le filtrate ({visible.length})
      </Button>
      <Button variant="ghost" onClick={onClear}>
        Deseleziona
      </Button>
      <span className="cx-spacer" />
      <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Installatore">
        <option value="">— scegli installatore —</option>
        {installers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.username}
          </option>
        ))}
      </select>
      <AsyncButton
        variant="primary"
        onClick={async () => {
          if (!who) throw new Error('Scegli l’installatore');
          await send(Number(who));
        }}
        onError={err}
      >
        Assegna
      </AsyncButton>
      <AsyncButton onClick={() => send(null)} onError={err}>
        Rimuovi assegnazione
      </AsyncButton>
    </div>
  );
}

interface RadiusRow extends Radius {
  accountStatus?: string;
  customerStatus?: string;
  servicesSuspended?: boolean;
  mac?: string | null;
  cpe?: { name: string; apName?: string | null; status?: string } | null;
}

/** Sessions of the NOC: offline, suspended or with no CPE found (/api/admin/crm/radius). */
function RadiusPanel() {
  const [which, setWhich] = useState('offline');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const r = useQuery({
    queryKey: ['crm', 'radius', which, term],
    queryFn: () => api<{ total: number; rows: RadiusRow[]; at: string | null; running?: boolean; error?: string }>(`/api/admin/crm/radius?filter=${which}&q=${encodeURIComponent(term)}&limit=300`),
  });
  return (
    <Card title="Account PPPoE">
      <p className="ui-muted">Lo stato delle sessioni RADIUS, anche dei clienti senza CPE in rete. Aggiornato ogni 10 minuti (Connettori → CRM per sincronizzare subito).</p>
      <div className="hl-filters">
        <Field label="Mostra">
          <select value={which} onChange={(e) => setWhich(e.target.value)}>
            <option value="offline">PPPoE offline (account attivo)</option>
            <option value="suspended">Sospesi (account, cliente o servizio)</option>
            <option value="unmatched">Senza CPE in rete (router o ONT del cliente)</option>
            <option value="terminated">Cessati con la CPE ancora in rete</option>
            <option value="all">Tutti gli account</option>
          </select>
        </Field>
        <Field label="Cerca">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Utente, cliente, IP, AP…" />
        </Field>
      </div>
      {r.error ? (
        <Notice tone="bad">{(r.error as Error).message}</Notice>
      ) : !r.data ? (
        <Skeleton lines={4} />
      ) : (
        <>
          <p className="ui-muted ui-small">
            {r.data.total} account · RADIUS aggiornato {r.data.at ? new Date(r.data.at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : 'mai'}
            {r.data.running ? ' · sincronizzazione in corso…' : ''}
            {r.data.error ? ` · ultimo errore: ${r.data.error}` : ''}
          </p>
          {!r.data.rows.length ? (
            <Notice tone="good">Nessun account per questo filtro.</Notice>
          ) : (
            <ul className="hl-list">
              {r.data.rows.map((x) => (
                <li key={x.username} className="hl-row">
                  <div className="hl-main">
                    <div className="hl-name">
                      <strong className="ui-mono">{x.username}</strong>
                      <PppoeBadge r={x} />
                    </div>
                    <div className="hl-sub">{[x.customerName, planOf(x), x.clientIp, x.accountStatus, x.customerStatus && x.customerStatus !== 'active' ? `cliente ${x.customerStatus}` : null, x.servicesSuspended ? 'servizio sospeso' : null].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div className="hl-signal">
                    {x.cpe ? (
                      <>
                        <strong>{x.cpe.name}</strong>
                        <span className="ui-small ui-muted">{[x.cpe.apName, x.cpe.status].filter(Boolean).join(' · ')}</span>
                      </>
                    ) : (
                      <span className="ui-small ui-muted">CPE non trovata</span>
                    )}
                    {x.mac && <span className="ui-mono ui-small ui-muted">{x.mac}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {r.data.total > r.data.rows.length && <p className="ui-muted ui-small">Mostrati i primi {r.data.rows.length}: usa la ricerca.</p>}
        </>
      )}
    </Card>
  );
}
