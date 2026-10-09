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
}

export interface OutageConfig {
  apZones: boolean;
  apRadiusKm: number;
  includePlanned: boolean;
}

const DEFAULT_CONFIG: OutageConfig = { apZones: true, apRadiusKm: 3, includePlanned: true };

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

/** Zones containing an outage, nearest first. */
export function zonesOf(o: LatLon, zones: Zone[]): Array<{ zone: Zone; distanceM: number }> {
  return zones
    .map((zone) => ({ zone, distanceM: Math.round(distanceM(o, { lat: zone.lat, lon: zone.lon })) }))
    .filter((x) => x.distanceM <= x.zone.radiusKm * 1000)
    .sort((a, b) => a.distanceM - b.distanceM);
}

export function createOutages(
  db: Db,
  opts: { fetchImpl?: typeof fetch; getUisp: () => Uisp | null; notify: (html: string) => void; isOn: () => boolean; log?: (m: string) => void },
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

  const manualZones = (): Zone[] =>
    (db.prepare('SELECT id, name, lat, lon, radius_km radiusKm FROM outage_zones ORDER BY name').all() as Array<Omit<Zone, 'id' | 'source'> & { id: number }>).map((z) => ({
      ...z,
      id: `z${z.id}`,
      source: 'manual' as const,
    }));

  async function zones(): Promise<Zone[]> {
    const c = config();
    const out = manualZones();
    const u = opts.getUisp();
    if (c.apZones && u) {
      try {
        for (const ap of await u.apsWithLocation()) out.push({ id: `ap:${ap.id}`, name: ap.name || ap.ssid || ap.id, lat: ap.location.lat, lon: ap.location.lon, radiusKm: c.apRadiusKm, source: 'ap' });
      } catch (err) {
        opts.log?.(`outages: AP zones unavailable (${(err as Error).message})`);
      }
    }
    return out;
  }

  /** All outages inside the bounding box of the zones (paged, max 1000 per call). */
  async function fetchBox(zs: Zone[]): Promise<PowerOutage[]> {
    if (!zs.length) return [];
    const pad = (z: Zone) => z.radiusKm / 111;
    const box = [
      Math.min(...zs.map((z) => z.lon - pad(z) / Math.cos((z.lat * Math.PI) / 180))),
      Math.min(...zs.map((z) => z.lat - pad(z))),
      Math.max(...zs.map((z) => z.lon + pad(z) / Math.cos((z.lat * Math.PI) / 180))),
      Math.max(...zs.map((z) => z.lat + pad(z))),
    ];
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

  const describe = (o: PowerOutage, where: Array<{ zone: Zone; distanceM: number }>) => {
    const near = where[0]!;
    const dist = near.distanceM >= 1000 ? `${(near.distanceM / 1000).toFixed(1)} km` : `${near.distanceM} m`;
    const fmt = (s: string | null) => (s ? s.replace('T', ' ').slice(5).replace(/^(\d{2})-(\d{2})/, '$2/$1') : '—');
    return (
      `<b>${e(KIND_LABEL[o.kind])}</b> · ${e(o.place)} (${e(o.province)})\n` +
      `${near.zone.source === 'ap' ? 'AP' : 'Zona'} <b>${e(near.zone.name)}</b> a ${dist}${where.length > 1 ? ` (+${where.length - 1} altre)` : ''}\n` +
      `Clienti disalimentati: ${o.customers} · dal ${fmt(o.start)} · ripristino previsto ${fmt(o.expectedRestore)}\n` +
      `<a href="https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lon}#map=15/${o.lat}/${o.lon}">mappa</a> · fonte e-distribuzione`
    );
  };

  /** One polling cycle: store active outages in the zones, notify new ones and restorations. */
  async function refresh() {
    const c = config();
    try {
      const zs = await zones();
      const all = await fetchBox(zs);
      const inside = all
        .filter((o) => c.includePlanned || o.kind !== 'lavoro')
        .map((o) => ({ o, where: zonesOf(o, zs) }))
        .filter((x) => x.where.length > 0);
      const now = nowIso();
      const known = new Map((db.prepare('SELECT id, notified FROM power_outages WHERE ended_at IS NULL').all() as Array<{ id: number; notified: number }>).map((r) => [r.id, r]));
      const upsert = db.prepare(
        `INSERT INTO power_outages(id, data, zones, first_seen, last_seen, ended_at, notified) VALUES(?,?,?,?,?,NULL,0)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, zones = excluded.zones, last_seen = excluded.last_seen, ended_at = NULL`,
      );
      const seen = new Set<number>();
      for (const { o, where } of inside) {
        seen.add(o.id);
        upsert.run(o.id, JSON.stringify(o), JSON.stringify(where.map((w) => ({ id: w.zone.id, name: w.zone.name, source: w.zone.source, distanceM: w.distanceM }))), now, now);
        if (!known.has(o.id) && opts.isOn()) {
          opts.notify((o.kind === 'lavoro' ? '🛠️ ' : '⚡ ') + describe(o, where));
          db.prepare('UPDATE power_outages SET notified = 1 WHERE id = ?').run(o.id);
        }
      }
      for (const [id] of known) {
        if (seen.has(id)) continue;
        const row = db.prepare('SELECT data, zones FROM power_outages WHERE id = ?').get(id) as { data: string; zones: string };
        db.prepare('UPDATE power_outages SET ended_at = ? WHERE id = ?').run(now, id);
        const o = JSON.parse(row.data) as PowerOutage;
        const z = JSON.parse(row.zones) as Array<{ name: string }>;
        if (opts.isOn()) opts.notify(`✅ <b>Ripristinato</b> · ${e(KIND_LABEL[o.kind])} · ${e(o.place)} (${e(o.province)}) · ${e(z[0]?.name ?? '')}`);
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

  function active() {
    return (db.prepare('SELECT data, zones, first_seen FROM power_outages WHERE ended_at IS NULL').all() as Array<{ data: string; zones: string; first_seen: string }>)
      .map((r) => ({ ...(JSON.parse(r.data) as PowerOutage), zones: JSON.parse(r.zones) as Array<{ id: string; name: string; source: string; distanceM: number }>, firstSeen: r.first_seen }))
      .sort((a, b) => (a.kind === 'lavoro' ? 1 : 0) - (b.kind === 'lavoro' ? 1 : 0) || b.customers - a.customers);
  }

  function recent(hours = 48) {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return (db.prepare('SELECT data, zones, first_seen, ended_at FROM power_outages WHERE ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at DESC LIMIT 100').all(since) as Array<{ data: string; zones: string; first_seen: string; ended_at: string }>).map(
      (r) => ({ ...(JSON.parse(r.data) as PowerOutage), zones: JSON.parse(r.zones), firstSeen: r.first_seen, endedAt: r.ended_at }),
    );
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    config,
    setConfig,
    manualZones,
    zones,
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
