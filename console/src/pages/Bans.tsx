import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, deviceId } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, EmptyState, Notice, PageHeader, Segmented, Skeleton, Stat, Table } from '../ui';

/**
 * «Accessi bloccati» (admins): the bans of the login guard (fail2ban style: too many failed logins
 * from an address or a device), with what was tried and the unban, and the log of the login
 * attempts of the web console, the app and the Claude connections, filtered by address or user;
 * CrowdSec: the attacks recognised on this server and the community blocklist, with the exceptions.
 */

interface Ban {
  id: number;
  kind: 'ip' | 'device';
  value: string;
  createdAt: string;
  until: string;
  attempts: number;
  reason: string;
  liftedAt: string | null;
  lastAttemptAt: string | null;
  usernames: string[];
  active: boolean;
  expired: boolean;
}
interface Attempt {
  id: number;
  createdAt: string;
  ip: string;
  device: string | null;
  username: string;
  channel: 'web' | 'app' | 'claude';
  kind: 'password' | 'totp' | 'quick' | 'oauth';
  ok: boolean;
  reason: string;
}
const CHANNEL: Record<string, string> = { web: 'console', app: 'app', claude: 'Claude' };
const KIND: Record<string, string> = { password: 'password', totp: 'codice di verifica', quick: 'accesso rapido', oauth: 'consenso Claude' };
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const short = (dev: string | null) => (dev ? `${dev.slice(0, 8)}…` : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export function Bans() {
  const [show, setShow] = useState<'active' | 'all'>('active');
  const bans = useQuery({ queryKey: ['admin', 'bans'], queryFn: () => api<{ items: Ban[] }>('/api/admin/bans'), refetchInterval: 30_000 });
  const lift = async (b: Ban) => {
    if (!confirm(`Sbloccare ${b.kind === 'ip' ? `l’indirizzo ${b.value}` : `il dispositivo ${short(b.value)}`}?`)) return;
    await api(`/api/admin/bans/${b.id}`, { method: 'DELETE' });
    toast('Sbloccato');
    await bans.refetch();
  };
  const items = bans.data?.items.filter((b) => show === 'all' || b.active) ?? [];
  const activeCount = bans.data?.items.filter((b) => b.active).length ?? 0;
  return (
    <div className="ui-page">
      <PageHeader icon="lock" title="Accessi bloccati" subtitle="Indirizzi e dispositivi bloccati dopo troppi accessi non riusciti (come fail2ban), gli indirizzi bloccati da CrowdSec, e il registro dei tentativi." />
      <Card
        title="Blocchi"
        actions={
          <Segmented
            label="Mostra"
            value={show}
            onChange={setShow}
            options={[
              { value: 'active', label: `In corso (${activeCount})` },
              { value: 'all', label: 'Tutti' },
            ]}
          />
        }
      >
        {bans.error && <Notice tone="bad">{(bans.error as Error).message}</Notice>}
        {!bans.data && !bans.error && <Skeleton lines={3} />}
        {bans.data &&
          (items.length ? (
            <Table
              rows={items}
              rowKey={(b) => b.id}
              columns={[
                {
                  label: 'Bloccato',
                  render: (b) => (
                    <span>
                      <Badge tone="neutral">{b.kind === 'ip' ? 'IP' : 'dispositivo'}</Badge> <span className="ui-mono">{b.kind === 'ip' ? b.value : short(b.value)}</span>
                    </span>
                  ),
                },
                { label: 'Dal', render: (b) => <span className="ui-small">{date(b.createdAt)}</span> },
                {
                  label: 'Fino a',
                  render: (b) =>
                    b.active ? <Badge tone="bad">{date(b.until)}</Badge> : b.liftedAt ? <Badge tone="neutral">{`sbloccato ${date(b.liftedAt)}`}</Badge> : <Badge tone="neutral">scaduto</Badge>,
                },
                { label: 'Motivo', render: (b) => <span className="ui-small">{b.reason}</span> },
                { label: 'Utenti tentati', render: (b) => <span className="ui-small">{b.usernames.join(', ') || '—'}</span> },
                { label: 'Ultimo tentativo', render: (b) => <span className="ui-small">{date(b.lastAttemptAt)}</span> },
                {
                  label: '',
                  render: (b) =>
                    b.active ? (
                      <AsyncButton onClick={() => lift(b)} onError={fail}>
                        Sblocca
                      </AsyncButton>
                    ) : null,
                },
              ]}
            />
          ) : (
            <EmptyState title={show === 'active' ? 'Nessun blocco in corso' : 'Nessun blocco'}>Un indirizzo o un dispositivo viene bloccato dopo 5 accessi non riusciti in 15 minuti.</EmptyState>
          ))}
        <ul className="ui-muted ui-small bn-rules">
          <li>5 accessi non riusciti in 15 minuti (password, codice di verifica, accesso rapido, consenso di Claude): blocco di 30 minuti; di nuovo entro 24 ore: 24 ore. Ogni blocco arriva come avviso di sicurezza al NOC.</li>
          <li>Il blocco di un indirizzo ferma solo gli accessi e le richieste senza sessione: chi è già collegato dallo stesso indirizzo (stessa rete del gestore mobile, stesso ufficio) continua a lavorare.</li>
          <li>Le reti interne e quelle fidate del server non vengono mai bloccate per indirizzo: lì vale il limite di 10 tentativi per utente.</li>
          <li>
            Il dispositivo è un codice casuale scelto dall’app o dal browser: ferma un’app o una console che sbaglia di continuo, non chi lo cambia apposta. Questo browser: <span className="ui-mono">{short(deviceId())}</span>
          </li>
        </ul>
      </Card>
      <Crowdsec />
      <Attempts />
    </div>
  );
}

/** The log of the login attempts, newest first. */
function Attempts() {
  const [failed, setFailed] = useState<'1' | '0'>('1');
  const [filter, setFilter] = useState({ ip: '', username: '' });
  const [form, setForm] = useState(filter);
  const qs = new URLSearchParams({ failed, limit: '200', ...(filter.ip ? { ip: filter.ip } : {}), ...(filter.username ? { username: filter.username } : {}) }).toString();
  const q = useQuery({ queryKey: ['admin', 'login-attempts', qs], queryFn: () => api<{ items: Attempt[] }>(`/api/admin/login-attempts?${qs}`) });
  return (
    <Card
      title="Tentativi di accesso"
      actions={
        <Segmented
          label="Mostra"
          value={failed}
          onChange={setFailed}
          options={[
            { value: '1', label: 'Non riusciti' },
            { value: '0', label: 'Tutti' },
          ]}
        />
      }
    >
      <form
        className="bn-filter"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter({ ip: form.ip.trim(), username: form.username.trim() });
        }}
      >
        <input value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} placeholder="Indirizzo IP" aria-label="Indirizzo IP" className="ui-mono" />
        <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="Utente" aria-label="Utente" />
        <Button type="submit">Filtra</Button>
        {(filter.ip || filter.username) && (
          <Button
            variant="ghost"
            onClick={() => {
              setForm({ ip: '', username: '' });
              setFilter({ ip: '', username: '' });
            }}
          >
            Tutti
          </Button>
        )}
      </form>
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!q.data && !q.error && <Skeleton lines={4} />}
      {q.data && (
        <Table
          rows={q.data.items}
          rowKey={(a) => a.id}
          empty="Nessun tentativo."
          columns={[
            { label: 'Quando', render: (a) => <span className="ui-small">{date(a.createdAt)}</span> },
            { label: 'Esito', render: (a) => (a.ok ? <Badge tone="good">riuscito</Badge> : <Badge tone="bad">{a.reason || 'non riuscito'}</Badge>) },
            {
              label: 'Utente',
              render: (a) =>
                a.username ? (
                  <button type="button" className="bn-link" onClick={() => (setForm({ ...form, username: a.username }), setFilter({ ...filter, username: a.username }))}>
                    {a.username}
                  </button>
                ) : (
                  '—'
                ),
            },
            { label: 'Da', render: (a) => <span className="ui-small">{`${CHANNEL[a.channel] ?? a.channel} · ${KIND[a.kind] ?? a.kind}`}</span> },
            {
              label: 'IP',
              render: (a) => (
                <button type="button" className="bn-link ui-mono" onClick={() => (setForm({ ...form, ip: a.ip }), setFilter({ ...filter, ip: a.ip }))}>
                  {a.ip}
                </button>
              ),
            },
            { label: 'Dispositivo', render: (a) => <span className="ui-mono ui-small">{short(a.device)}</span> },
          ]}
        />
      )}
      <p className="ui-muted ui-small">Gli ultimi 200; il registro dei tentativi si cancella da solo dopo 90 giorni. Le password non vengono mai registrate.</p>
    </Card>
  );
}

interface CsDecision {
  value: string;
  scope: string;
  origin: 'local' | 'community' | 'manual' | 'list';
  scenario: string;
  until: string;
}
type CsException = 'trusted' | 'allowed' | 'login' | null;
interface CsStatus {
  enabled: boolean;
  connected: boolean;
  lastSync: string | null;
  error: string | null;
  counts: { local: number; community: number; manual: number; list: number };
  local: CsDecision[];
  blocked: Array<{ ip: string; count: number; first: string; last: string; path: string; decision: CsDecision; exception: CsException }>;
  allow: Array<{ id: number; value: string; note: string; createdAt: string; until: string | null; by: string | null }>;
}
const ORIGIN: Record<string, string> = { local: 'visto qui', community: 'comunità CrowdSec', manual: 'a mano (cscli)', list: 'lista' };
const EXCEPTION: Record<string, string> = { trusted: 'rete interna o fidata', allowed: 'eccezione della console', login: 'accesso riuscito negli ultimi 30 giorni' };
const SCENARIO: Record<string, string> = {
  'http-probing': 'scansione di pagine inesistenti',
  'http-cve': 'exploit noto (CVE)',
  'http-cve-probing': 'ricerca di vulnerabilità note',
  'http-sensitive-files': 'ricerca di file riservati',
  'http-path-traversal-probing': 'path traversal',
  'http-sqli-probing': 'SQL injection',
  'http-xss-probing': 'cross-site scripting',
  'http-bad-user-agent': 'scanner noto (user agent)',
  'http-admin-interface-probing': 'ricerca di pannelli di amministrazione',
  'http-wordpress-scan': 'scansione WordPress',
  'http-backdoors-attempts': 'ricerca di backdoor',
  'http-open-proxy': 'tentativo di proxy aperto',
  'http-technology-probing': 'ricerca di tecnologie',
  'http-generic-bf': 'brute force (login HTTP)',
  'ssh-bf': 'brute force SSH',
  'ssh-slow-bf': 'brute force SSH lento',
};
/** «crowdsecurity/http-probing» in words, when known. */
function scenario(s: string): string {
  const name = s.replace(/^[a-z0-9_-]+\//i, '');
  if (SCENARIO[name]) return SCENARIO[name]!;
  if (/^CVE-\d+/i.test(name)) return `exploit ${name.split(/[_-]/).slice(0, 3).join('-')}`;
  return s || '—';
}

/** CrowdSec: what it blocks on this server, the exceptions, an address checked by hand. */
function Crowdsec() {
  const q = useQuery({ queryKey: ['admin', 'crowdsec'], queryFn: () => api<CsStatus>('/api/admin/crowdsec'), refetchInterval: 30_000 });
  const d = q.data;
  const [form, setForm] = useState({ value: '', note: '', days: '30' });
  const [probe, setProbe] = useState('');
  const [checked, setChecked] = useState<{ ip: string; blocked: boolean; decision: CsDecision | null; exception: CsException } | null>(null);
  const allow = async (value: string, note: string, days: string) => {
    await api('/api/admin/crowdsec/allow', { method: 'POST', body: { value, ...(note ? { note } : {}), ...(days ? { days: Number(days) } : {}) } });
    toast(`${value}: non viene più bloccato da CrowdSec`);
    await q.refetch();
  };
  const remove = async (a: CsStatus['allow'][number]) => {
    if (!confirm(`Togliere l’eccezione per ${a.value}? Se CrowdSec lo segnala, torna bloccato.`)) return;
    await api(`/api/admin/crowdsec/allow/${a.id}`, { method: 'DELETE' });
    toast('Eccezione tolta');
    await q.refetch();
  };
  const state = !d ? null : !d.enabled ? <Badge tone="neutral">non attivo</Badge> : d.connected ? <Badge tone="good">attivo</Badge> : <Badge tone="bad">non raggiungibile</Badge>;
  return (
    <Card title="CrowdSec" actions={state}>
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={3} />}
      {d && !d.enabled && (
        <Notice tone="info" title="CrowdSec non è attivo su questo server">
          Riconosce scanner e tentativi di attacco nel log del web server e blocca anche gli indirizzi segnalati dalla comunità CrowdSec. Si attiva da Impostazioni server → Infrastruttura.
        </Notice>
      )}
      {d?.enabled && (
        <>
          {d.error && <Notice tone="bad">{d.error}</Notice>}
          <section className="ui-stats" aria-label="CrowdSec">
            <Stat label="attacchi visti qui" value={d.counts.local} tone={d.counts.local ? 'warn' : 'neutral'} />
            <Stat label="dalla comunità" value={d.counts.community.toLocaleString('it-IT')} hint="indirizzi segnalati da tutti gli utenti CrowdSec" />
            <Stat label="richieste bloccate (24 ore)" value={d.blocked.filter((b) => !b.exception).reduce((n, b) => n + b.count, 0)} />
            <Stat label="eccezioni" value={d.allow.length} />
          </section>
          <p className="ui-muted ui-small">Ultimo aggiornamento dei blocchi: {date(d.lastSync)}</p>

          <h3 className="bn-h">Controlla un indirizzo</h3>
          <form
            className="bn-filter"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                setChecked(await api(`/api/admin/crowdsec/check?ip=${encodeURIComponent(probe.trim())}`));
              } catch (err) {
                fail(err);
              }
            }}
          >
            <input value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="Indirizzo IP (es. quello di un tecnico che non entra)" aria-label="Indirizzo da controllare" className="ui-mono" />
            <Button type="submit">Controlla</Button>
          </form>
          {checked && (
            <Notice tone={checked.blocked ? 'bad' : 'good'}>
              <span className="ui-mono">{checked.ip}</span>{' '}
              {checked.blocked
                ? `è bloccato fino al ${date(checked.decision!.until)}: ${scenario(checked.decision!.scenario)} · ${ORIGIN[checked.decision!.origin]}.`
                : checked.decision
                  ? `è segnalato (${scenario(checked.decision.scenario)} · ${ORIGIN[checked.decision.origin]}) ma non bloccato: ${EXCEPTION[checked.exception!]}.`
                  : 'non è bloccato.'}
              {checked.blocked && (
                <>
                  {' '}
                  <AsyncButton onClick={() => allow(checked.ip, 'sbloccato dalla console', '30').then(() => setChecked({ ...checked, blocked: false, exception: 'allowed' }))} onError={fail}>
                    Consenti per 30 giorni
                  </AsyncButton>
                </>
              )}
            </Notice>
          )}

          <h3 className="bn-h">Richieste bloccate nelle ultime 24 ore</h3>
          <Table
            rows={d.blocked}
            rowKey={(b) => b.ip}
            empty="Nessuna richiesta bloccata."
            columns={[
              { label: 'Indirizzo', render: (b) => <span className="ui-mono">{b.ip}</span> },
              { label: 'Motivo', render: (b) => <span className="ui-small">{`${scenario(b.decision.scenario)} · ${ORIGIN[b.decision.origin]}`}</span> },
              { label: 'Richieste', render: (b) => b.count },
              { label: 'Ultima', render: (b) => <span className="ui-small">{`${date(b.last)} · ${b.path}`}</span> },
              {
                label: '',
                render: (b) =>
                  b.exception ? (
                    <Badge tone="neutral">{EXCEPTION[b.exception]}</Badge>
                  ) : (
                    <AsyncButton
                      onClick={async () => {
                        if (!confirm(`Consentire ${b.ip} per 30 giorni? CrowdSec non lo bloccherà più su questo server.`)) return;
                        await allow(b.ip, 'sbloccato dalla console', '30');
                      }}
                      onError={fail}
                    >
                      Consenti
                    </AsyncButton>
                  ),
              },
            ]}
          />

          <h3 className="bn-h">Attacchi riconosciuti su questo server</h3>
          <Table
            rows={d.local}
            rowKey={(x) => `${x.value}|${x.scenario}`}
            empty="Nessun attacco in corso di blocco."
            columns={[
              { label: 'Indirizzo', render: (x) => <span className="ui-mono">{x.value}</span> },
              { label: 'Attacco', render: (x) => <span className="ui-small">{scenario(x.scenario)}</span> },
              { label: 'Bloccato fino a', render: (x) => <span className="ui-small">{date(x.until)}</span> },
            ]}
          />

          <h3 className="bn-h">Eccezioni</h3>
          <Table
            rows={d.allow}
            rowKey={(a) => a.id}
            empty="Nessuna eccezione."
            columns={[
              { label: 'Indirizzo o rete', render: (a) => <span className="ui-mono">{a.value}</span> },
              { label: 'Nota', render: (a) => <span className="ui-small">{a.note || '—'}</span> },
              { label: 'Fino a', render: (a) => <span className="ui-small">{a.until ? date(a.until) : 'sempre'}</span> },
              { label: 'Da', render: (a) => <span className="ui-small">{`${a.by ?? '—'} · ${date(a.createdAt)}`}</span> },
              {
                label: '',
                render: (a) => (
                  <AsyncButton onClick={() => remove(a)} onError={fail}>
                    Togli
                  </AsyncButton>
                ),
              },
            ]}
          />
          <form
            className="bn-filter"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await allow(form.value.trim(), form.note.trim(), form.days);
                setForm({ value: '', note: '', days: form.days });
              } catch (err) {
                fail(err);
              }
            }}
          >
            <input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="IP o rete (es. 203.0.113.0/24)" aria-label="IP o rete" className="ui-mono" required />
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Nota (es. ufficio, operatore mobile)" aria-label="Nota" maxLength={120} />
            <select value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} aria-label="Durata">
              <option value="7">7 giorni</option>
              <option value="30">30 giorni</option>
              <option value="365">1 anno</option>
              <option value="">sempre</option>
            </select>
            <Button type="submit">Aggiungi eccezione</Button>
          </form>
        </>
      )}
      <ul className="ui-muted ui-small bn-rules">
        <li>CrowdSec legge il log del web server: chi cerca pagine inesistenti, file riservati, pannelli di amministrazione o vulnerabilità note viene bloccato per 4 ore. Riceve anche la lista della comunità CrowdSec, in cambio dell’indirizzo e del tipo degli attacchi visti qui (mai il contenuto delle richieste).</li>
        <li>Un indirizzo bloccato non apre nessuna pagina: vede un avviso con il suo indirizzo da comunicare al NOC.</li>
        <li>Mai bloccati: le reti interne e fidate, gli indirizzi da cui qualcuno è entrato con successo negli ultimi 30 giorni (molti tecnici condividono lo stesso indirizzo del gestore mobile), le eccezioni qui sopra, e chi ha già una sessione aperta.</li>
      </ul>
    </Card>
  );
}
