import { gunzipSync } from 'node:zlib';
import type { PmTilesReader } from '../domain/pmtiles.ts';
import { readMvt } from '../domain/mvt.ts';

/**
 * Buildings of the basemap (OpenStreetMap through Protomaps, already on the server) on the grid
 * of the terrain: for every point of a 0.1° tile, the height of the building standing there (m,
 * 0 = no building). The real footprints replace the "built-up" class of the land cover, which
 * also covers streets and squares; the height is the one of OpenStreetMap when mapped, else an
 * estimate from the footprint (sheds and garages are low).
 */

/** Zoom of the basemap with all the buildings. */
export const BUILDINGS_ZOOM = 15;
/** Footprints smaller than this (m²) are sheds, garages, kiosks: low. */
const SMALL_M2 = 40;
const SMALL_H = 3;

const mercX = (lon: number, n: number) => ((lon + 180) / 360) * n;
const mercY = (lat: number, n: number) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
const lonOf = (x: number, n: number) => (x / n) * 360 - 180;
const latOf = (y: number, n: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

/** Even-odd test of a point against all the rings of a polygon (holes included). */
export function insideRings(rings: Array<Array<[number, number]>>, x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]!;
      const [xj, yj] = r[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Area of the outer ring, m² (shoelace on local metres). */
function areaM2(ring: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1]);
  return Math.abs(a / 2);
}

/** Height of a building: OpenStreetMap when mapped, else from the footprint. */
export function buildingHeight(props: Record<string, unknown>, footprintM2: number, defaultM: number): number {
  const h = Number(props.height);
  if (Number.isFinite(h) && h > 1) return Math.min(250, h);
  return footprintM2 < SMALL_M2 ? Math.min(SMALL_H, defaultM) : defaultM;
}

/**
 * Raster of the buildings over one terrain tile: [side]×[side] points from the north-west corner
 * ([lat0], [lon0]) every [step] degrees. Each building fills the points inside it; one too small
 * to hold a point marks the nearest one.
 */
export async function rasterizeBuildings(
  reader: Pick<PmTilesReader, 'tile'>,
  box: { north: number; west: number; step: number; side: number },
  defaultM: number,
): Promise<{ grid: Uint8Array; count: number }> {
  const { north, west, step, side } = box;
  const south = north - step * (side - 1);
  const east = west + step * (side - 1);
  const n = 2 ** BUILDINGS_ZOOM;
  const grid = new Uint8Array(side * side);
  let count = 0;
  const x0 = Math.floor(mercX(west, n));
  const x1 = Math.floor(mercX(east, n));
  const y0 = Math.floor(mercY(north, n));
  const y1 = Math.floor(mercY(south, n));
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((((north + south) / 2) * Math.PI) / 180);
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const raw = await reader.tile(BUILDINGS_ZOOM, tx, ty);
      if (!raw) continue;
      const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
      const layer = readMvt(bytes, new Set(['buildings']))[0];
      if (!layer) continue;
      const ext = layer.extent;
      for (const f of layer.features) {
        if (f.type !== 3 || !f.geometry.length) continue;
        // rings in degrees
        const rings = f.geometry.map((r) => r.map(([px, py]) => [lonOf(tx + px / ext, n), latOf(ty + py / ext, n)] as [number, number]));
        const outer = rings[0]!;
        const m2 = areaM2(outer.map(([lo, la]) => [lo * mLon, la * mLat] as [number, number]));
        const h = Math.max(1, Math.min(255, Math.round(buildingHeight(f.props, m2, defaultM))));
        let minLo = Infinity;
        let maxLo = -Infinity;
        let minLa = Infinity;
        let maxLa = -Infinity;
        for (const [lo, la] of outer) {
          if (lo < minLo) minLo = lo;
          if (lo > maxLo) maxLo = lo;
          if (la < minLa) minLa = la;
          if (la > maxLa) maxLa = la;
        }
        if (maxLo < west || minLo > east || maxLa < south || minLa > north) continue;
        const gx0 = Math.max(0, Math.ceil((minLo - west) / step));
        const gx1 = Math.min(side - 1, Math.floor((maxLo - west) / step));
        const gy0 = Math.max(0, Math.ceil((north - maxLa) / step));
        const gy1 = Math.min(side - 1, Math.floor((north - minLa) / step));
        let hit = false;
        for (let gy = gy0; gy <= gy1; gy++) {
          const la = north - gy * step;
          for (let gx = gx0; gx <= gx1; gx++) {
            if (!insideRings(rings, west + gx * step, la)) continue;
            const k = gy * side + gx;
            if (h > grid[k]!) grid[k] = h;
            hit = true;
          }
        }
        if (!hit) {
          // smaller than the grid: the point nearest to its middle
          const gx = Math.round(((minLo + maxLo) / 2 - west) / step);
          const gy = Math.round((north - (minLa + maxLa) / 2) / step);
          if (gx >= 0 && gx < side && gy >= 0 && gy < side && h > grid[gy * side + gx]!) grid[gy * side + gx] = h;
        }
        count++;
      }
    }
  }
  return { grid, count };
}
