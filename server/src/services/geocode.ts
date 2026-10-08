import { HttpError } from '../auth.ts';

/**
 * Address -> coordinates via OpenStreetMap Nominatim.
 * Usage policy: max 1 request/s, identifying User-Agent, results cached.
 * Only the searched address leaves the server (no customer identity).
 */

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
  type: string;
}

export function createGeocoder(opts: { url: string; contact?: string | undefined; fetchImpl?: typeof fetch }) {
  const f = opts.fetchImpl ?? fetch;
  const cache = new Map<string, { at: number; value: GeocodeResult[] }>();
  let last = 0;
  let queue: Promise<unknown> = Promise.resolve();

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

  return {
    async search(q: string): Promise<GeocodeResult[]> {
      const query = q.trim().replace(/\s+/g, ' ');
      if (query.length < 3) throw new HttpError(400, 'address_too_short');
      const key = query.toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.value;
      const url = `${opts.url.replace(/\/+$/, '')}/search?${new URLSearchParams({
        q: query,
        format: 'jsonv2',
        limit: '5',
        countrycodes: 'it',
        addressdetails: '0',
        ...(opts.contact ? { email: opts.contact } : {}),
      })}`;
      const r = await throttled(() =>
        f(url, {
          headers: { 'User-Agent': 'CDA-Net-CPE-Configurator (AS200034)', 'Accept-Language': 'it' },
          signal: AbortSignal.timeout(10_000),
        }),
      ).catch(() => {
        throw new HttpError(502, 'geocoder_unreachable');
      });
      if (!r.ok) throw new HttpError(502, 'geocoder_error', { status: r.status });
      const list = (await r.json()) as Array<{ display_name?: string; lat?: string; lon?: string; type?: string }>;
      const value = list
        .map((x) => ({ label: String(x.display_name ?? ''), lat: Number(x.lat), lon: Number(x.lon), type: String(x.type ?? '') }))
        .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
      return value;
    },
  };
}
export type Geocoder = ReturnType<typeof createGeocoder>;
