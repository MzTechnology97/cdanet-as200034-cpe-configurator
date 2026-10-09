import { createHmac } from 'node:crypto';

/** Radius of the "approximate area" drawn around a hidden position. */
export const APPROX_RADIUS_M = 1500;

/**
 * Approximate position of a POP/AP for installers: the ~1 km grid cell of the real point plus a
 * fixed offset derived from a secret and the object id. The result never changes for the same
 * object, so repeated requests cannot be averaged back to the real coordinates.
 */
export function approxPoint(lat: number, lon: number, id: string, secret: Uint8Array | string, cellDeg = 0.01): { lat: number; lon: number; radiusM: number } {
  const h = createHmac('sha256', secret).update(`approx:${id}`).digest();
  const off = (at: number) => (h.readUInt16BE(at) / 65535 - 0.5) * cellDeg;
  const snap = (v: number) => Math.floor(v / cellDeg) * cellDeg + cellDeg / 2;
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return { lat: r(snap(lat) + off(0)), lon: r(snap(lon) + off(2)), radiusM: APPROX_RADIUS_M };
}

/** Distances shown to installers: rounded (50 m below 1 km, 100 m above). */
export const roughDistance = (m: number) => (m < 1000 ? Math.round(m / 50) * 50 : Math.round(m / 100) * 100);
