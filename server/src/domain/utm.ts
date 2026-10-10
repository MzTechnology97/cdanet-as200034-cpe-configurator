/**
 * WGS 84 → UTM (Transverse Mercator, Krüger series to the 6th order: sub-millimetre within the
 * zone and well under a metre in the extended zone 32 that TINITALY uses for the whole of Italy).
 */

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const N = F / (2 - F);
const AA = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64 + N ** 6 / 256);
const ALPHA = [
  N / 2 - (2 / 3) * N ** 2 + (5 / 16) * N ** 3 + (41 / 180) * N ** 4 - (127 / 288) * N ** 5 + (7891 / 37800) * N ** 6,
  (13 / 48) * N ** 2 - (3 / 5) * N ** 3 + (557 / 1440) * N ** 4 + (281 / 630) * N ** 5 - (1983433 / 1935360) * N ** 6,
  (61 / 240) * N ** 3 - (103 / 140) * N ** 4 + (15061 / 26880) * N ** 5 + (167603 / 181440) * N ** 6,
  (49561 / 161280) * N ** 4 - (179 / 168) * N ** 5 + (6601661 / 7257600) * N ** 6,
  (34729 / 80640) * N ** 5 - (3418889 / 1995840) * N ** 6,
  (212378941 / 319334400) * N ** 6,
];
const E2 = (2 * Math.sqrt(N)) / (1 + N);

/** Easting and northing (metres) of a point in UTM zone [zone], northern hemisphere. */
export function toUtm(lat: number, lon: number, zone: number): { e: number; n: number } {
  const phi = (lat * Math.PI) / 180;
  const dl = ((lon - (zone * 6 - 183)) * Math.PI) / 180;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - E2 * Math.atanh(E2 * s));
  const xi1 = Math.atan2(t, Math.cos(dl));
  const eta1 = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let xi = xi1;
  let eta = eta1;
  for (let j = 1; j <= 6; j++) {
    xi += ALPHA[j - 1]! * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += ALPHA[j - 1]! * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  return { e: 500000 + K0 * AA * eta, n: K0 * AA * xi };
}
