import { createReadStream, openSync, readSync, closeSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PmTilesReader } from '../domain/pmtiles.ts';
import type { AppContext } from '../context.ts';

/**
 * Basemap (Protomaps PMTiles, OpenStreetMap data) served from the data volume. The file is
 * downloaded by the installer ("sudo cdanet-cpe map update"); without it the console falls back
 * to the public OpenStreetMap tiles.
 */

export interface BasemapInfo {
  url: string;
  /** Same map as single tiles ({z}/{x}/{y}): ordinary requests instead of byte ranges. */
  tiles: string;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  size: number;
  updatedAt: string;
}

/** PMTiles v3 header (127 bytes): zooms and bounds; null when missing or not a PMTiles v3 archive. */
export function readPmtilesHeader(file: string): Omit<BasemapInfo, 'url' | 'tiles' | 'size' | 'updatedAt'> | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const b = Buffer.alloc(127);
    if (readSync(fd, b, 0, 127, 0) < 127) return null;
    if (b.toString('latin1', 0, 7) !== 'PMTiles' || b[7] !== 3) return null;
    const e7 = (at: number) => b.readInt32LE(at) / 1e7;
    return { minZoom: b[100]!, maxZoom: b[101]!, bounds: [e7(102), e7(106), e7(110), e7(114)] };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function mapRoutes(app: FastifyInstance, ctx: AppContext) {
  const file = ctx.cfg.mapFile;
  let cached: { mtime: number; info: BasemapInfo | null } | null = null;

  const info = (): BasemapInfo | null => {
    let st;
    try {
      st = statSync(file);
    } catch {
      return null;
    }
    if (cached?.mtime !== st.mtimeMs) {
      const h = readPmtilesHeader(file);
      const v = Math.round(st.mtimeMs);
      cached = { mtime: st.mtimeMs, info: h ? { ...h, url: `/map/basemap.pmtiles?v=${v}`, tiles: `/map/tiles/{z}/{x}/{y}.mvt?v=${v}`, size: st.size, updatedAt: st.mtime.toISOString() } : null };
    }
    return cached.info;
  };

  // Public: basemap info only (the app's embedded map page has no session).
  app.get('/api/map/config', async () => ({
    basemap: info(),
    fallback: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
    attribution: '© OpenStreetMap contributors · Protomaps',
  }));

  /**
   * Problems of the map page embedded in the Android app (no console there): written to the server
   * log, nothing stored. Public like the page itself, small and rate limited.
   */
  const reports = { n: 0, since: Date.now() };
  app.post('/api/map/client-log', { bodyLimit: 4096 }, async (req, reply) => {
    if (Date.now() - reports.since > 60_000) Object.assign(reports, { n: 0, since: Date.now() });
    if (++reports.n > 60) return reply.code(429).send({ error: 'too_many_requests' });
    const b = z
      .object({ kind: z.string().max(40), message: z.string().max(500), ua: z.string().max(300).optional(), size: z.string().max(20).optional() })
      .strict()
      .parse(req.body);
    req.log.warn({ map: b }, 'embedded map');
    return reply.code(204).send();
  });

  /**
   * Single vector tiles read on the server from the basemap: what the console and the app use.
   * Absent tile (sea, outside the downloaded area) = 204. Cached by the browser: the URL changes
   * with the map file.
   */
  let reader: { mtime: number; r: PmTilesReader } | null = null;
  app.get('/map/tiles/:z/:x/:y', async (req, reply) => {
    const p = req.params as { z: string; x: string; y: string };
    const m = /^(\d+)$/.exec(p.z) && /^(\d+)$/.exec(p.x) && /^(\d+)(\.mvt)?$/.exec(p.y);
    if (!m) return reply.code(400).send({ error: 'bad_tile' });
    const [z, x, y] = [Number(p.z), Number(p.x), Number.parseInt(p.y, 10)];
    if (z > 22 || x >= 2 ** z || y >= 2 ** z) return reply.code(400).send({ error: 'bad_tile' });
    const i = info();
    if (!i) return reply.code(404).send({ error: 'basemap_missing' });
    if (reader?.mtime !== Date.parse(i.updatedAt)) {
      await reader?.r.close();
      reader = { mtime: Date.parse(i.updatedAt), r: new PmTilesReader(file) };
    }
    const h = await reader.r.getHeader();
    const t = await reader.r.tile(z, x, y);
    reply.header('Cache-Control', 'public, max-age=86400');
    if (!t) return reply.code(204).send();
    reply.header('Content-Type', 'application/vnd.mapbox-vector-tile');
    if (h.tileCompression === 2) reply.header('Content-Encoding', 'gzip');
    return reply.send(t);
  });

  /** Range requests only (PMTiles readers fetch the parts they need). Public map data, no customer data. */
  app.get('/map/basemap.pmtiles', async (req, reply) => {
    const i = info();
    if (!i) return reply.code(404).send({ error: 'basemap_missing' });
    const etag = `"${i.size}-${i.updatedAt}"`;
    reply.header('Accept-Ranges', 'bytes').header('ETag', etag).header('Cache-Control', 'public, max-age=86400');
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (!m) return reply.code(416).header('Content-Range', `bytes */${i.size}`).send({ error: 'range_required' });
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : start + 4 * 1024 * 1024 - 1, i.size - 1, start + 16 * 1024 * 1024 - 1);
    if (start >= i.size || end < start) return reply.code(416).header('Content-Range', `bytes */${i.size}`).send({ error: 'bad_range' });
    reply.code(206).header('Content-Type', 'application/octet-stream').header('Content-Range', `bytes ${start}-${end}/${i.size}`).header('Content-Length', end - start + 1);
    return reply.send(createReadStream(file, { start, end }));
  });
}
