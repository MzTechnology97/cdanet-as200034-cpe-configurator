import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { download } from '../../../web/js/api.js';
import { toast } from '../../../web/js/dom.js';
import { signalChart } from '../../../web/js/views/uisp-panel.js';
import { api } from '../lib/api';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Card, Dom, Field, Icon, Notice, PageHeader, Segmented, Skeleton, Tabs } from '../ui';

/**
 * Gestione CPE (admins): one customer CPE as in the UISP app, through the UISP API (overview,
 * radio, the customer from ISP Billing, signal history, interfaces, firmware, backups, UISP
 * settings) and its actions: refresh, restart, firmware upgrade, backup and restore, wireless
 * parameters, alias/note/maintenance. Every action asks first and goes into the activity log;
 * Wi-Fi keys and the PPPoE password never reach the browser.
 */

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';
const STATUS: Record<string, [string, Tone]> = { active: ['online', 'good'], disconnected: ['offline', 'bad'], inactive: ['inattiva', 'bad'], unauthorized: ['da accettare', 'warn'] };
const ACCOUNT: Record<string, [string, Tone]> = {
  online: ['attivo, PPPoE online', 'good'],
  offline: ['attivo, PPPoE offline', 'bad'],
  services_suspended: ['servizi sospesi', 'warn'],
  suspended: ['sospeso', 'warn'],
  terminating: ['in cessazione', 'warn'],
  terminated: ['cessato', 'bad'],
  unknown: ['stato non letto', 'neutral'],
};

interface Wireless {
  ssid?: string | null;
  txPower?: number | null;
  txPowerRange?: { min: number; max: number } | null;
  atpc?: boolean;
  antennaGain?: number | null;
  cableLoss?: number | null;
  ackAuto?: boolean;
  ackDistanceM?: number | null;
  autoChannelWidth?: boolean;
  channelWidth?: number | null;
  channelWidths: number[];
}
interface Cpe {
  id: string;
  name: string;
  alias?: string | null;
  note?: string | null;
  maintenance: boolean;
  model?: string;
  modelName?: string;
  mac?: string;
  ip?: string;
  serial?: string;
  status: string;
  online: boolean;
  lastSeen?: string | null;
  uptimeSec?: number | null;
  cpu?: number | null;
  ram?: number | null;
  temperature?: number | null;
  ap?: string | null;
  site?: string | null;
  firmware: { current?: string; upgradeTo?: string | null; canUpgrade?: boolean; compatible?: boolean; upgradeStatus?: string | null; upgradeProgress?: number | null };
  radio: Record<string, string | number | boolean | null | undefined> & { autoChannelWidth?: boolean; distanceM?: number | null; downlinkMbps?: number | null; uplinkMbps?: number | null };
  interfaces: Array<{ name: string; type: string; enabled?: boolean; plugged?: boolean; speed?: string | null; addresses: string[] }>;
  wireless?: Wireless | null;
}
interface CrmLine {
  site?: string | null;
  username: string;
  state: string;
  profile?: string;
  speed?: { down: number; up: number } | null;
  cpe?: { deviceId: string; name: string; customer?: boolean } | null;
}
interface Crm {
  account: { username: string; state: string; status?: string; profile?: string; speed?: { down: number; up: number } | null; clientIp?: string; staticIp?: string; checkedAt?: string };
  customer: { name?: string; code?: string; status?: string; group?: string; type?: string; phone?: string; phone2?: string; email?: string; address?: string };
  site?: { description?: string; address?: string; lat?: number | null; lon?: number | null } | null;
  lines?: CrmLine[];
}
interface Detail {
  cpe: Cpe;
  job?: { createdAt: string } | null;
  crm?: Crm | null;
  backups: Array<{ id: string; timestamp: string; type?: string }>;
}

const v = (x: unknown, unit = '') => (x == null || x === '' ? '—' : `${x}${unit}`);
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const dur = (s?: number | null) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d} g ${h} h` : `${h} h ${Math.floor((s % 3600) / 60)} min`;
};
const plan = (x?: { speed?: { down: number; up: number } | null; profile?: string }) => (x?.speed ? `${x.speed.down}M/${x.speed.up}M` : v(x?.profile));

type Tab = 'overview' | 'radio' | 'customer' | 'history' | 'interfaces' | 'firmware' | 'uisp';

export function CpeAdmin({ params }: PageContext) {
  const id = params.get('id') ?? '';
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const q = useQuery({ queryKey: ['admin', 'cpe', id], queryFn: () => api<Detail>(`/api/admin/cpe/${encodeURIComponent(id)}`), enabled: !!id });
  const reload = (ms: number) => setTimeout(() => void qc.invalidateQueries({ queryKey: ['admin', 'cpe', id] }), ms);

  /** An action on the CPE: question, call, message, read the CPE again after [ms]. */
  const act = async (question: string | null, path: string, done: string | ((r: Record<string, string>) => string), opts: { method?: string; body?: unknown; delay?: number } = {}) => {
    if (question && !confirm(question)) return;
    const r = await api<Record<string, string>>(`/api/admin/cpe/${encodeURIComponent(id)}${path}`, { method: opts.method ?? 'POST', body: opts.body });
    toast(typeof done === 'function' ? done(r) : done);
    reload(opts.delay ?? 1500);
  };
  const fail = (e: unknown) => toast((e as Error).message, 'bad');

  const back = (
    <a className="ui-btn ui-btn-ghost" href="#/health">
      <Icon name="chevron_left" />
      Salute CPE
    </a>
  );
  if (!id) return <Notice tone="bad">CPE non indicata.</Notice>;
  if (q.error)
    return (
      <div className="ui-page">
        <PageHeader icon="monitor_heart" title="Gestione CPE" actions={back} />
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      </div>
    );
  if (!q.data)
    return (
      <div className="ui-page">
        <PageHeader icon="monitor_heart" title="Gestione CPE" subtitle="Caricamento dalla rete…" actions={back} />
        <Skeleton lines={8} />
      </div>
    );

  const d = q.data;
  const c = d.cpe;
  const st = STATUS[c.status] ?? [c.status, 'neutral'];
  const fw = c.firmware;
  const r = c.radio;

  return (
    <div className="ui-page">
      <PageHeader icon="monitor_heart" title={c.alias || c.name || c.mac || c.id} subtitle={[c.modelName || c.model, c.mac, c.ip].filter(Boolean).join(' · ')} actions={back} />

      <div className="cp-bar">
        <Badge tone={st[1]}>{st[0]}</Badge>
        <span className="ui-muted ui-small">{c.online ? `acceso da ${dur(c.uptimeSec)}` : `ultimo contatto ${when(c.lastSeen)}`}</span>
        <span className="cx-spacer" />
        <AsyncButton icon="refresh" onClick={() => act(null, '/refresh', 'Stato richiesto a UISP', { delay: 3000 })} onError={fail}>
          Aggiorna stato
        </AsyncButton>
        <AsyncButton
          variant="danger"
          onClick={() =>
            act(
              c.online ? `Riavviare ${c.name}? Il cliente resta senza Internet per circa un minuto.` : `${c.name} è offline: il riavvio arriva solo se torna raggiungibile. Inviarlo comunque?`,
              '/restart',
              c.online ? 'Riavvio inviato: la CPE torna online in circa un minuto' : 'Comando inviato a UISP (CPE offline)',
              { delay: 5000 },
            )
          }
          onError={fail}
        >
          Riavvia
        </AsyncButton>
      </div>

      {!c.online && <Notice tone="warn">{`CPE offline${c.lastSeen ? ` dal ${when(c.lastSeen)}` : ''}: UISP accetta i comandi ma arrivano solo se torna raggiungibile. Aggiornamento firmware, ripristino del backup e parametri wireless sono disponibili solo online.`}</Notice>}
      {c.maintenance && <Notice tone="info">In manutenzione su UISP: gli avvisi di questa CPE sono sospesi.</Notice>}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Panoramica' },
          { value: 'radio', label: 'Radio' },
          ...(d.crm !== undefined ? [{ value: 'customer' as Tab, label: 'Cliente' }] : []),
          { value: 'history', label: 'Storico segnale' },
          { value: 'interfaces', label: 'Interfacce' },
          { value: 'firmware', label: 'Firmware e backup', badge: c.online && fw.canUpgrade && fw.upgradeTo ? <Badge tone="warn">1</Badge> : undefined },
          { value: 'uisp', label: 'Gestione in UISP' },
        ]}
      />

      {tab === 'overview' && (
        <Card>
          <Facts
            rows={[
              ['Stato', <Badge tone={st[1]}>{st[0]}</Badge>],
              ['Ultimo contatto', when(c.lastSeen)],
              ['Acceso da', dur(c.uptimeSec)],
              ['CPU / RAM', `${v(c.cpu, '%')} / ${v(c.ram, '%')}`],
              ['Temperatura', v(c.temperature, ' °C')],
              ['AP', v(c.ap)],
              ['Site', v(c.site)],
              ['Segnale', v(r.signal, ' dBm')],
              ['Firmware', v(fw.current)],
              ['Seriale', v(c.serial)],
            ]}
          />
          {d.job && (
            <p className="ui-small">
              Installata con l’app: <a href={`#/jobs?q=${encodeURIComponent(c.mac ?? '')}`}>storico del {when(d.job.createdAt)}</a>
            </p>
          )}
        </Card>
      )}

      {tab === 'radio' && (
        <Card>
          <Facts
            rows={[
              ['Modalità', v(r.mode)],
              ['Frequenza', v(r.frequency, ' MHz')],
              ['Larghezza canale', r.autoChannelWidth ? 'automatica' : v(r.channelWidth, ' MHz')],
              ['Segnale', v(r.signal, ' dBm')],
              ['Segnale lato AP', v(r.remoteSignal, ' dBm')],
              ['Distanza dall’AP', r.distanceM != null ? (r.distanceM >= 1000 ? `${(r.distanceM / 1000).toFixed(2).replace('.', ',')} km` : `${r.distanceM} m`) : '—'],
              ['Potenza TX', v(r.txPower, ' dBm')],
              ['Guadagno antenna', v(r.antennaGain, ' dBi')],
              ['Capacità ↓ / ↑', r.downlinkMbps != null ? `${r.downlinkMbps} / ${v(r.uplinkMbps)} Mbit/s` : '—'],
              ['SSID', v(r.ssid)],
              ['Sicurezza', v(r.security)],
              ['Distanza ACK', v(r.ackDistanceM, ' m')],
            ]}
          />
          {c.wireless ? <WirelessEditor c={c} onApply={(body, question) => act(question, '/wireless', 'Parametri inviati alla CPE', { method: 'PUT', body, delay: 6000 })} /> : !c.online ? <p className="ui-muted ui-small">Configurazione wireless disponibile solo con la CPE online.</p> : null}
        </Card>
      )}

      {tab === 'customer' && <CustomerCard crm={d.crm} />}

      {tab === 'history' && <SignalHistory id={id} />}

      {tab === 'interfaces' && (
        <Card padded={false}>
          <ul className="hl-list">
            {c.interfaces.map((i) => (
              <li key={i.name} className="hl-row">
                <div className="hl-main">
                  <div className="hl-name">
                    <strong>{i.name}</strong>
                    <span className="ui-muted ui-small">{i.type}</span>
                  </div>
                  <div className="hl-sub">{i.addresses.length ? i.addresses.join(', ') : 'nessun indirizzo'}</div>
                </div>
                <div className="hl-signal">
                  {i.enabled === false ? <Badge>disattivata</Badge> : i.plugged ? <Badge tone="good">collegata</Badge> : <Badge tone="warn">scollegata</Badge>}
                  <span className="ui-small ui-muted">{v(i.speed)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {tab === 'firmware' && (
        <>
          <Card title="Firmware">
            <p>
              Installato <strong>{v(fw.current)}</strong>
              {fw.upgradeTo ? ` · disponibile in UISP ${fw.upgradeTo}` : ''}
              {fw.compatible === false && (
                <>
                  {' '}
                  <Badge tone="bad">non compatibile</Badge>
                </>
              )}
              {fw.upgradeStatus ? ` · ultimo aggiornamento: ${fw.upgradeStatus}${fw.upgradeProgress ? ` (${fw.upgradeProgress}%)` : ''}` : ''}
            </p>
            <div className="ui-row">
              <AsyncButton
                variant="primary"
                disabled={!c.online || !fw.canUpgrade || !fw.upgradeTo}
                onClick={() =>
                  act(
                    `Aggiornare il firmware di ${c.name} da ${fw.current} a ${fw.upgradeTo}? La CPE si riavvia: il cliente resta senza Internet per qualche minuto. Non spegnerla durante l’aggiornamento.`,
                    '/upgrade',
                    (res) => `Aggiornamento avviato: ${res.from ?? '?'} → ${res.to ?? 'ultima versione'}`,
                    { delay: 8000 },
                  )
                }
                onError={fail}
              >
                {fw.upgradeTo ? `Aggiorna a ${fw.upgradeTo}` : 'Nessun aggiornamento'}
              </AsyncButton>
            </div>
            <p className="ui-muted ui-small">Porta la CPE all’ultima versione che UISP ha per questo modello. Solo con la CPE online; durante l’aggiornamento la CPE si riavvia.</p>
          </Card>
          <Card
            title="Backup della configurazione"
            actions={
              <AsyncButton onClick={() => act(null, '/backups', 'Backup richiesto: compare nell’elenco tra poco', { delay: 6000 })} onError={fail}>
                Crea backup ora
              </AsyncButton>
            }
          >
            {d.backups.length ? (
              <ul className="hl-list cp-backups">
                {d.backups.map((b) => (
                  <li key={b.id} className="hl-row">
                    <div className="hl-main">
                      <strong>{when(b.timestamp)}</strong>
                      <span className="hl-sub">{v(b.type)}</span>
                    </div>
                    <div className="hl-actions">
                      <AsyncButton variant="ghost" onClick={() => download(`/api/admin/cpe/${encodeURIComponent(id)}/backups/${encodeURIComponent(b.id)}`, `backup-${b.id}.cfg`)} onError={fail}>
                        Scarica
                      </AsyncButton>
                      <AsyncButton
                        variant="danger"
                        disabled={!c.online}
                        onClick={() =>
                          act(
                            `Ripristinare su ${c.name} la configurazione del ${when(b.timestamp)}? La CPE si riavvia con quella configurazione: se è sbagliata il cliente può restare senza Internet.`,
                            `/backups/${encodeURIComponent(b.id)}/apply`,
                            'Ripristino inviato',
                            { delay: 8000 },
                          )
                        }
                        onError={fail}
                      >
                        Ripristina
                      </AsyncButton>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ui-muted">Nessun backup in UISP.</p>
            )}
          </Card>
        </>
      )}

      {tab === 'uisp' && <UispMeta c={c} onSave={(body) => act(null, '/meta', 'Salvato in UISP', { method: 'PUT', body })} />}

      <p className="ui-muted ui-small">Ogni azione è registrata nel Registro attività. Le chiavi Wi-Fi della CPE restano sul server.</p>
    </div>
  );
}

/** Wireless parameters: only the changed ones are sent; the server rewrites the rest as it is. */
function WirelessEditor({ c, onApply }: { c: Cpe; onApply: (body: Record<string, unknown>, question: string) => Promise<void> }) {
  const w = c.wireless!;
  const [f, setF] = useState({
    ssid: w.ssid ?? '',
    tx: w.txPower != null ? String(w.txPower) : '',
    atpc: !!w.atpc,
    gain: w.antennaGain != null ? String(w.antennaGain) : '',
    cable: String(w.cableLoss ?? 0),
    ackAuto: !!w.ackAuto,
    ack: w.ackDistanceM != null ? String(w.ackDistanceM) : '',
    cwAuto: !!w.autoChannelWidth,
    cw: String(w.channelWidth ?? ''),
  });
  const n = (s: string) => (s === '' ? null : Number(s));
  const body: Record<string, unknown> = {};
  if (f.ssid.trim() && f.ssid.trim() !== (w.ssid ?? '')) body.ssid = f.ssid.trim();
  if (n(f.tx) !== null && n(f.tx) !== w.txPower) body.txPower = n(f.tx);
  if (f.atpc !== !!w.atpc) body.atpc = f.atpc;
  if (n(f.gain) !== null && n(f.gain) !== w.antennaGain) body.antennaGain = n(f.gain);
  if (n(f.cable) !== null && n(f.cable) !== (w.cableLoss ?? 0)) body.cableLoss = n(f.cable);
  if (f.ackAuto !== !!w.ackAuto) body.ackAuto = f.ackAuto;
  if (!f.ackAuto && n(f.ack) !== null && n(f.ack) !== w.ackDistanceM) body.ackDistanceM = n(f.ack);
  if (f.cwAuto !== !!w.autoChannelWidth) body.autoChannelWidth = f.cwAuto;
  if (!f.cwAuto && n(f.cw) !== null && n(f.cw) !== w.channelWidth) body.channelWidth = n(f.cw);
  const changes = Object.keys(body).length;
  const widths = w.channelWidths.length ? w.channelWidths : [w.channelWidth].filter((x): x is number => x != null);
  return (
    <details className="ui-details cp-wireless">
      <summary>Modifica parametri wireless</summary>
      <div className="ui-grid-form">
        <Field label="SSID a cui agganciarsi">
          <input value={f.ssid} maxLength={32} onChange={(e) => setF({ ...f, ssid: e.target.value })} />
        </Field>
        <Field label={`Potenza TX (dBm${w.txPowerRange ? `, ${w.txPowerRange.min}…${w.txPowerRange.max}` : ''})`}>
          <input type="number" step={1} min={w.txPowerRange?.min} max={w.txPowerRange?.max} value={f.tx} onChange={(e) => setF({ ...f, tx: e.target.value })} />
        </Field>
        <Field label="Guadagno antenna (dBi)">
          <input type="number" step={0.5} min={0} max={40} value={f.gain} onChange={(e) => setF({ ...f, gain: e.target.value })} />
        </Field>
        <Field label="Perdita cavo (dB)">
          <input type="number" step={0.5} min={0} max={20} value={f.cable} onChange={(e) => setF({ ...f, cable: e.target.value })} />
        </Field>
      </div>
      <label className="ui-check">
        <input type="checkbox" checked={f.atpc} onChange={(e) => setF({ ...f, atpc: e.target.checked })} />
        <span>Controllo automatico della potenza (ATPC)</span>
      </label>
      <div className="ui-grid-form">
        <div className="cp-auto">
          <label className="ui-check">
            <input type="checkbox" checked={f.ackAuto} onChange={(e) => setF({ ...f, ackAuto: e.target.checked })} />
            <span>Distanza ACK automatica</span>
          </label>
          <Field label="Distanza ACK (m)">
            <input type="number" step={100} min={100} max={100000} disabled={f.ackAuto} value={f.ack} onChange={(e) => setF({ ...f, ack: e.target.value })} />
          </Field>
        </div>
        <div className="cp-auto">
          <label className="ui-check">
            <input type="checkbox" checked={f.cwAuto} onChange={(e) => setF({ ...f, cwAuto: e.target.checked })} />
            <span>Larghezza di canale automatica</span>
          </label>
          <Field label="Larghezza di canale">
            <select disabled={f.cwAuto} value={f.cw} onChange={(e) => setF({ ...f, cw: e.target.value })}>
              {widths.map((x) => (
                <option key={x} value={x}>
                  {x} MHz
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <div className="ui-row">
        <AsyncButton
          variant="primary"
          disabled={!changes}
          onClick={() =>
            onApply(
              body,
              `Applicare ${changes === 1 ? 'la modifica' : `le ${changes} modifiche`} ai parametri wireless di ${c.name}?${body.ssid ? ` La CPE si aggancerà alla rete "${String(body.ssid)}".` : ''} La CPE può scollegarsi per qualche secondo; un valore sbagliato (SSID, larghezza di canale) può lasciare il cliente senza Internet.`,
            )
          }
          onError={(e) => toast((e as Error).message, 'bad')}
        >
          {changes ? `Applica ${changes === 1 ? '1 modifica' : `${changes} modifiche`} alla CPE` : 'Nessuna modifica'}
        </AsyncButton>
      </div>
      <p className="ui-muted ui-small">Il server rilegge la configurazione dalla CPE e cambia solo questi valori: chiavi Wi-Fi e altri parametri restano come sono. Solo con la CPE online.</p>
    </details>
  );
}

/** The customer of the CPE in ISP Billing: record, installation site, PPPoE account and plan, other lines. */
function CustomerCard({ crm }: { crm?: Crm | null }) {
  if (crm === undefined) return null; // CRM not connected
  if (crm === null) return <Notice tone="info">Nessun account PPPoE di ISP Billing collegato a questa CPE (né per MAC della sessione né per l’utente PPPoE dell’installazione).</Notice>;
  const a = crm.account;
  const cu = crm.customer;
  const st = ACCOUNT[a.state] ?? [a.state, 'neutral'];
  return (
    <>
      <Card title={cu.name || 'Cliente'} actions={<Badge tone={st[1]}>{st[0]}</Badge>}>
        <Facts
          rows={[
            ['Codice', v(cu.code)],
            ['Utente PPPoE', <span className="ui-mono">{a.username}</span>],
            ['Profilo', plan(a)],
            ['Account', v(a.status)],
            ['IP della sessione', v(a.clientIp)],
            ['IP statico', v(a.staticIp)],
            ['Stato cliente', v(cu.status)],
            ['Gruppo', v(cu.group)],
            ['Tipo', v(cu.type)],
          ]}
        />
        <div className="cp-contacts">
          {cu.phone && (
            <a className="ui-btn ui-btn-secondary" href={`tel:${cu.phone.replace(/\s+/g, '')}`}>
              Chiama {cu.phone}
            </a>
          )}
          {cu.phone2 && (
            <a className="ui-btn ui-btn-ghost" href={`tel:${cu.phone2.replace(/\s+/g, '')}`}>
              {cu.phone2}
            </a>
          )}
          {cu.email && (
            <a className="ui-btn ui-btn-ghost" href={`mailto:${cu.email}`}>
              {cu.email}
            </a>
          )}
        </div>
        {cu.address && <p className="ui-small">Residenza: {cu.address}</p>}
        {crm.site && <p className="ui-small">Sede di installazione: {[crm.site.description, crm.site.address].filter(Boolean).join(' · ') || '—'}</p>}
        <p className="ui-muted ui-small">Dati di ISP Billing{a.checkedAt ? ` aggiornati il ${when(a.checkedAt)}` : ''}. La password PPPoE non viene mostrata.</p>
      </Card>
      {(crm.lines?.length ?? 0) > 0 && (
        <Card title={`Altre linee del cliente (${crm.lines!.length})`} padded={false}>
          <ul className="hl-list">
            {crm.lines!.map((l) => (
              <li key={l.username} className="hl-row">
                <div className="hl-main">
                  <strong>{v(l.site)}</strong>
                  <span className="hl-sub">
                    <span className="ui-mono">{l.username}</span> · {plan(l)} · {l.cpe ? l.cpe.name : 'CPE non trovata in UISP'}
                  </span>
                </div>
                <div className="hl-actions">
                  <Badge tone={ACCOUNT[l.state]?.[1] ?? 'neutral'}>{ACCOUNT[l.state]?.[0] ?? l.state}</Badge>
                  {l.cpe?.customer && (
                    <a className="ui-btn ui-btn-secondary" href={`#/cpe?id=${encodeURIComponent(l.cpe.deviceId)}`}>
                      Gestisci
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function SignalHistory({ id }: { id: string }) {
  const [range, setRange] = useState<'day' | 'week' | 'month'>('week');
  const s = useQuery({ queryKey: ['admin', 'cpe', id, 'statistics', range], queryFn: () => api(`/api/admin/cpe/${encodeURIComponent(id)}/statistics?range=${range}`) });
  return (
    <Card title="Storico segnale" actions={<Segmented label="Periodo" value={range} onChange={setRange} options={[{ value: 'day', label: '24 ore' }, { value: 'week', label: 'Settimana' }, { value: 'month', label: 'Mese' }]} />}>
      {s.error ? <p className="ui-muted">Storico non disponibile: {(s.error as Error).message}</p> : !s.data ? <Skeleton lines={4} /> : <Dom make={() => signalChart(s.data)} deps={[s.data]} />}
      <p className="ui-muted ui-small">Linea piena: segnale della CPE; tratteggiata: segnale lato AP; linee guida verde e rossa: soglie di Impostazioni server.</p>
    </Card>
  );
}

function UispMeta({ c, onSave }: { c: Cpe; onSave: (body: { alias: string | null; note: string | null; maintenance: boolean }) => Promise<void> }) {
  const [alias, setAlias] = useState(c.alias ?? '');
  const [note, setNote] = useState(c.note ?? '');
  const [maint, setMaint] = useState(c.maintenance);
  useEffect(() => {
    setAlias(c.alias ?? '');
    setNote(c.note ?? '');
    setMaint(c.maintenance);
  }, [c.alias, c.note, c.maintenance]);
  return (
    <Card title="Gestione in UISP">
      <Field label="Alias (nome mostrato in UISP)">
        <input value={alias} maxLength={100} placeholder={c.name} onChange={(e) => setAlias(e.target.value)} />
      </Field>
      <Field label="Note">
        <textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <label className="ui-check">
        <input type="checkbox" checked={maint} onChange={(e) => setMaint(e.target.checked)} />
        <span>In manutenzione (sospende gli avvisi di UISP per questa CPE)</span>
      </label>
      <div className="ui-row">
        <AsyncButton variant="primary" onClick={() => onSave({ alias: alias.trim() || null, note: note.trim() || null, maintenance: maint })} onError={(e) => toast((e as Error).message, 'bad')}>
          Salva
        </AsyncButton>
      </div>
    </Card>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="ui-facts">
      {rows.map(([k, val]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{val ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

