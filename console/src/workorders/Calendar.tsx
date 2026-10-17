import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, type MouseEvent, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { Button, Icon, Notice, Segmented, Skeleton } from '../ui';
import { canManage } from '../lib/roles';

/**
 * The calendar of the interventions, as Google Calendar: week, month and day. Installers see
 * their own; the office sees everyone's (one column per installer in the day view), plans a new
 * one with a click on an empty time and moves one by dragging it to another day, time or
 * installer. Colours by kind as in the app: new orange, repoint blue, repair yellow, survey green;
 * done ones faded, late ones with a red border.
 */

export interface CalOrder {
  id: number;
  day: string;
  slot: string;
  kind: string;
  kindLabel?: string;
  status: string;
  overdue: boolean;
  customer: string;
  address: string;
  assignedTo: number | null;
  assignee?: string | null;
}
interface CalendarData {
  from: string;
  to: string;
  today: string;
  items: CalOrder[];
  installers?: Array<{ id: number; username: string }>;
}
export interface NewAt {
  day: string;
  slot: string;
  assignedTo: number | null;
}
type View = 'day' | 'week' | 'month';

// ---- dates (days as YYYY-MM-DD, computed at noon UTC: no daylight-saving surprises) ----
const toDate = (d: string) => new Date(`${d}T12:00:00Z`);
const fmt = (t: Date) => t.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => fmt(new Date(toDate(d).getTime() + n * 86_400_000));
const weekday = (d: string) => (toDate(d).getUTCDay() + 6) % 7; // Monday 0
const monday = (d: string) => addDays(d, -weekday(d));
const firstOfMonth = (d: string) => `${d.slice(0, 7)}-01`;
const addMonths = (d: string, n: number) => {
  const t = toDate(firstOfMonth(d));
  t.setUTCMonth(t.getUTCMonth() + n);
  return fmt(t);
};
const romeToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const label = (d: string, o: Intl.DateTimeFormatOptions) => toDate(d).toLocaleDateString('it-IT', { ...o, timeZone: 'UTC' });

function span(view: View, at: string): [string, string] {
  if (view === 'day') return [at, at];
  if (view === 'week') return [monday(at), addDays(monday(at), 6)];
  const first = firstOfMonth(at);
  const last = addDays(addMonths(at, 1), -1);
  return [monday(first), addDays(monday(last), 6)];
}
function title(view: View, at: string) {
  if (view === 'day') return label(at, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (view === 'month') return label(at, { month: 'long', year: 'numeric' });
  const [a, b] = span('week', at);
  return a.slice(0, 7) === b.slice(0, 7) ? `${label(a, { day: 'numeric' })} – ${label(b, { day: 'numeric', month: 'long', year: 'numeric' })}` : `${label(a, { day: 'numeric', month: 'short' })} – ${label(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// ---- times: "HH:MM-HH:MM" (also 8.30, en dash, one time = one hour); anything else = no time ----
const SLOT = /^\s*(\d{1,2})[:.](\d{2})\s*(?:[-–]\s*(\d{1,2})[:.](\d{2}))?/;
function times(slot: string): [number, number] | null {
  const m = SLOT.exec(slot);
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  if (start >= 24 * 60 || Number(m[2]) > 59) return null;
  const end = m[3] ? Number(m[3]) * 60 + Number(m[4]) : start + 60;
  return [start, end > start && end <= 24 * 60 ? end : Math.min(start + 60, 24 * 60)];
}
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const slotOf = (start: number, end: number) => `${hhmm(start)}-${hhmm(Math.min(end, 24 * 60 - 1))}`;

const HOUR_PX = 48;
const KIND_CLASS: Record<string, string> = { new: 'k-new', repoint: 'k-repoint', repair: 'k-repair', survey: 'k-survey' };
const KIND_SHORT: Record<string, string> = { new: 'Installazione', repoint: 'Ripuntamento', repair: 'Guasto', survey: 'Sopralluogo' };
const movable = (o: CalOrder) => o.status === 'open' || o.status === 'postponed';

/** Side by side when they overlap: each timed order gets a lane and the number of lanes of its group. */
function lanes(items: Array<CalOrder & { t: [number, number] }>) {
  const out = new Map<number, { lane: number; of: number }>();
  const sorted = [...items].sort((a, b) => a.t[0] - b.t[0] || b.t[1] - a.t[1]);
  let group: typeof sorted = [];
  let groupEnd = -1;
  const close = () => {
    const ends: number[] = [];
    const lane = new Map<number, number>();
    for (const o of group) {
      let i = ends.findIndex((e) => e <= o.t[0]);
      if (i < 0) i = ends.length;
      ends[i] = o.t[1];
      lane.set(o.id, i);
    }
    for (const o of group) out.set(o.id, { lane: lane.get(o.id)!, of: ends.length });
    group = [];
  };
  for (const o of sorted) {
    if (group.length && o.t[0] >= groupEnd) close();
    group.push(o);
    groupEnd = Math.max(groupEnd, o.t[1]);
  }
  if (group.length) close();
  return out;
}

const initialView = (): View => {
  try {
    const v = localStorage.getItem('cda.calendarView');
    if (v === 'day' || v === 'week' || v === 'month') return v;
  } catch {
    /* not remembered */
  }
  return matchMedia('(max-width: 720px)').matches ? 'day' : 'week';
};

export function Calendar({ admin, onNew, onOpen }: { admin: boolean; onNew?: (at: NewAt) => void; onOpen: (o: CalOrder) => void }) {
  const qc = useQueryClient();
  const [view, setViewState] = useState<View>(initialView);
  const [at, setAt] = useState(romeToday());
  const [who, setWho] = useState('');
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem('cda.calendarView', v);
    } catch {
      /* not remembered */
    }
  };
  const [from, to] = span(view, at);
  const q = useQuery({
    queryKey: ['work-orders', 'calendar', from, to, admin ? who : ''],
    queryFn: () => api<CalendarData>(`/api/work-orders/calendar?${new URLSearchParams({ from, to, ...(admin && who ? { user: who } : {}) })}`),
    placeholderData: (prev) => prev,
  });
  const data = q.data;
  const today = data?.today ?? romeToday();
  const installers = data?.installers ?? [];

  const move = async (o: CalOrder, to: { day: string; slot?: string; assignedTo?: number | null }) => {
    const body: Record<string, unknown> = { day: to.day };
    if (to.slot !== undefined) body.slot = to.slot;
    if (to.assignedTo !== undefined) body.assignedTo = to.assignedTo;
    if (to.day === o.day && (to.slot === undefined || to.slot === o.slot) && (to.assignedTo === undefined || to.assignedTo === o.assignedTo)) return;
    try {
      await api(`/api/admin/work-orders/${o.id}`, { method: 'PUT', body });
      const who = to.assignedTo !== undefined && to.assignedTo !== o.assignedTo ? ` · ${installers.find((u) => u.id === to.assignedTo)?.username ?? 'da assegnare'}` : '';
      toast(`${o.customer} spostato a ${label(to.day, { weekday: 'short', day: 'numeric', month: 'short' })}${to.slot ? `, ${to.slot}` : ''}${who}`);
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
    await qc.invalidateQueries({ queryKey: ['work-orders'] });
  };

  const step = (n: number) => setAt(view === 'month' ? addMonths(at, n) : addDays(at, view === 'week' ? 7 * n : n));
  const ctx: GridCtx = { admin, today, installers, onNew, onOpen, move, items: data?.items ?? [] };

  return (
    <div className="cal">
      <div className="cal-bar">
        <Button onClick={() => setAt(today)}>Oggi</Button>
        <span className="cal-nav">
          <button type="button" className="cx-icon-btn" aria-label="Precedente" onClick={() => step(-1)}>
            <Icon name="chevron_left" />
          </button>
          <button type="button" className="cx-icon-btn" aria-label="Successivo" onClick={() => step(1)}>
            <Icon name="chevron_right" />
          </button>
        </span>
        <h2 className="cal-title">{title(view, at)}</h2>
        <Segmented
          label="Vista"
          value={view}
          onChange={setView}
          options={[
            { value: 'day', label: 'Giorno' },
            { value: 'week', label: 'Settimana' },
            { value: 'month', label: 'Mese' },
          ]}
        />
        {admin && installers.length > 0 && (
          <select className="wo-date" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Installatore">
            <option value="">Tutti gli installatori</option>
            {installers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
        )}
      </div>
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !data ? (
        <Skeleton lines={8} />
      ) : view === 'month' ? (
        <Month ctx={ctx} from={from} to={to} month={at.slice(0, 7)} onDay={(d) => (setAt(d), setView('day'))} />
      ) : (
        <TimeGrid
          ctx={ctx}
          columns={
            view === 'week'
              ? Array.from({ length: 7 }, (_, i) => ({ key: addDays(from, i), day: addDays(from, i), title: label(addDays(from, i), { weekday: 'short', day: 'numeric' }), assignedTo: undefined }))
              : admin && !who
                ? [...installers.map((u) => ({ key: `u${u.id}`, day: at, title: u.username, assignedTo: u.id as number | null })), { key: 'none', day: at, title: 'Da assegnare', assignedTo: null }]
                : [{ key: at, day: at, title: label(at, { weekday: 'long', day: 'numeric' }), assignedTo: admin && who ? Number(who) : undefined }]
          }
          onDayTitle={view === 'week' ? (d) => (setAt(d), setView('day')) : undefined}
        />
      )}
      {admin && canManage() && <p className="ui-muted ui-small cal-help">Clic su un orario libero per programmare un intervento; trascina un intervento da fare per spostarlo di giorno, di orario o (vista Giorno) di installatore.</p>}
    </div>
  );
}

interface GridCtx {
  admin: boolean;
  today: string;
  installers: Array<{ id: number; username: string }>;
  items: CalOrder[];
  onNew?: (at: NewAt) => void;
  onOpen: (o: CalOrder) => void;
  move: (o: CalOrder, to: { day: string; slot?: string; assignedTo?: number | null }) => Promise<void>;
}
interface Column {
  key: string;
  day: string;
  title: string;
  /** Day view of the office: the installer of the column (null = to be assigned); undefined = any. */
  assignedTo: number | null | undefined;
}

/** The order being dragged and where it was grabbed (minutes from its start). */
let dragging: { o: CalOrder; grab: number } | null = null;

function Block({ o, ctx, style, compact }: { o: CalOrder; ctx: GridCtx; style?: React.CSSProperties; compact?: boolean }) {
  const t = times(o.slot);
  // moving an order is planning: the admins only
  const canMove = ctx.admin && canManage() && movable(o);
  return (
    <button
      type="button"
      className={`cal-ev ${KIND_CLASS[o.kind] ?? ''}${o.status === 'done' ? ' done' : ''}${o.overdue ? ' late' : ''}${o.status === 'postponed' ? ' postponed' : ''}${o.status === 'started' ? ' started' : ''}`}
      style={style}
      draggable={canMove}
      onDragStart={(e: DragEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        dragging = { o, grab: t ? Math.round(((e.clientY - rect.top) / HOUR_PX) * 60) : 0 };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(o.id));
      }}
      onDragEnd={() => (dragging = null)}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        ctx.onOpen(o);
      }}
      title={`${o.slot ? `${o.slot} · ` : ''}${o.customer} · ${o.kindLabel ?? KIND_SHORT[o.kind] ?? o.kind}${o.assignee ? ` · ${o.assignee}` : ''}${o.address ? `\n${o.address}` : ''}`}
    >
      <span className="cal-ev-time">{t ? hhmm(t[0]) : compact ? '' : 'senza orario'}</span> <strong>{o.customer}</strong>
      {!compact && (
        <span className="cal-ev-sub">
          {KIND_SHORT[o.kind] ?? o.kind}
          {o.assignee && ctx.admin ? ` · ${o.assignee}` : ''}
          {o.status === 'done' ? ' · fatto' : o.status === 'started' ? ' · in corso' : o.status === 'postponed' ? ' · rimandato' : o.overdue ? ' · in ritardo' : ''}
        </span>
      )}
    </button>
  );
}

function TimeGrid({ ctx, columns, onDayTitle }: { ctx: GridCtx; columns: Column[]; onDayTitle?: (day: string) => void }) {
  const inCol = (c: Column) => ctx.items.filter((o) => o.day === c.day && (c.assignedTo === undefined || o.assignedTo === c.assignedTo));
  const timed = ctx.items.map((o) => times(o.slot)).filter((t): t is [number, number] => !!t);
  const startH = Math.min(7, ...timed.map((t) => Math.floor(t[0] / 60)));
  const endH = Math.max(21, ...timed.map((t) => Math.ceil(t[1] / 60)));
  const hours = Array.from({ length: endH - startH }, (_, i) => startH + i);
  const height = hours.length * HOUR_PX;
  const minuteAt = (e: { clientY: number; currentTarget: EventTarget }, grab = 0) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const m = startH * 60 + ((e.clientY - rect.top) / HOUR_PX) * 60 - grab;
    return Math.max(startH * 60, Math.min(endH * 60 - 15, Math.round(m / 15) * 15));
  };
  const dropOk = (e: DragEvent) => {
    if (dragging) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };
  return (
    <div className="cal-scroll">
      <div className="cal-grid" style={{ gridTemplateColumns: `52px repeat(${columns.length}, minmax(${columns.length > 4 ? 96 : 140}px, 1fr))` }}>
        <div className="cal-corner" />
        {columns.map((c) => (
          <div key={c.key} className={`cal-head${c.day === ctx.today && c.assignedTo === undefined ? ' today' : ''}`}>
            {onDayTitle ? (
              <button type="button" className="ui-link" onClick={() => onDayTitle(c.day)}>
                {c.title}
              </button>
            ) : (
              c.title
            )}
          </div>
        ))}
        <div className="cal-gutter cal-allday-label">senza orario</div>
        {columns.map((c) => (
          <div
            key={`a-${c.key}`}
            className="cal-allday"
            onDragOver={dropOk}
            onDrop={(e) => {
              e.preventDefault();
              const d = dragging;
              dragging = null;
              if (d) void ctx.move(d.o, { day: c.day, ...(c.assignedTo !== undefined ? { assignedTo: c.assignedTo } : {}) });
            }}
          >
            {inCol(c)
              .filter((o) => !times(o.slot))
              .map((o) => (
                <Block key={o.id} o={o} ctx={ctx} compact />
              ))}
          </div>
        ))}
        <div className="cal-gutter">
          {hours.map((h) => (
            <div key={h} className="cal-hour" style={{ height: HOUR_PX }}>
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
        </div>
        {columns.map((c) => {
          const evs = inCol(c)
            .map((o) => ({ ...o, t: times(o.slot) }))
            .filter((o): o is CalOrder & { t: [number, number] } => !!o.t);
          const lane = lanes(evs);
          return (
            <div
              key={`b-${c.key}`}
              className={`cal-col${c.day === ctx.today ? ' today' : ''}${ctx.admin && ctx.onNew ? ' plannable' : ''}`}
              style={{ height, backgroundSize: `100% ${HOUR_PX}px` }}
              onClick={(e) => {
                if (!ctx.admin || !ctx.onNew) return;
                const m = Math.floor(minuteAt(e) / 30) * 30;
                ctx.onNew({ day: c.day, slot: slotOf(m, m + 60), assignedTo: c.assignedTo ?? null });
              }}
              onDragOver={dropOk}
              onDrop={(e) => {
                e.preventDefault();
                const d = dragging;
                dragging = null;
                if (!d) return;
                const t = times(d.o.slot);
                const len = t ? t[1] - t[0] : 60;
                const start = minuteAt(e, d.grab);
                void ctx.move(d.o, { day: c.day, slot: slotOf(start, start + len), ...(c.assignedTo !== undefined ? { assignedTo: c.assignedTo } : {}) });
              }}
            >
              {evs.map((o) => {
                const l = lane.get(o.id) ?? { lane: 0, of: 1 };
                return (
                  <Block
                    key={o.id}
                    o={o}
                    ctx={ctx}
                    style={{
                      top: ((o.t[0] - startH * 60) / 60) * HOUR_PX,
                      height: Math.max(22, ((o.t[1] - o.t[0]) / 60) * HOUR_PX - 2),
                      left: `calc(${(100 / l.of) * l.lane}% + 2px)`,
                      width: `calc(${100 / l.of}% - 4px)`,
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Month({ ctx, from, to, month, onDay }: { ctx: GridCtx; from: string; to: string; month: string; onDay: (day: string) => void }) {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const byDay = useMemo(() => {
    const m = new Map<string, CalOrder[]>();
    for (const o of ctx.items) m.set(o.day, [...(m.get(o.day) ?? []), o]);
    for (const list of m.values()) list.sort((a, b) => (times(a.slot)?.[0] ?? -1) - (times(b.slot)?.[0] ?? -1));
    return m;
  }, [ctx.items]);
  return (
    <div className="cal-month">
      {['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'].map((d) => (
        <div key={d} className="cal-month-head">
          {d}
        </div>
      ))}
      {days.map((d) => {
        const list = byDay.get(d) ?? [];
        return (
          <div
            key={d}
            className={`cal-cell${d.slice(0, 7) !== month ? ' other' : ''}${d === ctx.today ? ' today' : ''}${ctx.admin && ctx.onNew ? ' plannable' : ''}`}
            onClick={() => ctx.admin && ctx.onNew?.({ day: d, slot: '', assignedTo: null })}
            onDragOver={(e) => {
              if (dragging) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const drag = dragging;
              dragging = null;
              if (drag) void ctx.move(drag.o, { day: d });
            }}
          >
            <button
              type="button"
              className="cal-cell-day"
              onClick={(e) => {
                e.stopPropagation();
                onDay(d);
              }}
            >
              {Number(d.slice(8))}
            </button>
            {list.slice(0, 3).map((o) => (
              <Block key={o.id} o={o} ctx={ctx} compact />
            ))}
            {list.length > 3 && (
              <button
                type="button"
                className="cal-more"
                onClick={(e) => {
                  e.stopPropagation();
                  onDay(d);
                }}
              >
                altri {list.length - 3}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
