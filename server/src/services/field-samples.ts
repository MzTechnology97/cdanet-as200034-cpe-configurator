import type { Db } from '../db.ts';
import { distanceM, type LatLon } from '../domain/geo.ts';
import { parseMac } from '../domain/policy.ts';

/**
 * What the field work tells the coverage model:
 * - acceptance tests (collaudo): the real height of each CPE, typed by the technician;
 * - installations given up for radio reasons (no signal, no link, obstacles) and not solved by a
 *   later successful test: the places where coverage did NOT work, the negative cases the
 *   connected customers can never show.
 */

/** KO reasons that say something about the coverage of the place. */
export const RADIO_KO = ['no_signal', 'no_link', 'obstacles'] as const;

export interface FieldFailure extends LatLon {
  reason: (typeof RADIO_KO)[number];
  /** AP the technician tried (as written by the app), null when unknown. */
  apName: string | null;
  signal: number | null;
  at: string;
}

/** Height above the ground of the CPEs installed with the app, by MAC (last acceptance test). */
export function cpeHeights(db: Db): Map<string, number> {
  const rows = db
    .prepare(`SELECT j.mac mac, a.data data FROM job_acceptance a JOIN provisioning_jobs j ON j.id = a.job_id WHERE j.mac <> '' ORDER BY a.created_at`)
    .all() as Array<{ mac: string; data: string }>;
  const out = new Map<string, number>();
  for (const r of rows) {
    try {
      const h = (JSON.parse(r.data) as { cpeHeightM?: number | null }).cpeHeightM;
      const mac = parseMac(r.mac);
      if (mac && typeof h === 'number' && h > 0) out.set(mac, h);
    } catch {
      // an old or broken report: no height
    }
  }
  return out;
}

/** Open radio KO reports with the position of their installation (newest first). */
export function fieldFailures(db: Db): FieldFailure[] {
  const rows = db
    .prepare(
      `SELECT k.reason reason, k.data data, k.created_at at, j.latitude lat, j.longitude lon
         FROM install_ko k JOIN provisioning_jobs j ON j.id = k.job_id
        WHERE k.resolved_at IS NULL AND k.reason IN (${RADIO_KO.map(() => '?').join(',')}) AND j.latitude IS NOT NULL AND j.longitude IS NOT NULL
        ORDER BY k.created_at DESC`,
    )
    .all(...RADIO_KO) as Array<{ reason: FieldFailure['reason']; data: string; at: string; lat: number; lon: number }>;
  return rows.map((r) => {
    let m: { apName?: string | null; signal?: number | null } = {};
    try {
      m = JSON.parse(r.data) as typeof m;
    } catch {
      // no measures
    }
    return { lat: r.lat, lon: r.lon, reason: r.reason, apName: m.apName?.trim() || null, signal: typeof m.signal === 'number' ? m.signal : null, at: r.at };
  });
}

/** Failures within [radiusM] of a point: towards [apName] (same AP) and in total. */
export function failuresNear(all: FieldFailure[], p: LatLon, apName: string | null, radiusM = 300): { sameAp: number; any: number } {
  const near = all.filter((f) => distanceM(p, f) <= radiusM);
  const name = apName?.trim().toLowerCase();
  return { sameAp: name ? near.filter((f) => f.apName?.toLowerCase() === name).length : 0, any: near.length };
}
