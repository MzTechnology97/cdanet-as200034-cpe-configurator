import { distanceM, type LatLon } from '../domain/geo.ts';
import { nowIso, type Db } from '../db.ts';
import { escapeHtml as e } from './telegram.ts';
import type { Uisp } from './uisp.ts';

/**
 * Power outages of the Italian distribution network (e-distribuzione public outage map,
 * ArcGIS FeatureServer), filtered on CDA Net areas of interest: manual zones and, optionally,
 * a radius around every UISP AP. New outages and restorations are notified once.
 * Source: https://www.e-distribuzione.it (public map data, polled every 10 minutes).
 */

export const OUTAGE_SOURCE = 'https://dpa-portalgis.enel.com/server/rest/services/Hosted/ITA_power_cut_map_layer_View/FeatureServer/0';

export interface PowerOutage {
  id: number;
  kind: 'guasto_mt' | 'guasto_bt' | 'lavoro' | 'altro';
  cause: string;
  customers: number;
  start: string | null;
  expectedRestore: string | null;
  updated: string | null;
  place: string;
  province: string;
  lat: number;
  lon: number;
}

export interface Zone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
  source: 'manual' | 'ap';
  /** Personal zone of an installer (null/undefined = shared zone of the admins, or a UISP POP/AP). */
  ownerId?: number | null;
}

export interface OutageConfig {
  apZones: boolean;
  apRadiusKm: number;
  includePlanned: boolean;
  /** POPs/APs closer than this to an outage are reported as potentially affected. */
  impactRadiusKm: number;
  /** Monitor only the POPs/APs selected by the admin (imported from UISP) instead of all of them. */
  selectionOnly: boolean;
}

const DEFAULT_CONFIG: OutageConfig = { apZones: true, apRadiusKm: 3, includePlanned: true, impactRadiusKm: 1, selectionOnly: false };

/** A POP/AP/zone reference: "pop:<uisp id>", "ap:<uisp id>" or "z<zone id>" (same as zone ids). */
export interface ItemRef {
  key: string;
  name: string;
}

/** A POP (UISP site) or AP very close to an outage: probably without mains power. */
export interface Impact {
  type: 'pop' | 'ap';
  id: string;
  name: string;
  distanceM: number;
  /** CPEs on the AP (or on all APs of the POP). */
  stations: number | null;
  /** UISP site of the AP (the POP itself for a POP). */
  popId?: string | null;
}

export const impactKey = (i: Pick<Impact, 'type' | 'id'>) => `${i.type}:${i.id}`;

/**
 * What an installer may see of an outage: only the assigned POPs/APs/zones (a POP covers its APs).
 * Returns null when nothing assigned is involved.
 */
export function scopeOutage<T extends { impact: Impact[]; zones: Array<{ id: string }> }>(o: T, keys: Set<string>): T | null {
  const mine = (i: Impact) => keys.has(impactKey(i)) || (i.popId ? keys.has(`pop:${i.popId}`) : false);
  const impact = o.impact.filter(mine);
  const zones = o.zones.filter((z) => keys.has(z.id));
  return impact.length || zones.length ? { ...o, impact, zones } : null;
}

export interface Infra {
  pops: Array<{ id: string; name: string; lat: number; lon: number; stations: number | null }>;
  aps: Array<{ id: string; name: string; lat: number; lon: number; stations: number | null; siteId: string | null }>;
}

/** POPs and APs within [radiusKm] of an outage, nearest first (pure, unit-tested). */
export function impactOf(o: LatLon, infra: Infra, radiusKm: number): Impact[] {
  const max = radiusKm * 1000;
  const near = <T extends { lat: number; lon: number }>(xs: T[]) =>
    xs.map((x) => ({ x, d: Math.round(distanceM(o, { lat: x.lat, lon: x.lon })) })).filter((v) => v.d <= max);
  return [
    ...near(infra.pops).map(({ x, d }) => ({ type: 'pop' as const, id: x.id, name: x.name, distanceM: d, stations: x.stations, popId: x.id })),
    ...near(infra.aps).map(({ x, d }) => ({ type: 'ap' as const, id: x.id, name: x.name, distanceM: d, stations: x.stations, popId: x.siteId })),
  ].sort((a, b) => a.distanceM - b.distanceM);
}

const shortDate = (s: string | null) => (s ? s.replace('T', ' ').slice(5).replace(/^(\d{2})-(\d{2})/, '$2/$1') : '—');

/** Personal Telegram message (the outage already reduced to what the user may see). */
export function personalText(o: PowerOutage & { impact: Impact[]; zones: Array<{ name: string; distanceM?: number }> }, kind: 'new' | 'restored'): string {
  const z = o.zones[0];
  const where = z ? ` · ${e(z.name)}${z.distanceM != null ? ` a ${z.distanceM >= 1000 ? `${(z.distanceM / 1000).toFixed(1)} km` : `${z.distanceM} m`}` : ''}` : '';
  const imp = o.impact.length
    ? `\n⚠️ <b>Potenzialmente impattati</b>: ${o.impact
        .slice(0, 5)
        .map((i) => `${i.type === 'pop' ? 'POP' : 'AP'} <b>${e(i.name)}</b> ${i.distanceM} m${i.stations != null ? ` (${i.stations} CPE)` : ''}`)
        .join(' · ')}`
    : '';
  if (kind === 'restored') return `✅ <b>Ripristinato</b> · ${e(KIND_LABEL[o.kind])} · ${e(o.place)} (${e(o.province)})${where}`;
  return (
    `${o.impact.length ? '🚨' : o.kind === 'lavoro' ? '🛠️' : '⚡'} <b>${e(KIND_LABEL[o.kind])}</b> · ${e(o.place)} (${e(o.province)})${where}\n` +
    `Clienti disalimentati: ${o.customers} · dal ${shortDate(o.start)} · ripristino previsto ${shortDate(o.expectedRestore)}\n` +
    `<a href="https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lon}#map=15/${o.lat}/${o.lon}">mappa</a> · fonte e-distribuzione` +
    imp
  );
}

/** "09/10/2026 15:50" (Italian local time) -> ISO; null when missing. */
export function parseEnelDate(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/.exec(v) : null;
  if (!m) return null;
  // e-distribuzione publishes Europe/Rome wall time: keep it as a local timestamp string.
  return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`;
}

export function mapFeature(f: unknown): PowerOutage | null {
  const a = ((f as { attributes?: Record<string, unknown> })?.attributes ?? {}) as Record<string, unknown>;
  const g = (f as { geometry?: { x?: number; y?: number } })?.geometry ?? {};
  const lat = typeof a.latitudine === 'number' ? a.latitudine : g.y;
  const lon = typeof a.longitudine === 'number' ? a.longitudine : g.x;
  const id = Number(a.id_interruzione);
  if (!Number.isFinite(id) || typeof lat !== 'number' || typeof lon !== 'number') return null;
  const code = String(a.causa_interruzione ?? '');
  return {
    id,
    kind: code === 'GM' ? 'guasto_mt' : code === 'GB' ? 'guasto_bt' : code === 'LV' ? 'lavoro' : 'altro',
    cause: String(a.causa_disalimentazione ?? ''),
    customers: Number(a.num_cli_disalim ?? 0) || 0,
    start: parseEnelDate(a.data_interruzione),
    expectedRestore: parseEnelDate(a.data_prev_ripristino),
    updated: parseEnelDate(a.dataultimoaggiornamento),
    place: String(a.descrizione_territoriale ?? '').trim(),
    province: String(a.provincia ?? ''),
    lat,
    lon,
  };
}

export const KIND_LABEL: Record<PowerOutage['kind'], string> = {
  guasto_mt: 'Guasto media tensione',
  guasto_bt: 'Guasto bassa tensione',
  lavoro: 'Lavoro programmato',
  altro: 'Interruzione',
};

type Box = [number, number, number, number];

/** Bounding boxes of the zones, merging the ones closer than [gapDeg]: far-apart areas become separate queries. */
export function zoneBoxes(zs: Array<Pick<Zone, 'lat' | 'lon' | 'radiusKm'>>, gapDeg = 0.1): Box[] {
  const boxes: Box[] = zs.map((z) => {
    const dLat = z.radiusKm / 111;
    const dLon = dLat / Math.max(0.1, Math.cos((z.lat * Math.PI) / 180));
    return [z.lon - dLon, z.lat - dLat, z.lon + dLon, z.lat + dLat];
  });
  const near = (a: Box, b: Box) => a[0] - gapDeg <= b[2] && b[0] - gapDeg <= a[2] && a[1] - gapDeg <= b[3] && b[1] - gapDeg <= a[3];
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (near(a, b)) {
          boxes[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
          boxes.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return boxes;
}

/** Zones containing an outage, nearest first. */
export function zonesOf(o: LatLon, zones: Zone[]): Array<{ zone: Zone; distanceM: number }> {
  return zones
    .map((zone) => ({ zone, distanceM: Math.round(distanceM(o, { lat: zone.lat, lon: zone.lon })) }))
    .filter((x) => x.distanceM <= x.zone.radiusKm * 1000)
    .sort((a, b) => a.distanceM - b.distanceM);
}

export function createOutages(
  db: Db,
  opts: {
    fetchImpl?: typeof fetch;
    getUisp: () => Uisp | null;
    notify: (html: string) => void;
    isOn: () => boolean;
    log?: (m: string) => void;
    /** Personal Telegram message to one user (bot of the admin). */
    sendPersonal?: (chatId: string, html: string) => void;
    /** The user may receive outage notifications (module on for them). */
    userOn?: (userId: number) => boolean;
  },
) {
  const f = opts.fetchImpl ?? fetch;
  let lastRun: { at: string; ok: boolean; error?: string; fetched: number } | null = null;

  const config = (): OutageConfig => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'outages.config'").get() as { value: string } | undefined;
    return { ...DEFAULT_CONFIG, ...(r ? (JSON.parse(r.value) as Partial<OutageConfig>) : {}) };
  };

  function setConfig(c: Partial<OutageConfig>, userId: number) {
    const next = { ...config(), ...c };
    db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES('outages.config', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(JSON.stringify(next), nowIso(), userId);
    return next;
  }

  /** Manual zones: 'shared' = the admins' ones, a user id = that installer's personal ones, 'all' = every zone. */
  const manualZones = (owner: 'shared' | 'all' | number = 'shared'): Zone[] => {
    const where = owner === 'all' ? '' : owner === 'shared' ? 'WHERE owner_id IS NULL' : 'WHERE owner_id = ?';
    const rows = db.prepare(`SELECT id, name, lat, lon, radius_km radiusKm, owner_id ownerId FROM outage_zones ${where} ORDER BY name`).all(...(typeof owner === 'number' ? [owner] : [])) as Array<
      Omit<Zone, 'id' | 'source'> & { id: number }
    >;
    return rows.map((z) => ({ ...z, id: `z${z.id}`, source: 'manual' as const }));
  };

  // ---- POPs/APs selected from UISP and assignments to installers --------------------------
  const selection = (): ItemRef[] => db.prepare('SELECT key, name FROM outage_selection ORDER BY name').all() as unknown as ItemRef[];

  function replaceAll(del: () => void, insert: () => void) {
    db.exec('BEGIN');
    try {
      del();
      insert();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function setSelection(items: ItemRef[], selectionOnly: boolean, userId: number) {
    const ins = db.prepare('INSERT OR REPLACE INTO outage_selection(key, name, added_at) VALUES(?,?,?)');
    replaceAll(
      () => db.prepare('DELETE FROM outage_selection').run(),
      () => items.forEach((it) => ins.run(it.key, it.name, nowIso())),
    );
    return { config: setConfig({ selectionOnly }, userId), items: selection() };
  }

  /** null = everything (no selection in use). */
  const monitored = (): Set<string> | null => (config().selectionOnly ? new Set(selection().map((i) => i.key)) : null);

  const assignments = (userId: number): ItemRef[] =>
    db.prepare('SELECT key, name FROM outage_assignments WHERE user_id = ? ORDER BY name').all(userId) as unknown as ItemRef[];

  function allAssignments() {
    const m = new Map<number, ItemRef[]>();
    for (const r of db.prepare('SELECT user_id userId, key, name FROM outage_assignments ORDER BY name').all() as unknown as Array<ItemRef & { userId: number }>) {
      m.set(r.userId, [...(m.get(r.userId) ?? []), { key: r.key, name: r.name }]);
    }
    return m;
  }

  function setAssignments(userId: number, items: ItemRef[]) {
    const ins = db.prepare('INSERT OR REPLACE INTO outage_assignments(user_id, key, name, added_at) VALUES(?,?,?,?)');
    replaceAll(
      () => db.prepare('DELETE FROM outage_assignments WHERE user_id = ?').run(userId),
      () => items.forEach((it) => ins.run(userId, it.key, it.name, nowIso())),
    );
    return assignments(userId);
  }

  /**
   * What a user sees: admins everything (undefined); installers their own zones plus the
   * POPs/APs/zones assigned by the admin (impacts only for the assigned ones).
   */
  const keysFor = (userId: number, role: string): Set<string> | undefined =>
    role === 'admin' ? undefined : new Set([...assignments(userId).map((i) => i.key), ...manualZones(userId).map((z) => z.id)]);

  type Stored = PowerOutage & { impact: Impact[]; zones: Array<{ id: string; name: string; source?: string; distanceM?: number; ownerId?: number | null }> };

  /** Personal Telegram messages: each linked user gets what they may see, nothing else. */
  function personal(kind: 'new' | 'restored', rec: Stored) {
    if (!opts.sendPersonal) return;
    const users = db.prepare("SELECT id, role, telegram_chat_id chat, telegram_planned planned FROM users WHERE active = 1 AND telegram_chat_id <> ''").all() as Array<{
      id: number;
      role: string;
      chat: string;
      planned: number;
    }>;
    for (const u of users) {
      if (opts.userOn && !opts.userOn(u.id)) continue;
      if (rec.kind === 'lavoro' && !u.planned) continue;
      const keys = keysFor(u.id, u.role);
      const v = keys ? scopeOutage(rec, keys) : rec;
      if (v) opts.sendPersonal(u.chat, personalText(v, kind));
    }
  }

  /** UISP POPs (sites with a position) and APs with the CPE count of each (only the selected ones in selection mode). */
  async function infra(): Promise<Infra> {
    const u = opts.getUisp();
    if (!u) return { pops: [], aps: [] };
    try {
      const [aps, sites] = await Promise.all([u.apsWithLocation(), u.sites()]);
      const perSite = new Map<string, number>();
      for (const a of aps) if (a.siteId) perSite.set(a.siteId, (perSite.get(a.siteId) ?? 0) + (a.stations ?? 0));
      const sel = monitored();
      return {
        pops: sites
          .filter((s) => s.location && s.type !== 'endpoint' && (!sel || sel.has(`pop:${s.id}`)))
          .map((s) => ({ id: s.id, name: s.name, lat: s.location!.lat, lon: s.location!.lon, stations: perSite.get(s.id) ?? null })),
        aps: aps
          .filter((a) => !sel || sel.has(`ap:${a.id}`))
          .map((a) => ({ id: a.id, name: a.name || a.ssid || a.id, lat: a.location.lat, lon: a.location.lon, stations: a.stations, siteId: a.siteId })),
      };
    } catch (err) {
      opts.log?.(`outages: UISP infrastructure unavailable (${(err as Error).message})`);
      return { pops: [], aps: [] };
    }
  }

  async function zones(): Promise<Zone[]> {
    const c = config();
    const out = manualZones('all');
    const u = opts.getUisp();
    if (c.apZones && u) {
      try {
        // Positions straight from UISP: every AP (own position or its POP's) and every POP, or only the selected ones.
        const sel = monitored();
        for (const ap of await u.apsWithLocation()) {
          if (!sel || sel.has(`ap:${ap.id}`)) out.push({ id: `ap:${ap.id}`, name: ap.name || ap.ssid || ap.id, lat: ap.location.lat, lon: ap.location.lon, radiusKm: c.apRadiusKm, source: 'ap' });
        }
        for (const s of await u.sites()) {
          if (s.type !== 'endpoint' && s.location && (!sel || sel.has(`pop:${s.id}`))) {
            out.push({ id: `pop:${s.id}`, name: `POP ${s.name}`, lat: s.location.lat, lon: s.location.lon, radiusKm: c.apRadiusKm, source: 'ap' });
          }
        }
      } catch (err) {
        opts.log?.(`outages: AP zones unavailable (${(err as Error).message})`);
      }
    }
    return out;
  }

  /** All outages inside the boxes of the zones (one query per group of nearby zones, deduplicated). */
  async function fetchBox(zs: Zone[]): Promise<PowerOutage[]> {
    const byId = new Map<number, PowerOutage>();
    for (const box of zoneBoxes(zs)) for (const o of await fetchOne(box)) byId.set(o.id, o);
    return [...byId.values()];
  }

  /** Outages in one box (paged, max 1000 per call). */
  async function fetchOne(box: Box): Promise<PowerOutage[]> {
    const out: PowerOutage[] = [];
    for (let offset = 0; offset < 10_000; offset += 1000) {
      const q = new URLSearchParams({
        f: 'json',
        where: '1=1',
        outFields: '*',
        returnGeometry: 'true',
        outSR: '4326',
        inSR: '4326',
        geometry: box.map((n) => n.toFixed(5)).join(','),
        geometryType: 'esriGeometryEnvelope',
        spatialRel: 'esriSpatialRelIntersects',
        resultOffset: String(offset),
        resultRecordCount: '1000',
      });
      const r = await f(`${OUTAGE_SOURCE}/query?${q}`, { headers: { 'User-Agent': 'CDA-Net-CPE-Configurator (AS200034)' }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`e-distribuzione HTTP ${r.status}`);
      const j = (await r.json()) as { features?: unknown[]; exceededTransferLimit?: boolean; error?: { message?: string } };
      if (j.error) throw new Error(`e-distribuzione: ${j.error.message ?? 'errore'}`);
      for (const feat of j.features ?? []) {
        const o = mapFeature(feat);
        if (o) out.push(o);
      }
      if (!j.exceededTransferLimit || !(j.features ?? []).length) break;
    }
    return out;
  }

  const impactText = (imp: Impact[]) => {
    if (!imp.length) return '';
    const fmt = (i: Impact) => `${i.type === 'pop' ? 'POP' : 'AP'} <b>${e(i.name)}</b> ${i.distanceM} m${i.stations != null ? ` (${i.stations} CPE)` : ''}`;
    return `\n⚠️ <b>Potenzialmente impattati</b>: ${imp.slice(0, 5).map(fmt).join(' · ')}${imp.length > 5 ? ` e altri ${imp.length - 5}` : ''}`;
  };

  const describe = (o: PowerOutage, where: Array<{ zone: Zone; distanceM: number }>, imp: Impact[] = []) => {
    const near = where[0]!;
    const dist = near.distanceM >= 1000 ? `${(near.distanceM / 1000).toFixed(1)} km` : `${near.distanceM} m`;
    const fmt = (s: string | null) => (s ? s.replace('T', ' ').slice(5).replace(/^(\d{2})-(\d{2})/, '$2/$1') : '—');
    return (
      `<b>${e(KIND_LABEL[o.kind])}</b> · ${e(o.place)} (${e(o.province)})\n` +
      `${near.zone.source === 'ap' ? 'AP' : 'Zona'} <b>${e(near.zone.name)}</b> a ${dist}${where.length > 1 ? ` (+${where.length - 1} altre)` : ''}\n` +
      `Clienti disalimentati: ${o.customers} · dal ${fmt(o.start)} · ripristino previsto ${fmt(o.expectedRestore)}\n` +
      `<a href="https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lon}#map=15/${o.lat}/${o.lon}">mappa</a> · fonte e-distribuzione` +
      impactText(imp)
    );
  };

  /** One polling cycle: store active outages in the zones, notify new ones and restorations. */
  async function refresh() {
    const c = config();
    try {
      const zs = await zones();
      const all = await fetchBox(zs);
      const inf = await infra();
      const inside = all
        .filter((o) => c.includePlanned || o.kind !== 'lavoro')
        .map((o) => ({ o, where: zonesOf(o, zs), impact: impactOf(o, inf, c.impactRadiusKm) }))
        .filter((x) => x.where.length > 0 || x.impact.length > 0);
      const now = nowIso();
      const known = new Map((db.prepare('SELECT id, notified FROM power_outages WHERE ended_at IS NULL').all() as Array<{ id: number; notified: number }>).map((r) => [r.id, r]));
      const upsert = db.prepare(
        `INSERT INTO power_outages(id, data, zones, first_seen, last_seen, ended_at, notified) VALUES(?,?,?,?,?,NULL,0)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, zones = excluded.zones, last_seen = excluded.last_seen, ended_at = NULL`,
      );
      const seen = new Set<number>();
      for (const { o, where, impact } of inside) {
        seen.add(o.id);
        upsert.run(
          o.id,
          JSON.stringify({ ...o, impact }),
          JSON.stringify(where.map((w) => ({ id: w.zone.id, name: w.zone.name, source: w.zone.source, distanceM: w.distanceM, ownerId: w.zone.ownerId ?? null }))),
          now,
          now,
        );
        // Telegram (the team's group) only for shared zones, POP/AP zones and impacts: personal zones notify on the installer's phone.
        const shared = where.filter((w) => w.zone.ownerId == null);
        if (!known.has(o.id) && opts.isOn()) {
          personal('new', { ...o, impact, zones: where.map((w) => ({ id: w.zone.id, name: w.zone.name, source: w.zone.source, distanceM: w.distanceM, ownerId: w.zone.ownerId ?? null })) });
        }
        if (!known.has(o.id) && opts.isOn() && (shared.length || impact.length)) {
          const whereFor = shared.length ? shared : impact.slice(0, 1).map((i) => ({ zone: { id: i.id, name: i.name, lat: 0, lon: 0, radiusKm: 0, source: 'ap' as const }, distanceM: i.distanceM }));
          opts.notify((impact.length ? '🚨 ' : o.kind === 'lavoro' ? '🛠️ ' : '⚡ ') + describe(o, whereFor, impact));
          db.prepare('UPDATE power_outages SET notified = 1 WHERE id = ?').run(o.id);
        }
      }
      for (const [id] of known) {
        if (seen.has(id)) continue;
        const row = db.prepare('SELECT data, zones FROM power_outages WHERE id = ?').get(id) as { data: string; zones: string };
        db.prepare('UPDATE power_outages SET ended_at = ? WHERE id = ?').run(now, id);
        const o = JSON.parse(row.data) as PowerOutage;
        if (opts.isOn()) personal('restored', { ...o, impact: (o as Stored).impact ?? [], zones: JSON.parse(row.zones) as Stored['zones'] });
        const z = (JSON.parse(row.zones) as Array<{ name: string; ownerId?: number | null }>).filter((x) => x.ownerId == null);
        const imp = (o as PowerOutage & { impact?: Impact[] }).impact ?? [];
        const extra = imp.length ? ` · POP/AP coinvolti: ${imp.slice(0, 3).map((i) => e(i.name)).join(', ')}` : '';
        if (opts.isOn() && (z.length || imp.length)) opts.notify(`✅ <b>Ripristinato</b> · ${e(KIND_LABEL[o.kind])} · ${e(o.place)} (${e(o.province)}) · ${e(z[0]?.name ?? '')}${extra}`);
      }
      // keep 30 days of history
      db.prepare('DELETE FROM power_outages WHERE ended_at IS NOT NULL AND ended_at < ?').run(new Date(Date.now() - 30 * 86400_000).toISOString());
      lastRun = { at: now, ok: true, fetched: all.length };
    } catch (err) {
      lastRun = { at: nowIso(), ok: false, error: (err as Error).message, fetched: 0 };
      opts.log?.(`outages: ${(err as Error).message}`);
    }
    return lastRun;
  }

  /** Active outages; with [keys] only those involving the assigned POPs/APs/zones (installer view). */
  function active(keys?: Set<string>) {
    const all = (db.prepare('SELECT data, zones, first_seen FROM power_outages WHERE ended_at IS NULL').all() as Array<{ data: string; zones: string; first_seen: string }>)
      .map((r) => {
        const d = JSON.parse(r.data) as PowerOutage & { impact?: Impact[] };
        return { ...d, impact: d.impact ?? [], zones: JSON.parse(r.zones) as Array<{ id: string; name: string; source: string; distanceM: number }>, firstSeen: r.first_seen };
      })
      // impacted POPs/APs first, then faults, then by customers
      .sort((a, b) => (b.impact.length ? 1 : 0) - (a.impact.length ? 1 : 0) || (a.kind === 'lavoro' ? 1 : 0) - (b.kind === 'lavoro' ? 1 : 0) || b.customers - a.customers);
    return keys ? all.map((o) => scopeOutage(o, keys)).filter((o) => o !== null) : all;
  }

  function recent(hours = 48, keys?: Set<string>) {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const rows = db.prepare('SELECT data, zones, first_seen, ended_at FROM power_outages WHERE ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at DESC LIMIT 100').all(since) as Array<{
      data: string;
      zones: string;
      first_seen: string;
      ended_at: string;
    }>;
    const all = rows.map((r) => {
      const d = JSON.parse(r.data) as PowerOutage & { impact?: Impact[] };
      return { ...d, impact: d.impact ?? [], zones: JSON.parse(r.zones) as Array<{ id: string; name: string }>, firstSeen: r.first_seen, endedAt: r.ended_at };
    });
    return keys ? all.map((o) => scopeOutage(o, keys)).filter((o) => o !== null) : all;
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    config,
    setConfig,
    manualZones,
    keysFor,
    zones,
    infra,
    selection,
    setSelection,
    assignments,
    allAssignments,
    setAssignments,
    refresh,
    active,
    recent,
    status: () => lastRun,
    start(everyMs = 10 * 60_000) {
      const tick = () => {
        if (opts.isOn()) void refresh();
      };
      timer = setInterval(tick, everyMs);
      timer.unref();
      setTimeout(tick, 45_000).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
export type Outages = ReturnType<typeof createOutages>;
