import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, deviceId } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, EmptyState, Notice, PageHeader, Segmented, Skeleton, Table } from '../ui';

/**
 * «Accessi bloccati» (admins): the bans of the login guard (fail2ban style: too many failed logins
 * from an address or a device), with what was tried and the unban, and the log of the login
 * attempts of the web console, the app and the Claude connections, filtered by address or user.
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
      <PageHeader icon="lock" title="Accessi bloccati" subtitle="Indirizzi e dispositivi bloccati dopo troppi accessi non riusciti (come fail2ban), e il registro dei tentativi." />
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
