import type { Sealer } from '../crypto.ts';
import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { HttpError } from '../auth.ts';

/**
 * Immagini satellitari (Connettori): aerial imagery for the admins' maps of the console from one or
 * more providers, to compare them and keep the best one. Keys are sealed on the server and every
 * tile is fetched here for authenticated admins only: no key reaches a browser and installers keep
 * the usual basemap. Providers:
 * - Mapbox: satellite and satellite-streets (token);
 * - Esri: World Imagery, with roads and places on top for the hybrid view (ArcGIS API key);
 * - Google: Map Tiles API, satellite and satellite with roads (API key, billing account);
 * - WMS: public orthophotos (default: AGEA 2012 of the Geoportale Nazionale), no key.
 */

export const PROVIDERS = ['mapbox', 'esri', 'google', 'wms'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Tile parts each provider serves (a hybrid view may stack several). */
export const PARTS: Record<Provider, readonly string[]> = {
  mapbox: ['satellite', 'hybrid'],
  esri: ['satellite', 'roads', 'labels'],
  google: ['satellite', 'hybrid'],
  wms: ['ortofoto'],
};

export const WMS_DEFAULT = {
  url: 'http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map',
  layers: 'OI.ORTOIMMAGINI.2012.32,OI.ORTOIMMAGINI.2012.33',
  label: 'Ortofoto AGEA 2012',
  attribution: 'Ortofoto AGEA 2012 – Geoportale Nazionale (MASE)',
};

const ATTRIBUTION: Record<Exclude<Provider, 'wms'>, string> = {
  mapbox: '© Mapbox © OpenStreetMap © Maxar',
  esri: 'Esri, Maxar, Earthstar Geographics, GIS User Community',
  google: 'Immagini © Google',
};
const LABEL: Record<Exclude<Provider, 'wms'>, string> = { mapbox: 'Mapbox', esri: 'Esri', google: 'Google' };

/** Key formats: Mapbox "pk./sk.", Google "AIza…", ArcGIS API keys (long, url-safe). */
export const KEY_FORMAT: Record<Exclude<Provider, 'wms'>, RegExp> = {
  mapbox: /^(pk|sk)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  esri: /^[A-Za-z0-9_.-]{20,600}$/,
  google: /^AIza[0-9A-Za-z_-]{30,40}$/,
};

interface KeyProvider {
  enabled: boolean;
  keySealed: string;
}
interface WmsProvider {
  enabled: boolean;
  url: string;
  layers: string;
  label: string;
  attribution: string;
}
interface Stored {
  mapbox?: KeyProvider;
  esri?: KeyProvider;
  google?: KeyProvider;
  wms?: WmsProvider;
}

const KEY = 'connector.imagery';

/** Web Mercator bounds of a tile, metres (EPSG:3857). */
export function tileBounds3857(z: number, x: number, y: number): [number, number, number, number] {
  const W = 20037508.342789244;
  const size = (2 * W) / 2 ** z;
  return [-W + x * size, W - (y + 1) * size, -W + (x + 1) * size, W - y * size];
}

/** GetMap URL of one 256 px tile from a WMS 1.3.0 service in EPSG:3857. */
export function wmsTileUrl(base: string, layers: string, z: number, x: number, y: number): string {
  const [minx, miny, maxx, maxy] = tileBounds3857(z, x, y);
  const q = new URLSearchParams({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.3.0', LAYERS: layers, STYLES: '', CRS: 'EPSG:3857', BBOX: `${minx},${miny},${maxx},${maxy}`, WIDTH: '256', HEIGHT: '256', FORMAT: 'image/jpeg' });
  return `${base}${base.includes('?') ? '&' : '?'}${q}`;
}

/** Upstream URL of a tile of Mapbox or Esri (Google needs a session, see [createImagery]). */
export function keyTileUrl(provider: 'mapbox' | 'esri', part: string, z: number, x: number, y: number, key: string): string {
  const k = encodeURIComponent(key);
  if (provider === 'mapbox') {
    return part === 'satellite'
      ? `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg90?access_token=${k}`
      : `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/256/${z}/${x}/${y}@2x?access_token=${k}`;
  }
  const service = { satellite: 'World_Imagery', roads: 'Reference/World_Transportation', labels: 'Reference/World_Boundaries_and_Places' }[part];
  return `https://ibasemaps-api.arcgis.com/arcgis/rest/services/${service}/MapServer/tile/${z}/${y}/${x}?token=${k}`;
}

export interface ImageryLayer {
  id: string;
  label: string;
  /** Tiles stacked for this view, bottom first: [provider, part]. */
  parts: Array<[Provider, string]>;
  attribution: string;
  maxNativeZoom: number;
  minZoom: number;
}

export function createImagery(db: Db, sealer: Sealer, opts: { fetchImpl?: typeof fetch | undefined } = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const read = (): { stored: Stored; updatedAt: string | null; updatedBy: string | null } => {
    const row = (k: string) =>
      db.prepare('SELECT s.value, s.updated_at, u.username FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?').get(k) as
        | { value: string; updated_at: string; username: string | null }
        | undefined;
    const r = row(KEY);
    return r ? { stored: JSON.parse(r.value) as Stored, updatedAt: r.updated_at, updatedBy: r.username } : { stored: {}, updatedAt: null, updatedBy: null };
  };
  const write = (s: Stored, userId: number) => {
    db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(KEY, JSON.stringify(s), nowIso(), userId);
  };
  const keyOf = (p: Exclude<Provider, 'wms'>) => {
    const k = read().stored[p]?.keySealed;
    return k ? sealer.open(k) : null;
  };
  const enabled = (p: Provider) => {
    const s = read().stored[p];
    return !!s?.enabled && (p === 'wms' ? !!(s as WmsProvider).url : !!(s as KeyProvider).keySealed);
  };

  // Google: a session per view (satellite / satellite + roads), renewed before it expires
  const sessions = new Map<string, { id: string; until: number }>();
  async function googleSession(part: string, key: string, force = false): Promise<string> {
    const cached = sessions.get(`${part}:${key.slice(-6)}`);
    if (cached && !force && cached.until > Date.now() + 3_600_000) return cached.id;
    const body = { mapType: 'satellite', language: 'it-IT', region: 'IT', ...(part === 'hybrid' ? { layerTypes: ['layerRoadmap'] } : {}) };
    const r = await doFetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!r) throw new HttpError(502, 'imagery_unreachable');
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new HttpError(502, 'imagery_key_rejected');
    if (!r.ok) throw new HttpError(502, 'imagery_error', { detail: `HTTP ${r.status}` });
    const j = (await r.json()) as { session?: string; expiry?: string };
    if (!j.session) throw new HttpError(502, 'imagery_error');
    sessions.set(`${part}:${key.slice(-6)}`, { id: j.session, until: Number(j.expiry ?? 0) * 1000 || Date.now() + 86_400_000 });
    return j.session;
  }

  /** One tile of a provider (with the given or saved settings); null where there is no imagery. */
  async function tile(provider: Provider, part: string, z: number, x: number, y: number, override?: { key?: string; wms?: { url: string; layers: string } }) {
    if (!PARTS[provider].includes(part)) throw new HttpError(400, 'invalid_tile');
    let url: string;
    if (provider === 'wms') {
      const w = override?.wms ?? read().stored.wms;
      if (!w?.url) throw new HttpError(503, 'imagery_not_configured');
      // orthophotos are heavy to render far out: nothing below zoom 9
      if (z < 9) return null;
      url = wmsTileUrl(w.url, w.layers, z, x, y);
    } else {
      const key = override?.key ?? (enabled(provider) ? keyOf(provider) : null);
      if (!key) throw new HttpError(503, 'imagery_not_configured');
      if (provider === 'google') {
        const get = async (force: boolean) => doFetch(`https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(await googleSession(part, key, force))}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
        let r = await get(false);
        // an expired or revoked session: a new one, once
        if (r && (r.status === 400 || r.status === 401)) r = await get(true);
        return answer(r);
      }
      url = keyTileUrl(provider, part, z, x, y, key);
    }
    return answer(await doFetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null));
  }
  async function answer(r: Response | null) {
    if (!r) throw new HttpError(502, 'imagery_unreachable');
    if (r.status === 401 || r.status === 403) throw new HttpError(502, 'imagery_key_rejected');
    if (r.status === 404 || r.status === 204) return null;
    if (!r.ok) throw new HttpError(502, 'imagery_error', { detail: `HTTP ${r.status}` });
    const type = r.headers.get('content-type') ?? 'image/jpeg';
    // a WMS answers errors as XML with status 200
    if (!type.startsWith('image/')) throw new HttpError(502, 'imagery_error', { detail: type });
    return { type, body: Buffer.from(await r.arrayBuffer()) };
  }

  return {
    tile,
    /** Views the admins' maps offer, one per enabled provider (satellite, and hybrid when there is one). */
    layers(): ImageryLayer[] {
      const out: ImageryLayer[] = [];
      for (const p of PROVIDERS) {
        if (!enabled(p)) continue;
        if (p === 'wms') {
          const w = read().stored.wms!;
          // the AGEA WMS draws nothing (white tiles) under zoom 11: the base map shows there instead
          out.push({ id: 'wms', label: w.label || WMS_DEFAULT.label, parts: [['wms', 'ortofoto']], attribution: w.attribution || WMS_DEFAULT.attribution, maxNativeZoom: 20, minZoom: 11 });
          continue;
        }
        const native = p === 'google' ? 20 : 19;
        out.push({ id: `${p}-satellite`, label: `Satellite · ${LABEL[p]}`, parts: [[p, 'satellite']], attribution: ATTRIBUTION[p], maxNativeZoom: native, minZoom: 0 });
        out.push({ id: `${p}-hybrid`, label: `Ibrida · ${LABEL[p]}`, parts: p === 'esri' ? [['esri', 'satellite'], ['esri', 'roads'], ['esri', 'labels']] : [[p, 'hybrid']], attribution: ATTRIBUTION[p], maxNativeZoom: native, minZoom: 0 });
      }
      return out;
    },
    /** One tile over central Sicily with the values in the form (empty: the saved ones). */
    async test(provider: Provider, input: { key?: string; url?: string; layers?: string }) {
      const saved = read().stored;
      try {
        let r;
        if (provider === 'wms') {
          const url = input.url || saved.wms?.url || WMS_DEFAULT.url;
          const layers = input.layers || saved.wms?.layers || WMS_DEFAULT.layers;
          r = await tile('wms', 'ortofoto', 13, 4419, 3174, { wms: { url, layers } });
        } else {
          const key = input.key || keyOf(provider);
          if (!key) throw new HttpError(400, 'imagery_incomplete');
          r = await tile(provider, 'satellite', 13, 4419, 3174, { key });
        }
        return r ? { ok: true, bytes: r.body.length } : { ok: false, error: 'imagery_empty' };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    /** Never contains a key: only whether it is set and its last characters. */
    view() {
      const { stored, updatedAt, updatedBy } = read();
      const keyView = (p: Exclude<Provider, 'wms'>) => {
        const k = keyOf(p) ?? '';
        return { enabled: stored[p]?.enabled ?? false, configured: !!k, keyHint: k ? `…${k.slice(-4)}` : '' };
      };
      const w = stored.wms;
      return {
        mapbox: keyView('mapbox'),
        esri: keyView('esri'),
        google: keyView('google'),
        wms: { enabled: w?.enabled ?? false, configured: !!w?.url, url: w?.url ?? WMS_DEFAULT.url, layers: w?.layers ?? WMS_DEFAULT.layers, label: w?.label ?? WMS_DEFAULT.label, attribution: w?.attribution ?? WMS_DEFAULT.attribution },
        updatedAt,
        updatedBy,
      };
    },
    /** Saves one provider; an empty key keeps the saved one. */
    save(provider: Provider, input: { enabled: boolean; key?: string | undefined; url?: string; layers?: string; label?: string; attribution?: string }, userId: number) {
      const s = { ...read().stored };
      if (provider === 'wms') {
        const url = input.url ?? s.wms?.url ?? WMS_DEFAULT.url;
        if (input.enabled && !url) throw new HttpError(400, 'imagery_incomplete');
        s.wms = { enabled: input.enabled, url, layers: input.layers ?? s.wms?.layers ?? WMS_DEFAULT.layers, label: input.label ?? s.wms?.label ?? WMS_DEFAULT.label, attribution: input.attribution ?? s.wms?.attribution ?? WMS_DEFAULT.attribution };
      } else {
        const keySealed = input.key ? sealer.seal(input.key) : (s[provider]?.keySealed ?? '');
        if (input.enabled && !keySealed) throw new HttpError(400, 'imagery_incomplete');
        s[provider] = { enabled: input.enabled, keySealed };
        sessions.clear();
      }
      write(s, userId);
    },
    remove(provider: Provider, userId: number) {
      const s = { ...read().stored };
      delete s[provider];
      write(s, userId);
      sessions.clear();
    },
  };
}
export type Imagery = ReturnType<typeof createImagery>;
