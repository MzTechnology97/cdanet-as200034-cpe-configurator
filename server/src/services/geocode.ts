import { HttpError } from '../auth.ts';

/**
 * Address -> coordinates via OpenStreetMap Nominatim.
 * Normally a local Nominatim container of the same stack (no address leaves the server);
 * the public service (max 1 request/s, identifying User-Agent) is used when configured
 * as primary or as fallback while the local one is still importing or down.
 * Results are cached. Only the searched address is sent (no customer identity).
 */

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
  type: string;
}

export interface ReverseResult {
  label: string;
  street: string;
  houseNumber: string;
  city: string;
  province: string;
  postcode: string;
}

/** Nominatim /reverse (jsonv2, addressdetails) -> Italian address parts. */
export function parseReverse(j: unknown): ReverseResult | null {
  const o = (j ?? {}) as { display_name?: string; address?: Record<string, string>; error?: string };
  if (o.error || !o.address) return null;
  const a = o.address;
  // Italian provinces: "county" (e.g. "Enna") or the ISO code IT-EN.
  const iso = a['ISO3166-2-lvl6'];
  return {
    label: o.display_name ?? '',
    street: a.road ?? a.pedestrian ?? a.footway ?? a.path ?? a.hamlet ?? '',
    houseNumber: a.house_number ?? '',
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? '',
    province: (a.county ?? '').replace(/^Libero consorzio comunale di |^Provincia di |^Citt[àa] metropolitana di /i, '') || (iso ? iso.replace(/^IT-/, '') : ''),
    postcode: a.postcode ?? '',
  };
}

export interface GeocoderOptions {
  url: string;
  fallbackUrl?: string | undefined;
  contact?: string | undefined;
  fetchImpl?: typeof fetch;
}

const PUBLIC_HOST = /(^|\.)openstreetmap\.org$/i;
const trim = (u: string) => u.replace(/\/+$/, '');
export const isPublicNominatim = (url: string) => {
  try {
    return PUBLIC_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

export function createGeocoder(opts: GeocoderOptions) {
  const f = opts.fetchImpl ?? fetch;
  const cache = new Map<string, { at: number; value: GeocodeResult[] }>();
  const revCache = new Map<string, { at: number; value: ReverseResult | null }>();
  let last = 0;
  let queue: Promise<unknown> = Promise.resolve();

  /** Public Nominatim policy: at most one request per second. */
  async function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const wait = last + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    queue = run.catch(() => undefined);
    return run;
  }

  async function get(base: string, path: string, params: Record<string, string>, timeoutMs: number) {
    const pub = isPublicNominatim(base);
    const url = `${trim(base)}${path}?${new URLSearchParams({ ...params, ...(pub && opts.contact ? { email: opts.contact } : {}) })}`;
    const call = () =>
      f(url, {
        headers: { 'User-Agent': 'CDA-Net-CPE-Configurator (AS200034)', 'Accept-Language': 'it' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    return pub ? throttled(call) : call();
  }

  async function searchAt(base: string, query: string): Promise<GeocodeResult[]> {
    const r = await get(base, '/search', { q: query, format: 'jsonv2', limit: '5', countrycodes: 'it', addressdetails: '0' }, 10_000).catch(() => {
      throw new HttpError(502, 'geocoder_unreachable');
    });
    if (!r.ok) throw new HttpError(502, 'geocoder_error', { status: r.status });
    const list = (await r.json()) as Array<{ display_name?: string; lat?: string; lon?: string; type?: string }>;
    return list
      .map((x) => ({ label: String(x.display_name ?? ''), lat: Number(x.lat), lon: Number(x.lon), type: String(x.type ?? '') }))
      .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
  }

  async function statusAt(base: string) {
    const started = Date.now();
    try {
      const r = await get(base, '/status', { format: 'json' }, 5_000);
      const body = (await r.json().catch(() => ({}))) as { status?: number; message?: string; data_updated?: string; software_version?: string };
      const ok = r.ok && (body.status ?? 0) === 0;
      return {
        url: trim(base),
        local: !isPublicNominatim(base),
        ok,
        message: body.message ?? (r.ok ? 'OK' : `HTTP ${r.status}`),
        dataUpdated: body.data_updated ?? null,
        version: body.software_version ?? null,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      return { url: trim(base), local: !isPublicNominatim(base), ok: false, message: (e as Error).message || 'non raggiungibile', dataUpdated: null, version: null, latencyMs: Date.now() - started };
    }
  }

  return {
    async search(q: string): Promise<GeocodeResult[]> {
      const query = q.trim().replace(/\s+/g, ' ');
      if (query.length < 3) throw new HttpError(400, 'address_too_short');
      const key = query.toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.value;
      let value: GeocodeResult[];
      try {
        value = await searchAt(opts.url, query);
      } catch (e) {
        // Local Nominatim still importing (HTTP 5xx / connection refused): use the fallback.
        const status = (e as HttpError).extra?.status as number | undefined;
        if (!opts.fallbackUrl || (status !== undefined && status < 500)) throw e;
        value = await searchAt(opts.fallbackUrl, query);
      }
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
      return value;
    },

    /** GPS position -> street, number, city, province, postcode (to fill address forms). */
    async reverse(lat: number, lon: number): Promise<ReverseResult | null> {
      const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      const hit = revCache.get(key);
      if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.value;
      const params = { lat: String(lat), lon: String(lon), format: 'jsonv2', addressdetails: '1', zoom: '18' };
      let r: Response;
      try {
        r = await get(opts.url, '/reverse', params, 10_000);
        if (r.status >= 500 && opts.fallbackUrl) throw new Error('primary down');
      } catch {
        if (!opts.fallbackUrl) throw new HttpError(502, 'geocoder_unreachable');
        r = await get(opts.fallbackUrl, '/reverse', params, 10_000).catch(() => {
          throw new HttpError(502, 'geocoder_unreachable');
        });
      }
      if (!r.ok) throw new HttpError(502, 'geocoder_error', { status: r.status });
      const value = parseReverse(await r.json());
      revCache.set(key, { at: Date.now(), value });
      return value;
    },

    /** Health of the primary (and fallback) service, for the Connettori page. */
    async status() {
      const primary = await statusAt(opts.url);
      const fallback = opts.fallbackUrl ? await statusAt(opts.fallbackUrl) : null;
      return { primary, fallback };
    },
  };
}
export type Geocoder = ReturnType<typeof createGeocoder>;
