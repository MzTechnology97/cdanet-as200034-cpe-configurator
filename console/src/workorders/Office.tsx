import { useQuery } from '@tanstack/react-query';
import { DiagnosisPanel } from './DiagnosisPanel';
import { useEffect, useMemo, useState } from 'react';
import { api, download } from '../lib/api';
import { isOn } from '../lib/modules';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Drawer, EmptyState, Icon, Notice, Segmented, Skeleton, Stat } from '../ui';
import { dayLabel, KIND_TONE, KINDS, type Order, romeDay, STATUS } from './shared';

/**
 * Interventi, the office's list: any period (a day up to a year), installer, kind, status and a
 * search; one compact row per order grouped by day, the summary of the whole selection, the CSV,
 * and for each order the detail with its whole history.
 */

type Period = 'today' | 'tomorrow' | 'week' | 'month' | 'year' | 'custom';
const PERIODS: Array<{ value: Period; label: string }> = [
  { value: 'today', label: 'Oggi' },
  { value: 'tomorrow', label: 'Domani' },
  { value: 'week', label: '7 giorni' },
  { value: 'month', label: 'Mese' },
  { value: 'year', label: 'Anno' },
  { value: 'custom', label: 'Date' },
];
const STATES = [
  { value: '', label: 'Tutti' },
  { value: 'open,started,postponed', label: 'Da fare' },
  { value: 'done', label: 'Fatti' },
  { value: 'cancelled', label: 'Annullati' },
];
const SHORT_KIND: Record<string, string> = { new: 'Installazione', repoint: 'Ripuntamento', repair: 'Guasto', survey: 'Sopralluogo' };
const PAGE = 200;

interface Summary {
  open: number;
  started: number;
  done: number;
  postponed: number;
  cancelled: number;
  overdue: number;
  unassigned: number;
  byKind: Record<string, number>;
}
interface ListAnswer {
  from: string;
  to: string;
  total: number;
  summary: Summary;
  items: Order[];
}

const lastDay = (ym: string) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export function StatusBadges({ o }: { o: Order }) {
  return (
    <span className="ui-row wo-badges">
      <Badge tone={STATUS[o.status]?.[1] ?? 'neutral'}>{STATUS[o.status]?.[0] ?? o.status}</Badge>
      {o.overdue && <Badge tone="bad">in ritardo</Badge>}
    </span>
  );
}

export function OfficeList({ installers, onEdit, onDelete }: { installers: Array<{ id: number; username: string }>; onEdit: (o: Order) => void; onDelete: (o: Order) => Promise<void> }) {
  const [period, setPeriod] = useState<Period>('today');
  const [month, setMonth] = useState(romeDay().slice(0, 7));
  const [year, setYear] = useState(romeDay().slice(0, 4));
  const [from, setFrom] = useState(romeDay());
  const [to, setTo] = useState(romeDay());
  const [who, setWho] = useState('');
  const [kind, setKind] = useState('');
  const [state, setState] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [shown, setShown] = useState<Order | null>(null);

  // the search starts when the typing pauses
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const span: [string, string] =
    period === 'today' ? [romeDay(), romeDay()] : period === 'tomorrow' ? [romeDay(1), romeDay(1)] : period === 'week' ? [romeDay(), romeDay(6)] : period === 'month' ? [`${month}-01`, lastDay(month)] : period === 'year' ? [`${year}-01-01`, `${year}-12-31`] : [from, to < from ? from : to];
  // the next days keep the open orders left behind; a month, a year or chosen dates are history
  const near = period === 'today' || period === 'tomorrow' || period === 'week';
  const params = new URLSearchParams({ from: span[0], to: span[1], backlog: near ? '1' : '0', order: period === 'year' ? 'desc' : 'asc', ...(who ? { user: who } : {}), ...(kind ? { kind } : {}), ...(state ? { status: state } : {}), ...(q ? { q } : {}) });
  const key = params.toString();
  useEffect(() => setLimit(PAGE), [key]);

  const list = useQuery({ queryKey: ['work-orders', 'office', key, limit], queryFn: () => api<ListAnswer>(`/api/admin/work-orders?${key}&limit=${limit}`), placeholderData: (prev) => prev });
  const d = list.data;
  // one group per day, in the server's order; the open orders left from before the period go last, together
  const groups = useMemo(() => {
    const g: Array<[string, Order[]]> = [];
    const left: Order[] = [];
    for (const o of d?.items ?? []) {
      if (o.day < (d?.from ?? '')) {
        left.push(o);
        continue;
      }
      const last = g[g.length - 1];
      if (last && last[0] === o.day) last[1].push(o);
      else g.push([o.day, [o]]);
    }
    if (left.length) g.push(['', left]);
    return g;
  }, [d]);
  const s = d?.summary;
  const years = Array.from({ length: 5 }, (_, i) => String(Number(romeDay().slice(0, 4)) + 1 - i));

  return (
    <>
      <div className="wo-toolbar">
        <Segmented label="Periodo" value={period} onChange={setPeriod} options={PERIODS} />
        {period === 'month' && <input type="month" className="wo-date" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Mese" />}
        {period === 'year' && (
          <select className="wo-date" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Anno">
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        )}
        {period === 'custom' && (
          <>
            <input type="date" className="wo-date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="Dal" />
            <input type="date" className="wo-date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="Al" />
          </>
        )}
      </div>
      <div className="wo-toolbar">
        <label className="hl-search wo-search">
          <Icon name="search" />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Cliente, indirizzo, contatto, PPPoE o #numero" aria-label="Cerca" />
        </label>
        <select className="wo-date" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Installatore">
          <option value="">Tutti gli installatori</option>
          <option value="none">Da assegnare</option>
          {installers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <select className="wo-date" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo">
          <option value="">Tutti i tipi</option>
          {Object.entries(KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <Segmented label="Stato" value={state} onChange={setState} options={STATES} />
        {isOn('csv_export') && (
          <AsyncButton onClick={() => download(`/api/admin/work-orders.csv?${key}`, `interventi-${span[0]}-${span[1]}.csv`)} onError={(e) => toast((e as Error).message, 'bad')}>
            Esporta CSV
          </AsyncButton>
        )}
      </div>
      {s && (
        <section className="ui-stats" aria-label="Riepilogo">
          <Stat label="interventi" value={d.total} />
          <Stat label="da fare" value={s.open + s.postponed} active={state === 'open,started,postponed'} onClick={() => setState(state === 'open,started,postponed' ? '' : 'open,started,postponed')} />
          <Stat label="in corso" value={s.started} tone="info" />
          <Stat label="fatti" value={s.done} tone="good" active={state === 'done'} onClick={() => setState(state === 'done' ? '' : 'done')} />
          <Stat label="in ritardo" value={s.overdue} tone={s.overdue ? 'bad' : 'good'} />
          <Stat label="da assegnare" value={s.unassigned} tone={s.unassigned ? 'warn' : 'good'} active={who === 'none'} onClick={() => setWho(who === 'none' ? '' : 'none')} />
        </section>
      )}
      {s && d.total > 0 && (
        <p className="ui-muted ui-small">
          {Object.entries(s.byKind)
            .filter(([, n]) => n)
            .map(([k, n]) => `${n} ${SHORT_KIND[k]?.toLowerCase() ?? k}`)
            .join(' · ')}
          {s.cancelled ? ` · ${s.cancelled} annullati` : ''}
        </p>
      )}
      {list.error ? (
        <Notice tone="bad">{(list.error as Error).message}</Notice>
      ) : !d ? (
        <Skeleton lines={6} />
      ) : !d.items.length ? (
        <EmptyState icon="check_circle" title="Nessun intervento">
          Nessun intervento con questi filtri.
        </EmptyState>
      ) : (
        <div className="wo-table">
          {groups.map(([day, os]) => (
            <section key={day || 'left'}>
              <h3 className={`wo-table-day${day ? '' : ' left'}`}>
                {day ? dayLabel(day) : 'Rimasti aperti dai giorni passati'} <span className="ui-muted">· {os.length}</span>
              </h3>
              <ul>
                {os.map((o) => (
                  <li key={o.id} className={`wo-row${o.overdue ? ' overdue' : ''}${o.status === 'cancelled' ? ' cancelled' : ''}`} role="button" tabIndex={0} onClick={() => setShown(o)} onKeyDown={(e) => e.key === 'Enter' && setShown(o)}>
                    <span className="wo-row-slot">{day ? o.slot || '—' : new Date(`${o.day}T12:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</span>
                    <span className="wo-row-main">
                      <strong>{o.customer}</strong>
                      <span className="ui-muted ui-small">{o.address || 'indirizzo non indicato'}</span>
                    </span>
                    <span className="wo-row-kind">
                      <Badge tone={KIND_TONE[o.kind] ?? 'neutral'}>{SHORT_KIND[o.kind] ?? o.kind}</Badge>
                    </span>
                    <span className="wo-row-who">{o.assignee ? o.assignee : <Badge tone="warn">da assegnare</Badge>}</span>
                    <StatusBadges o={o} />
                    <span className="ui-muted ui-small wo-row-id">#{o.id}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {d.items.length < d.total && (
            <div className="ui-row wo-more">
              <Button busy={list.isFetching} onClick={() => setLimit((n) => n + PAGE)}>
                Mostra altri ({d.total - d.items.length})
              </Button>
            </div>
          )}
        </div>
      )}
      {shown && (
        <OrderDetails
          o={shown}
          onClose={() => setShown(null)}
          onEdit={() => (setShown(null), onEdit(shown))}
          onDelete={async () => {
            await onDelete(shown);
            setShown(null);
          }}
        />
      )}
    </>
  );
}

interface HistoryItem {
  at: string;
  kind: string;
  user: string | null;
  detail: string;
}
const HISTORY: Record<string, [string, 'good' | 'warn' | 'bad' | 'neutral' | 'info']> = {
  create: ['Creato', 'neutral'],
  update: ['Modificato', 'info'],
  status: ['Dall’app', 'info'],
  delete: ['Annullato dall’ufficio', 'bad'],
  position_mismatch: ['Posizione lontana', 'warn'],
  late: ['In ritardo', 'warn'],
  missed: ['Non svolto', 'bad'],
  job: ['Installazione', 'good'],
  acceptance: ['Collaudo', 'good'],
  export: ['Esportato', 'neutral'],
};
const when = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
/** «postponed · cliente assente» → «rimandato · cliente assente». */
const statusText = (detail: string) => detail.replace(/^([a-z]+)/, (w) => STATUS[w]?.[0] ?? (w === 'started' ? 'iniziato' : w));

/** One order: every field, its history and what the office can do with it. */
function OrderDetails({ o, onClose, onEdit, onDelete }: { o: Order; onClose: () => void; onEdit: () => void; onDelete: () => Promise<void> }) {
  const h = useQuery({ queryKey: ['work-orders', 'history', o.id], queryFn: () => api<{ items: HistoryItem[]; job: { id: string; status: string; acceptance: string | null } | null }>(`/api/admin/work-orders/${o.id}/history`) });
  const fact = (label: string, value: React.ReactNode) =>
    value ? (
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ) : null;
  return (
    <Drawer
      title={`#${o.id} · ${o.customer}`}
      onClose={onClose}
      footer={
        <>
          {o.status !== 'cancelled' && o.status !== 'done' && (
            <Button variant="primary" onClick={onEdit}>
              Modifica
            </Button>
          )}
          {o.status !== 'cancelled' && (
            <AsyncButton variant="danger" onClick={onDelete} onError={(e) => toast((e as Error).message, 'bad')}>
              {o.jobId || o.status === 'done' ? 'Annulla' : 'Elimina'}
            </AsyncButton>
          )}
          <Button onClick={onClose}>Chiudi</Button>
        </>
      }
    >
      <div className="ui-row">
        <Badge tone={KIND_TONE[o.kind] ?? 'neutral'}>{KINDS[o.kind] ?? o.kind}</Badge>
        <StatusBadges o={o} />
      </div>
      <dl className="ui-facts">
        {fact('Giorno', `${dayLabel(o.day)}${o.slot ? ` · ${o.slot}` : ''}`)}
        {fact('Installatore', o.assignee ?? 'da assegnare')}
        {fact('Indirizzo', o.address || '—')}
        {fact('Contatto', o.contact)}
        {fact('Utente PPPoE', o.pppoeUser ? `${o.pppoeUser}${o.hasPassword ? '' : ' · senza password'}` : '')}
        {fact('Modello CPE', o.model)}
        {fact('Completato', o.doneAt ? when(o.doneAt) : '')}
      </dl>
      {o.notes && <p className="wo-notes">{o.notes}</p>}
      {o.statusNote && <p className="wo-notes">{o.statusNote}</p>}
      {o.status !== 'cancelled' && (
        <>
          <h4 className="jb-h4">Diagnosi a distanza</h4>
          <DiagnosisPanel params={{ workOrderId: String(o.id) }} auto={o.kind === 'repair' || o.kind === 'repoint'} />
        </>
      )}
      <h4 className="jb-h4">Storico</h4>
      {h.error ? (
        <Notice tone="bad">{(h.error as Error).message}</Notice>
      ) : !h.data ? (
        <Skeleton lines={3} />
      ) : (
        <ol className="wo-history">
          {h.data.items.map((i, n) => (
            <li key={n}>
              <span className="ui-small ui-muted">{when(i.at)}</span>
              <span>
                <Badge tone={HISTORY[i.kind]?.[1] ?? 'neutral'}>{HISTORY[i.kind]?.[0] ?? i.kind}</Badge> {i.kind === 'status' ? statusText(i.detail) : i.detail}
                {i.user && <span className="ui-muted ui-small"> · {i.user}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}
