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

    /** Health of the primary (and fallback) service, for the Connettori page. */
    async status() {
      const primary = await statusAt(opts.url);
      const fallback = opts.fallbackUrl ? await statusAt(opts.fallbackUrl) : null;
      return { primary, fallback };
    },
  };
}
export type Geocoder = ReturnType<typeof createGeocoder>;
