import { createReadStream, openSync, readSync, closeSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

/**
 * Basemap (Protomaps PMTiles, OpenStreetMap data) served from the data volume. The file is
 * downloaded by the installer ("sudo cdanet-cpe map update"); without it the console falls back
 * to the public OpenStreetMap tiles.
 */

export interface BasemapInfo {
  url: string;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  size: number;
  updatedAt: string;
}

/** PMTiles v3 header (127 bytes): zooms and bounds; null when missing or not a PMTiles v3 archive. */
export function readPmtilesHeader(file: string): Omit<BasemapInfo, 'url' | 'size' | 'updatedAt'> | null {
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
      cached = { mtime: st.mtimeMs, info: h ? { ...h, url: `/map/basemap.pmtiles?v=${Math.round(st.mtimeMs)}`, size: st.size, updatedAt: st.mtime.toISOString() } : null };
    }
    return cached.info;
  };

  // Public: basemap info only (the app's embedded map page has no session).
  app.get('/api/map/config', async () => ({
    basemap: info(),
    fallback: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
    attribution: '© OpenStreetMap contributors · Protomaps',
  }));

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
