import { HttpError } from '../auth.ts';
import { parseMac } from '../domain/policy.ts';
import { buildApModel, sectorWidth, type ApModel, type ClientSample } from '../domain/coverage-model.ts';
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
  /** overview.wirelessMode: "ap-ptmp", "ap-ptp", "sta-ptmp"… (empty when not reported). */
  wirelessMode: string;
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
  /** location.altitude as reported by UISP (GPS altitude a.s.l. on GPS devices), metres; null if not reported. */
  altitude: number | null;
  /** location.heading: antenna azimuth set in UISP, degrees; null if not set. */
  heading: number | null;
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
  /** description.height: antenna height above ground set on the site in UISP, metres. */
  height: number | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Altitude of a device from its GPS as reported by UISP. The field name is not documented: the
 * usual variants are read (location.altitude/elevation, overview.gps.altitude, gps.altitude).
 */
export function gpsAltitude(d: Json): number | null {
  const ov = obj(d.overview);
  const cands = [obj(d.location).altitude, obj(d.location).elevation, obj(ov.gps).altitude, obj(d.gps).altitude, obj(obj(d.identification).location).altitude];
  for (const c of cands) {
    const v = num(c) ?? (typeof c === 'string' && c.trim() !== '' && Number.isFinite(Number(c)) ? Number(c) : null);
    if (v !== null && v > -100 && v < 5000 && v !== 0) return v;
  }
  return null;
}

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
    wirelessMode: mode,
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
    altitude: gpsAltitude(d),
    heading: num(obj(d.location).heading),
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
    height: num(desc.height),
  };
}

export const isAp = (d: UispDevice) => d.role === 'ap' || d.role === 'accesspoint';
/** Customer APs follow the CDA Net naming: SSID "CDA-NET-N<pop>-D<district>". */
export const CUSTOMER_AP_SSID = /^CDA-NET-N\d+-D[A-Za-z0-9_-]+$/i;
/** "PTP Matrice vs A.7", "PTMP San Giovannello", "PtP Monte-Valle"… */
const BACKHAUL_NAME = /(^|[^a-z])pt(m)?p([^a-z]|$)/i;

/**
 * Point-to-point / backhaul links: by radio mode, by name (PTP…, PTMP…) or because their SSID is
 * not a CDA Net customer one (backhaul radios are often set up as APs). Never coverage targets,
 * never customer APs, and their far ends are not customer CPEs.
 */
export const isPtp = (d: Pick<UispDevice, 'wirelessMode'> & Partial<Pick<UispDevice, 'ssid' | 'name'>>) =>
  /(^|-)ptp$/.test(d.wirelessMode) || (!!d.name && BACKHAUL_NAME.test(d.name)) || (!!d.ssid && !CUSTOMER_AP_SSID.test(d.ssid));

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

  async function call(method: string, path: string, body?: unknown, raw = false, timeoutMs = 20_000): Promise<Response | unknown> {
    let r: Response;
    try {
      r = await f(`${base}${path}`, {
        method,
        headers: { 'x-auth-token': opts.token, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(raw ? 120_000 : timeoutMs),
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

  const inflight = new Map<string, Promise<unknown>>();
  /** Answers older than this are not served while refreshing. */
  const STALE_MAX_MS = 15 * 60_000;

  /**
   * Cache with one load at a time per key and stale-while-revalidate: on a big network UISP can
   * take 15-20 s to build the site list, so pages get the previous answer while it refreshes.
   */
  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load()
        .then((value) => {
          cache.set(key, { at: Date.now(), value });
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    if (hit && Date.now() - hit.at < STALE_MAX_MS) {
      p.catch(() => {}); // refreshed in background; errors are reported on the next cold call
      return hit.value as T;
    }
    return p;
  }

  // Full lists can be slow on large networks (1000+ devices): longer timeout than single calls.
  const devices = () => cached('devices', async () => ((await call('GET', '/devices', undefined, false, 60_000)) as unknown[]).map(normalizeDevice));
  const sites = () => cached('sites', async () => ((await call('GET', '/sites', undefined, false, 60_000)) as unknown[]).map(normalizeSite));
  const invalidate = () => {
    cache.clear();
    inflight.clear();
  };

  /** AP coordinates: device location, else its site location. */
  async function aps(): Promise<Array<UispDevice & { location: LatLon; siteHeight: number | null }>> {
    const [ds, ss] = await Promise.all([devices(), sites().catch(() => [] as UispSite[])]);
    const siteById = new Map(ss.map((s) => [s.id, s]));
    return ds
      .filter(isAp)
      .map((d) => {
        const site = d.siteId ? siteById.get(d.siteId) : undefined;
        return { ...d, location: d.location ?? site?.location ?? null, siteHeight: site?.height ?? null };
      })
      .filter((d): d is UispDevice & { location: LatLon; siteHeight: number | null } => d.location !== null);
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
        aps: ds.filter((d) => isAp(d) && !isPtp(d)).length,
        ptpLinks: ds.filter((d) => isAp(d) && isPtp(d)).length,
        apsWithLocation: (await aps()).filter((d) => !isPtp(d)).length,
        pending: ds.filter((d) => !d.authorized).length,
        sites: ss.length,
      };
    },

    /** APs with a position (device or site), for the power-outage zones. */
    async apsWithLocation() {
      return aps();
    },

    /**
     * Where the altitude of each AP comes from (Impostazioni server → Puntamento): its own GPS
     * altitude in UISP, the height of its site, or neither (then the configured antenna height).
     */
    async apAltitudeSources() {
      const list = (await aps()).filter((d) => !isPtp(d));
      const fallback = list.filter((d) => d.altitude === null && d.siteHeight === null);
      return {
        total: list.length,
        gps: list.filter((d) => d.altitude !== null).length,
        siteHeight: list.filter((d) => d.altitude === null && d.siteHeight !== null).length,
        fallback: fallback.map((d) => d.name).sort((a, b) => a.localeCompare(b, 'it', { numeric: true })),
      };
    },

    /**
     * Coverage model of each AP from its customers (position of the CPE or of its site, signal).
     * Positions stay on the server: callers expose only estimates.
     */
    async apModels(apIds: string[]) {
      const want = new Set(apIds);
      const [ds, ss] = await Promise.all([devices(), sites().catch(() => [] as UispSite[])]);
      const siteLoc = new Map(ss.map((s) => [s.id, s.location]));
      const apLoc = new Map(ds.filter(isAp).map((d) => [d.id, d.location ?? (d.siteId ? (siteLoc.get(d.siteId) ?? null) : null)]));
      const apDev = new Map(ds.filter(isAp).map((d) => [d.id, d]));
      const clients = new Map<string, ClientSample[]>();
      for (const d of ds) {
        if (!d.apId || !want.has(d.apId) || isAp(d)) continue;
        const loc = d.location ?? (d.siteId ? (siteLoc.get(d.siteId) ?? null) : null);
        if (!loc) continue;
        clients.set(d.apId, [...(clients.get(d.apId) ?? []), { lat: loc.lat, lon: loc.lon, signal: d.status === 'active' ? d.signal : null }]);
      }
      const out = new Map<string, ApModel>();
      for (const id of want) {
        const loc = apLoc.get(id);
        const ap = apDev.get(id);
        // azimuth set in UISP: the sector of the antenna instead of the one guessed from the customers
        const heading = ap?.heading != null ? { center: ap.heading, width: sectorWidth(ap.model) } : null;
        if (loc) out.set(id, buildApModel(loc, clients.get(id) ?? [], heading));
      }
      return out;
    },

    /** CPEs (stations) per AP id: how many and how many not active (Stato rete). */
    async cpeCounts() {
      const m = new Map<string, { total: number; offline: number }>();
      for (const d of await devices()) {
        if (!d.apId || isAp(d)) continue;
        const c = m.get(d.apId) ?? { total: 0, offline: 0 };
        c.total++;
        if (d.status !== 'active') c.offline++;
        m.set(d.apId, c);
      }
      return m;
    },

    /**
     * POPs and APs exactly as UISP knows them (name, address, coordinates and where the
     * position comes from): nothing is typed by hand in CDA Net.
     */
    async infrastructure() {
      const [ds, ss] = await Promise.all([devices(), sites()]);
      const pops = ss.filter((s) => s.type !== 'endpoint');
      // customer APs only: the backhaul links are not APs to monitor or assign
      const allAps = ds.filter((d) => isAp(d) && !isPtp(d));
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
          lastSeen: d.lastSeen,
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

    /** Nearest APs within maxKm (never the whole network); [allow] limits them (installers: only the assigned POPs/APs). */
    async nearestAps(from: LatLon, limit: number, maxKm: number, allow?: (ap: { id: string; siteId: string | null }) => boolean) {
      return (await aps())
        // coverage targets: PtMP APs only, never the PtP backhaul links
        .filter((d) => !isPtp(d))
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
            siteId: d.siteId ?? null,
            gpsAltitude: d.altitude,
            siteHeight: d.siteHeight,
            lat: d.location.lat,
            lon: d.location.lon,
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
      return ap?.siteId ? byId.get(ap.siteId) ?? { id: ap.siteId, name: ap.siteName ?? '', type: '', location: null, address: null, parentId: null, status: null, height: null } : null;
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

    // ---- Admin "Stato CPE": one device as in the UISP app (routes verified on UISP 3.1.65) ----
    /** Full UISP detail of a device (identity, overview, firmware/upgrade, meta, location…). */
    async deviceDetail(deviceId: string) {
      return call('GET', `/devices/${encodeURIComponent(deviceId)}/detail`);
    },
    async deviceInterfaces(deviceId: string) {
      return call('GET', `/devices/${encodeURIComponent(deviceId)}/interfaces`);
    },
    /** airMAX wireless configuration (includes keys: callers must filter it); null when offline. */
    async airmaxWireless(deviceId: string) {
      return call('GET', `/devices/airmaxes/${encodeURIComponent(deviceId)}/config/wireless`).catch(() => null);
    },
    /** UISP settings of the device: alias, note, maintenance mode (and ping/transmission overrides). */
    async deviceUnms(deviceId: string) {
      return call('GET', `/devices/${encodeURIComponent(deviceId)}/system/unms`);
    },
    async setDeviceUnms(deviceId: string, body: unknown) {
      const r = await call('PUT', `/devices/${encodeURIComponent(deviceId)}/system/unms`, body);
      invalidate();
      return r;
    },
    /** UISP accepts these even for an offline device (they simply do not reach it). */
    async restartDevice(deviceId: string) {
      return call('POST', `/devices/${encodeURIComponent(deviceId)}/restart`, {});
    },
    async refreshDevice(deviceId: string) {
      const r = await call('POST', `/devices/${encodeURIComponent(deviceId)}/refresh`, {});
      invalidate();
      return r;
    },
    /** Firmware upgrade to the latest version UISP has for the device (shown in its detail). */
    async upgradeDeviceToLatest(deviceId: string) {
      return call('POST', `/devices/${encodeURIComponent(deviceId)}/upgrade-to-latest`, {});
    },
    async applyBackup(deviceId: string, backupId: string) {
      return call('POST', `/devices/${encodeURIComponent(deviceId)}/backups/${encodeURIComponent(backupId)}/apply`, {});
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
