import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from '../lib/toast';
import { MyTelegram } from '../account/MyTelegram';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, EmptyState, Icon, Notice, PageHeader, Segmented, Skeleton } from '../ui';

/** Notifiche: the NOC's notices (admins) and the outcome of one's installations, live. */

interface Item {
  id: number;
  createdAt: string;
  kind: string;
  title: string;
  body: string;
  jobId: string | null;
  mac: string;
  readAt: string | null;
}
interface Prefs {
  kinds: Array<{ kind: string; label: string; noc: boolean; telegram: boolean }>;
  telegram: { available: boolean; linked: boolean };
}

/** The icon and tone of each kind (the title keeps its own ✅/❌ when the server put one). */
const KIND: Record<string, { icon: string; tone: string }> = {
  provisioning_failed: { icon: 'error_filled', tone: 'bad' },
  install_ko: { icon: 'error_filled', tone: 'bad' },
  review_pending: { icon: 'pending_actions', tone: 'warn' },
  review_decision: { icon: 'check_circle', tone: 'good' },
  install_activated: { icon: 'check_circle', tone: 'good' },
  network_advice: { icon: 'troubleshoot', tone: 'warn' },
  network_optimizer: { icon: 'troubleshoot', tone: 'info' },
  work_order_assigned: { icon: 'pending_actions', tone: 'info' },
  work_order_reminder: { icon: 'pending_actions', tone: 'info' },
  work_order_late: { icon: 'warning_filled', tone: 'warn' },
  work_order_noc: { icon: 'warning_filled', tone: 'warn' },
  screenshot_attempt: { icon: 'lock', tone: 'bad' },
};
/** Notifications of IA-AP open its page, those of work orders Interventi, the others the history of the installation. */
const IA_AP = new Set(['network_advice', 'network_optimizer']);

const dayOf = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Oggi';
  if (d.toDateString() === yesterday.toDateString()) return 'Ieri';
  return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
};
const time = (iso: string) => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

export function Notifications({ user }: PageContext) {
  const qc = useQueryClient();
  const [view, setView] = useState<'all' | 'unread'>('all');
  const list = useQuery({
    queryKey: [...keys.notifications, 'list', view],
    queryFn: () => api<{ unread: number; items: Item[] }>(`/api/notifications?limit=200${view === 'unread' ? '&unread=1' : ''}`),
    staleTime: 0,
  });
  // the bell follows this page
  useEffect(() => {
    if (list.data) qc.setQueryData(keys.unread, list.data.unread);
  }, [list.data, qc]);
  const read = useMutation({
    mutationFn: (body: { ids: number[] } | { all: true }) => api('/api/notifications/read', { method: 'POST', body }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
  // each user deletes only their own notifications: one, the read ones or all of them
  const remove = useMutation({
    mutationFn: (body: { ids: number[] } | { read: true } | { all: true }) => api<{ ok: boolean; deleted: number; unread: number }>('/api/notifications/delete', { method: 'POST', body }),
    onSuccess: (r, body) => {
      qc.setQueryData(keys.unread, r.unread);
      if (!('ids' in body)) toast(r.deleted === 1 ? '1 notifica eliminata' : `${r.deleted} notifiche eliminate`);
    },
    onError: (e) => toast((e as Error).message, 'bad'),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
  const anyRead = (list.data?.items ?? []).some((n) => n.readAt);

  const items = list.data?.items ?? [];
  const groups: Array<[string, Item[]]> = [];
  for (const n of items) {
    const d = dayOf(n.createdAt);
    const g = groups.at(-1);
    if (g && g[0] === d) g[1].push(n);
    else groups.push([d, [n]]);
  }

  return (
    <div className="ui-page">
      <PageHeader
        icon="notifications"
        title="Notifiche"
        subtitle={
          user.role === 'admin'
            ? 'Reparto NOC: provisioning falliti, installazioni KO o rimandate, collaudi con segnale pessimo da approvare. In più l’esito delle tue installazioni.'
            : 'L’esito delle tue installazioni: approvazioni del NOC e attivazioni.'
        }
      />
      <Card
        title={list.data ? (list.data.unread ? `${list.data.unread} da leggere` : 'Tutte lette') : 'Notifiche'}
        actions={
          <>
            <Segmented label="Mostra" value={view} onChange={setView} options={[{ value: 'all', label: 'Tutte' }, { value: 'unread', label: 'Da leggere' }]} />
            <Button icon="check_circle" disabled={!list.data?.unread} busy={read.isPending && !('ids' in (read.variables ?? {}))} onClick={() => read.mutate({ all: true })}>
              Segna tutte come lette
            </Button>
            <Button disabled={!anyRead || remove.isPending} onClick={() => remove.mutate({ read: true })}>
              Elimina le lette
            </Button>
            <Button
              variant="danger"
              disabled={!items.length || remove.isPending}
              onClick={() => confirm('Eliminare tutte le tue notifiche, anche quelle da leggere?') && remove.mutate({ all: true })}
            >
              Elimina tutte
            </Button>
          </>
        }
      >
        {list.isLoading ? (
          <Skeleton lines={5} />
        ) : list.error ? (
          <Notice tone="bad">{(list.error as Error).message}</Notice>
        ) : !items.length ? (
          <EmptyState title={view === 'unread' ? 'Niente da leggere' : 'Nessuna notifica'}>{view === 'unread' ? 'Le notifiche nuove compaiono qui da sole.' : 'Negli ultimi 14 giorni non è arrivato niente: le notifiche si cancellano da sole dopo 14 giorni.'}</EmptyState>
        ) : (
          groups.map(([day, ns]) => (
            <section key={day} className="nt-day">
              <h3 className="nt-day-title">{day}</h3>
              <ul className="nt-list">
                {ns.map((n) => {
                  const k = KIND[n.kind] ?? { icon: 'notifications', tone: 'neutral' };
                  const href = n.kind === 'screenshot_attempt' ? '#/events' : IA_AP.has(n.kind) ? '#/ia-ap' : n.kind.startsWith('work_order') ? '#/work-orders' : n.mac ? `#/jobs?q=${encodeURIComponent(n.mac)}` : '#/jobs';
                  return (
                    <li key={n.id} className={`nt-item ui-tone-${k.tone}${n.readAt ? '' : ' unread'}`}>
                      <span className="nt-icon">
                        <Icon name={k.icon} />
                      </span>
                      <div className="nt-text">
                        <div className="nt-head">
                          <strong>{n.title.replace(/^[^\p{L}\p{N}]+/u, '')}</strong>
                          <span className="ui-muted ui-small">{time(n.createdAt)}</span>
                        </div>
                        {n.body && <p className="nt-body">{n.body}</p>}
                        <div className="ui-row">
                          <a className="ui-btn ui-btn-ghost nt-open" href={href} onClick={() => !n.readAt && read.mutate({ ids: [n.id] })}>
                            {n.kind === 'screenshot_attempt' ? 'Apri il registro attività' : IA_AP.has(n.kind) ? 'Apri IA-AP' : n.kind.startsWith('work_order') ? 'Apri gli interventi' : 'Apri nello storico'}
                          </a>
                          {!n.readAt && (
                            <Button variant="ghost" onClick={() => read.mutate({ ids: [n.id] })}>
                              Segna come letta
                            </Button>
                          )}
                          <button type="button" className="cx-icon-btn nt-delete" aria-label="Elimina notifica" title="Elimina notifica" disabled={remove.isPending} onClick={() => remove.mutate({ ids: [n.id] })}>
                            <Icon name="delete" />
                          </button>
                        </div>
                      </div>
                      {!n.readAt && <span className="nt-dot" aria-label="da leggere" />}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </Card>
      <TelegramPrefs admin={user.role === 'admin'} />
    </div>
  );
}

/** Which kinds also go to the user's own Telegram chat. */
function TelegramPrefs({ admin }: { admin: boolean }) {
  const prefs = useQuery({ queryKey: [...keys.notifications, 'prefs'], queryFn: () => api<Prefs>('/api/notifications/prefs') });
  const [on, setOn] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (prefs.data) setOn(new Set(prefs.data.kinds.filter((k) => k.telegram).map((k) => k.kind)));
  }, [prefs.data]);
  const p = prefs.data;
  return (
    <>
      <Card title="Anche su Telegram">
        <p className="ui-muted">
          Tutte le notifiche restano in questa pagina. Scegli quali ricevere anche nella tua chat Telegram personale.
          {admin ? ' Quelle del NOC arrivano già al gruppo Telegram, se configurato in Connettori.' : ''}
        </p>
        {!p || !on ? (
          <Skeleton lines={3} />
        ) : (
          <>
            {!p.telegram.available ? (
              <Notice tone="warn">{admin ? 'Telegram non configurato: imposta il bot in Connettori → Telegram.' : 'Telegram non disponibile: chiedi all’amministratore.'}</Notice>
            ) : !p.telegram.linked ? (
              <Notice tone="warn">Collega prima la tua chat Telegram qui sotto.</Notice>
            ) : null}
            <div className="nt-kinds">
              {p.kinds.map((k) => (
                <label key={k.kind} className="ui-check">
                  <input
                    type="checkbox"
                    checked={on.has(k.kind)}
                    onChange={(e) => {
                      const next = new Set(on);
                      if (e.target.checked) next.add(k.kind);
                      else next.delete(k.kind);
                      setOn(next);
                    }}
                  />
                  <span>{k.label}</span>
                  {k.noc && <Badge>NOC</Badge>}
                </label>
              ))}
            </div>
            <div className="ui-row">
              <AsyncButton
                variant="primary"
                onClick={async () => {
                  await api('/api/notifications/prefs', { method: 'PUT', body: { telegram: [...on] } });
                  toast('Preferenze salvate');
                }}
                onError={(e) => toast((e as Error).message, 'bad')}
              >
                Salva
              </AsyncButton>
            </div>
          </>
        )}
      </Card>
      {p?.telegram.available && !p.telegram.linked && <MyTelegram title="Collega Telegram" />}
    </>
  );
}
