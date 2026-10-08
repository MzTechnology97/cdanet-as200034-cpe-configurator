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
  };
}

export const isAp = (d: UispDevice) => d.role === 'ap' || d.role === 'accesspoint';

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
    async nearestAps(from: LatLon, limit: number, maxKm: number) {
      return (await aps())
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
      return ap?.siteId ? byId.get(ap.siteId) ?? { id: ap.siteId, name: ap.siteName ?? '', type: '', location: null } : null;
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

    async createBackup(deviceId: string) {
      return call('POST', `/devices/${encodeURIComponent(deviceId)}/backups`, {});
    },

    async downloadBackup(deviceId: string, backupId: string) {
      return (await call('GET', `/devices/${encodeURIComponent(deviceId)}/backups/${encodeURIComponent(backupId)}`, undefined, true)) as Response;
    },
  };
}
export type Uisp = ReturnType<typeof createUisp>;
