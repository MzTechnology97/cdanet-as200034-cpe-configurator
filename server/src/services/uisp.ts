import { HttpError } from '../auth.ts';
import { parseMac } from '../domain/policy.ts';
import { bearingDeg, cardinal, distanceM, isValidLatLon, type LatLon } from '../domain/geo.ts';

/**
 * UISP (UNMS) API v2.1 client: https://<uisp>/nms/api/v2.1, header x-auth-token.
 * Responses are parsed defensively (fields differ slightly between UISP versions)
 * and normalised to the shapes below. The token never leaves the server.
 */

export interface UispDevice {
  id: string;
  name: string;
  mac: string | null;
  model: string;
  role: string;
  authorized: boolean;
  status: string;
  firmware: string;
  ssid: string | null;
  siteId: string | null;
  siteName: string | null;
  apId: string | null;
  apName: string | null;
  /** Site of the associated AP as reported by UISP (attributes.apDevice.siteId). */
  apSiteId: string | null;
  signal: number | null;
  /** Speed of the main (LAN) port in Mbit/s: 10 often means a damaged cable. */
  ethMbps: number | null;
  ethHalfDuplex: boolean;
  dlCapacityMbps: number | null;
  stations: number | null;
  frequency: number | null;
  uptime: number | null;
  lastSeen: string | null;
  location: LatLon | null;
}

export interface UispSite {
  id: string;
  name: string;
  type: string;
  location: LatLon | null;
  /** description.address as typed in UISP. */
  address: string | null;
  parentId: string | null;
  status: string | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function latLon(v: unknown): LatLon | null {
  const o = obj(v);
  const lat = num(o.latitude ?? o.lat);
  const lon = num(o.longitude ?? o.lon ?? o.lng);
  return lat !== null && lon !== null && isValidLatLon(lat, lon) ? { lat, lon } : null;
}

/** overview.mainInterfaceSpeed = { availableSpeed: "100-full" | "1000-full" | "10-half" | … }. */
export function ethSpeed(v: unknown): { ethMbps: number | null; ethHalfDuplex: boolean } {
  const s = str(obj(v).availableSpeed) ?? (typeof v === 'string' ? v : null);
  const m = s ? /(\d+)\s*(?:mbps)?\s*-?\s*(full|half)?/i.exec(s) : null;
  return { ethMbps: m ? Number(m[1]) : null, ethHalfDuplex: (m?.[2] ?? '').toLowerCase() === 'half' };
}

export function normalizeDevice(raw: unknown): UispDevice {
  const d = obj(raw);
  const id = obj(d.identification);
  const ov = obj(d.overview);
  const at = obj(d.attributes);
  const site = obj(id.site);
  const ap = obj(at.apDevice);
  const role = (str(id.role) ?? '').toLowerCase();
  const mode = (str(ov.wirelessMode) ?? '').toLowerCase();
  return {
    id: str(id.id) ?? str(d.id) ?? '',
    name: str(id.displayName) ?? str(id.name) ?? str(id.hostname) ?? '',
    mac: parseMac(str(id.mac) ?? ''),
    model: str(id.modelName) ?? str(id.model) ?? '',
    role: role || (mode.startsWith('ap') ? 'ap' : mode.startsWith('sta') ? 'station' : ''),
    authorized: id.authorized !== false,
    status: str(ov.status) ?? 'unknown',
    firmware: str(id.firmwareVersion) ?? '',
    ssid: str(at.ssid) ?? str(ov.ssid) ?? null,
    siteId: str(site.id),
    siteName: str(site.name),
    apId: str(ap.id),
    apName: str(ap.name),
    apSiteId: str(ap.siteId),
    signal: num(ov.signal),
    ...ethSpeed(ov.mainInterfaceSpeed),
    dlCapacityMbps: num(ov.downlinkCapacity) !== null ? Math.round((num(ov.downlinkCapacity) as number) / 1e6) : null,
    stations: num(ov.stationsCount),
    frequency: num(ov.frequency),
    uptime: num(ov.uptime),
    lastSeen: str(ov.lastSeen),
    location: latLon(d.location) ?? latLon(obj(d.identification).location),
  };
}

export function normalizeSite(raw: unknown): UispSite {
  const s = obj(raw);
  const id = obj(s.identification);
  const desc = obj(s.description);
  return {
    id: str(s.id) ?? str(id.id) ?? '',
    name: str(id.name) ?? str(s.name) ?? '',
    type: str(id.type) ?? '',
    location: latLon(desc.location) ?? latLon(s.location),
    address: str(desc.address),
    parentId: str(obj(id.parent).id),
    status: str(id.status),
  };
}

export const isAp = (d: UispDevice) => d.role === 'ap' || d.role === 'accesspoint';

export type StatsRange = 'day' | 'week' | 'month';
const RANGE_MS: Record<StatsRange, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };
export interface SeriesSummary {
  points: Array<[number, number]>;
  min: number | null;
  avg: number | null;
  max: number | null;
  /** Average of the last quarter minus the first quarter of the period (negative = worsening). */
  trend: number | null;
}

/** `{avg: [{x, y}]}` series of /devices/{id}/statistics -> sorted points, downsampled, with summary. */
export function summarizeSeries(v: unknown, maxPoints = 200): SeriesSummary {
  const o = obj(v);
  const list = Array.isArray(o.avg) ? o.avg : Array.isArray(v) ? (v as unknown[]) : [];
  const pts = list
    .map((p) => [num(obj(p).x), num(obj(p).y)] as const)
    .filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null)
    .map(([x, y]) => [x, y] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (!pts.length) return { points: [], min: null, avg: null, max: null, trend: null };
  const ys = pts.map((p) => p[1]);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const q = Math.max(1, Math.floor(pts.length / 4));
  const step = Math.max(1, Math.ceil(pts.length / maxPoints));
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    points: pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(([x, y]) => [x, round(y)]),
    min: round(Math.min(...ys)),
    avg: round(mean(ys)),
    max: round(Math.max(...ys)),
    trend: pts.length >= 8 ? round(mean(ys.slice(-q)) - mean(ys.slice(0, q))) : null,
  };
}

export interface UispOptions {
  url: string;
  token: string;
  cacheSeconds?: number;
  fetchImpl?: typeof fetch;
}

export function createUisp(opts: UispOptions) {
  const base = `${opts.url.replace(/\/+$/, '')}/nms/api/v2.1`;
  const f = opts.fetchImpl ?? fetch;
  const ttl = (opts.cacheSeconds ?? 60) * 1000;
  const cache = new Map<string, { at: number; value: unknown }>();

  async function call(method: string, path: string, body?: unknown, raw = false): Promise<Response | unknown> {
    let r: Response;
    try {
      r = await f(`${base}${path}`, {
        method,
        headers: { 'x-auth-token': opts.token, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(raw ? 120_000 : 20_000),
      });
    } catch (e) {
      throw new HttpError(502, 'uisp_unreachable', { detail: (e as Error).message.slice(0, 200) });
    }
    if (r.status === 401 || r.status === 403) throw new HttpError(502, 'uisp_auth_failed', { status: r.status });
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 300);
      throw new HttpError(502, 'uisp_error', { status: r.status, path, detail: text });
    }
    if (raw) return r;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  const devices = () => cached('devices', async () => ((await call('GET', '/devices')) as unknown[]).map(normalizeDevice));
  const sites = () => cached('sites', async () => ((await call('GET', '/sites')) as unknown[]).map(normalizeSite));
  const invalidate = () => cache.clear();

  /** AP coordinates: device location, else its site location. */
  async function aps(): Promise<Array<UispDevice & { location: LatLon }>> {
    const [ds, ss] = await Promise.all([devices(), sites().catch(() => [] as UispSite[])]);
    const siteLoc = new Map(ss.map((s) => [s.id, s.location]));
    return ds
      .filter(isAp)
      .map((d) => ({ ...d, location: d.location ?? (d.siteId ? siteLoc.get(d.siteId) ?? null : null) }))
      .filter((d): d is UispDevice & { location: LatLon } => d.location !== null);
  }

  return {
    async test() {
      invalidate();
      const started = Date.now();
      const ver = obj(await call('GET', '/nms/version').catch(() => null));
      const [ds, ss] = await Promise.all([devices(), sites()]);
      return {
        ok: true,
        version: str(ver.version),
        deployment: str(ver.deployment),
        latencyMs: Date.now() - started,
        devices: ds.length,
        aps: ds.filter(isAp).length,
        apsWithLocation: (await aps()).length,
        pending: ds.filter((d) => !d.authorized).length,
        sites: ss.length,
      };
    },

    /** Nearest APs within maxKm (never the whole network). */
    /** APs with a position (device or site), for the power-outage zones. */
    async apsWithLocation() {
      return aps();
    },

    /**
     * POPs and APs exactly as UISP knows them (name, address, coordinates and where the
     * position comes from): nothing is typed by hand in CDA Net.
     */
    async infrastructure() {
      const [ds, ss] = await Promise.all([devices(), sites()]);
      const pops = ss.filter((s) => s.type !== 'endpoint');
      const allAps = ds.filter(isAp);
      const siteById = new Map(ss.map((s) => [s.id, s]));
      const ap = (d: UispDevice) => {
        const site = d.siteId ? siteById.get(d.siteId) : undefined;
        const loc = d.location ?? site?.location ?? null;
        return {
          id: d.id,
          name: d.name,
          ssid: d.ssid,
          model: d.model,
          status: d.status,
          stations: d.stations,
          lat: loc?.lat ?? null,
          lon: loc?.lon ?? null,
          locationFrom: d.location ? ('ap' as const) : loc ? ('pop' as const) : null,
          siteId: d.siteId,
          siteName: d.siteName,
        };
      };
      const aps = allAps.map(ap);
      return {
        pops: pops.map((s) => {
          const mine = aps.filter((a) => a.siteId === s.id);
          return {
            id: s.id,
            name: s.name,
            address: s.address,
            status: s.status,
            parentId: s.parentId,
            parentName: s.parentId ? (siteById.get(s.parentId)?.name ?? null) : null,
            lat: s.location?.lat ?? null,
            lon: s.location?.lon ?? null,
            aps: mine,
            stations: mine.reduce((t, a) => t + (a.stations ?? 0), 0),
          };
        }),
        apsWithoutPop: aps.filter((a) => !a.siteId || !siteById.has(a.siteId)),
      };
    },

    /** Nearest APs; [allow] limits them (installers: only the assigned POPs/APs). */
    async nearestAps(from: LatLon, limit: number, maxKm: number, allow?: (ap: { id: string; siteId: string | null }) => boolean) {
      return (await aps())
        .filter((d) => !allow || allow({ id: d.id, siteId: d.siteId ?? null }))
        .map((d) => {
          const m = distanceM(from, d.location);
          const b = bearingDeg(from, d.location);
          return {
            id: d.id,
            name: d.name,
            ssid: d.ssid,
            siteName: d.siteName,
            status: d.status,
            stations: d.stations,
            frequency: d.frequency,
            model: d.model,
            distanceM: Math.round(m),
            bearing: b,
            direction: cardinal(b),
          };
        })
        .filter((x) => x.distanceM <= maxKm * 1000)
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, limit);
    },

    async findByMac(...macs: Array<string | null | undefined>) {
      const wanted = new Set(macs.map((m) => (m ? parseMac(m) : null)).filter((m): m is string => !!m));
      if (!wanted.size) return null;
      invalidate(); // provisioning state changes quickly: always fresh
      return (await devices()).find((d) => d.mac && wanted.has(d.mac)) ?? null;
    },

    async device(id: string) {
      invalidate();
      return (await devices()).find((d) => d.id === id) ?? null;
    },

    /** Site for a newly provisioned station: the site of the AP it is associated with. */
    async siteForStation(st: UispDevice, ssid: string, near: LatLon | null): Promise<UispSite | null> {
      const [ds, ss] = await Promise.all([devices(), sites()]);
      const byId = new Map(ss.map((s) => [s.id, s]));
      if (st.apSiteId && byId.has(st.apSiteId)) return byId.get(st.apSiteId) as UispSite;
      let ap = st.apId ? ds.find((d) => d.id === st.apId) : undefined;
      if (!ap) {
        // Not associated yet (or UISP did not report it): APs broadcasting the job SSID, nearest first.
        const candidates = ds.filter((d) => isAp(d) && d.ssid === ssid);
        if (near) candidates.sort((a, b) => (a.location ? distanceM(near, a.location) : 1e12) - (b.location ? distanceM(near, b.location) : 1e12));
        ap = candidates[0];
      }
      return ap?.siteId ? byId.get(ap.siteId) ?? { id: ap.siteId, name: ap.siteName ?? '', type: '', location: null, address: null, parentId: null, status: null } : null;
    },

    /** All devices (cached like the rest: UISP is not hammered by the NOC page). */
    async allDevices() {
      return devices();
    },

    async sites() {
      return sites();
    },

    async authorize(deviceId: string, siteId: string) {
      // UISP v2.1: POST /devices/{id}/authorize {siteId}. Some builds expose it as PUT.
      try {
        await call('POST', `/devices/${encodeURIComponent(deviceId)}/authorize`, { siteId });
      } catch (e) {
        const st = (e as HttpError).extra?.status;
        if (st !== 404 && st !== 405) throw e;
        await call('PUT', `/devices/${encodeURIComponent(deviceId)}/authorize`, { siteId });
      }
      invalidate();
    },

    async backups(deviceId: string) {
      const list = (await call('GET', `/devices/${encodeURIComponent(deviceId)}/backups`)) as unknown[];
      return (Array.isArray(list) ? list : []).map((b) => {
        const o = obj(b);
        return {
          id: str(o.id) ?? '',
          timestamp: str(o.timestamp) ?? str(o.createdAt) ?? str(o.date) ?? null,
          type: str(o.type),
          extension: str(o.extension),
          filename: str(o.filename),
          note: str(o.note),
          pinned: o.pinned === true,
        };
      });
    },

    /** Lightweight reachability/auth check (used by the Telegram UISP monitor). */
    async ping() {
      await call('GET', '/nms/version');
    },

    /** Signal / capacity history of a device (UISP statistics), summarised for the history page. */
    async statistics(deviceId: string, range: StatsRange) {
      const period = RANGE_MS[range];
      const q = new URLSearchParams({ interval: range, start: String(Date.now() - period), period: String(period) });
      const s = obj(await call('GET', `/devices/${encodeURIComponent(deviceId)}/statistics?${q}`));
      return {
        range,
        signal: summarizeSeries(s.signal),
        remoteSignal: summarizeSeries(s.remoteSignal),
        downlinkCapacity: summarizeSeries(s.downlinkCapacity),
        uplinkCapacity: summarizeSeries(s.uplinkCapacity),
        ping: summarizeSeries(s.ping),
      };
    },

    /** Outages of a device in the period (UISP /outages). */
    async outages(deviceId: string, range: StatsRange) {
      const period = RANGE_MS[range];
      const q = new URLSearchParams({ count: '50', page: '1', deviceId, start: String(Date.now() - period), period: String(period) });
      const r = obj(await call('GET', `/outages?${q}`));
      return (Array.isArray(r.items) ? r.items : []).map((it) => {
        const o = obj(it);
        return { start: str(o.startTimestamp), end: str(o.endTimestamp), type: str(o.type), inProgress: o.inProgress === true, seconds: num(o.aggregatedTime) };
      });
    },

    async createBackup(deviceId: string) {
      return call('POST', `/devices/${encodeURIComponent(deviceId)}/backups`, {});
    },

    async downloadBackup(deviceId: string, backupId: string) {
      return (await call('GET', `/devices/${encodeURIComponent(deviceId)}/backups/${encodeURIComponent(backupId)}`, undefined, true)) as Response;
    },
  };
}
export type Uisp = ReturnType<typeof createUisp>;
