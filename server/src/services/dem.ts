import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Terrain elevation (metres above sea level) from SRTM-style .hgt tiles (1°×1°, "Skadi" layout of
 * the AWS Open Data terrain tiles). Tiles are downloaded only when needed, kept on disk and the
 * last few in memory. Used for the pointing tilt towards the APs.
 */

/** "N37E014" for the tile containing the point. */
export function tileName(lat: number, lon: number): string {
  const la = Math.floor(lat);
  const lo = Math.floor(lon);
  return `${la >= 0 ? 'N' : 'S'}${String(Math.abs(la)).padStart(2, '0')}${lo >= 0 ? 'E' : 'W'}${String(Math.abs(lo)).padStart(3, '0')}`;
}

/** Bilinear elevation from a raw .hgt tile (big-endian int16, north row first); null on voids. */
export function sampleHgt(buf: Buffer, lat: number, lon: number): number | null {
  const n = Math.round(Math.sqrt(buf.length / 2));
  if (n * n * 2 !== buf.length || n < 2) return null;
  const y = (Math.floor(lat) + 1 - lat) * (n - 1);
  const x = (lon - Math.floor(lon)) * (n - 1);
  const x0 = Math.min(Math.floor(x), n - 2);
  const y0 = Math.min(Math.floor(y), n - 2);
  const fx = x - x0;
  const fy = y - y0;
  const v = (r: number, c: number) => {
    const h = buf.readInt16BE((r * n + c) * 2);
    return h === -32768 ? null : h;
  };
  const q = [v(y0, x0), v(y0, x0 + 1), v(y0 + 1, x0), v(y0 + 1, x0 + 1)];
  if (q.some((h) => h === null)) return q.find((h) => h !== null) ?? null;
  const [a, b, c, d] = q as number[];
  return Math.round((a! * (1 - fx) * (1 - fy) + b! * fx * (1 - fy) + c! * (1 - fx) * fy + d! * fx * fy) * 10) / 10;
}

/** Elevation angle (degrees) from one antenna to another, with earth curvature and standard refraction (k = 4/3). */
export function elevationAngle(distanceM: number, fromAltitude: number, toAltitude: number): number {
  const R = 6371000 * (4 / 3);
  const drop = (distanceM * distanceM) / (2 * R);
  return Math.round(((Math.atan2(toAltitude - fromAltitude - drop, distanceM) * 180) / Math.PI) * 10) / 10;
}

export function createDem(opts: { dir: string; baseUrl: string; fetchImpl?: typeof fetch; maxTiles?: number; log?: (m: string) => void }) {
  const f = opts.fetchImpl ?? fetch;
  const mem = new Map<string, Buffer | null>();
  const loading = new Map<string, Promise<Buffer | null>>();
  const max = opts.maxTiles ?? 3;

  async function load(name: string): Promise<Buffer | null> {
    const file = join(opts.dir, `${name}.hgt.gz`);
    const none = join(opts.dir, `${name}.none`);
    if (existsSync(none)) return null; // sea: no tile
    if (!existsSync(file)) {
      const url = `${opts.baseUrl.replace(/\/+$/, '')}/${name.slice(0, 3)}/${name}.hgt.gz`;
      const r = await f(url, { signal: AbortSignal.timeout(60_000) });
      mkdirSync(opts.dir, { recursive: true });
      if (r.status === 404 || r.status === 403) {
        writeFileSync(none, '');
        return null;
      }
      if (!r.ok) throw new Error(`DEM HTTP ${r.status}`);
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    return gunzipSync(readFileSync(file));
  }

  async function tile(name: string): Promise<Buffer | null> {
    if (mem.has(name)) {
      const t = mem.get(name)!;
      mem.delete(name);
      mem.set(name, t); // most recently used last
      return t;
    }
    let p = loading.get(name);
    if (!p) {
      p = load(name).finally(() => loading.delete(name));
      loading.set(name, p);
    }
    const t = await p;
    mem.set(name, t);
    while (mem.size > max) mem.delete(mem.keys().next().value!);
    return t;
  }

  return {
    enabled: !!opts.baseUrl,
    /** Ground elevation, metres a.s.l.: 0 on the sea, null when unknown (service off or unreachable). */
    async elevation(lat: number, lon: number): Promise<number | null> {
      if (!opts.baseUrl) return null;
      try {
        const t = await tile(tileName(lat, lon));
        const v = t ? sampleHgt(t, lat, lon) : 0;
        // the tiles carry sea-floor depths too: for antennas the sea is at 0 m
        return v === null ? null : Math.max(0, v);
      } catch (err) {
        opts.log?.(`dem: ${(err as Error).message}`);
        return null;
      }
    },
  };
}
export type Dem = ReturnType<typeof createDem>;
