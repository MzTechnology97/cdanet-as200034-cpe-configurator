import type { UispDevice } from '../services/uisp.ts';
import { isAp } from '../services/uisp.ts';

/**
 * Network health for the NOC: which CPEs need attention (from the UISP device list),
 * and how each AP's sector is doing. Pure function, unit-tested.
 */

export type IssueKind = 'offline' | 'pending' | 'weak_signal' | 'firmware' | 'ethernet' | 'low_capacity';

export interface HealthThresholds {
  signalGood: number;
  signalMin: number;
  ethMinMbps: number;
  capacityMinMbps: number;
  targetFirmware: string;
}

export interface CpeHealth {
  id: string;
  name: string;
  mac: string | null;
  model: string;
  firmware: string;
  status: string;
  signal: number | null;
  ethMbps: number | null;
  ethHalfDuplex: boolean;
  dlCapacityMbps: number | null;
  apName: string | null;
  siteName: string | null;
  lastSeen: string | null;
  issues: IssueKind[];
}

export interface ApHealth {
  id: string;
  name: string;
  siteName: string | null;
  ssid: string | null;
  status: string;
  stations: number;
  avgSignal: number | null;
  weak: number;
  offline: number;
}

const OFFLINE = new Set(['disconnected', 'inactive', 'unknown']);
/** Severity order: what to look at first. */
const WEIGHT: Record<IssueKind, number> = { offline: 50, weak_signal: 20, ethernet: 15, pending: 10, low_capacity: 8, firmware: 3 };

export function firmwareIs(version: string, target: string): boolean {
  return new RegExp(`(^|[^0-9.])v?${target.replace(/\./g, '\\.')}(?![0-9])`).test(version);
}

export function networkHealth(devices: UispDevice[], t: HealthThresholds) {
  const stations = devices.filter((d) => !isAp(d) && (d.role === 'station' || d.ssid !== null || d.apId !== null));
  const cpes: CpeHealth[] = stations.map((d) => {
    const issues: IssueKind[] = [];
    const offline = OFFLINE.has(d.status);
    if (offline) issues.push('offline');
    if (!d.authorized) issues.push('pending');
    if (!offline && d.signal !== null && d.signal < t.signalMin) issues.push('weak_signal');
    if (!offline && ((d.ethMbps !== null && d.ethMbps > 0 && d.ethMbps < t.ethMinMbps) || d.ethHalfDuplex)) issues.push('ethernet');
    if (!offline && d.dlCapacityMbps !== null && d.dlCapacityMbps > 0 && d.dlCapacityMbps < t.capacityMinMbps) issues.push('low_capacity');
    if (d.firmware && !firmwareIs(d.firmware, t.targetFirmware)) issues.push('firmware');
    return {
      id: d.id,
      name: d.name,
      mac: d.mac,
      model: d.model,
      firmware: d.firmware,
      status: d.status,
      signal: d.signal,
      ethMbps: d.ethMbps,
      ethHalfDuplex: d.ethHalfDuplex,
      dlCapacityMbps: d.dlCapacityMbps,
      apName: d.apName,
      siteName: d.siteName,
      lastSeen: d.lastSeen,
      issues,
    };
  });
  const score = (c: CpeHealth) => c.issues.reduce((s, i) => s + WEIGHT[i], 0);
  cpes.sort((a, b) => score(b) - score(a) || (a.signal ?? 0) - (b.signal ?? 0) || a.name.localeCompare(b.name));

  const aps: ApHealth[] = devices.filter(isAp).map((ap) => {
    const mine = stations.filter((s) => s.apId === ap.id);
    const signals = mine.filter((s) => !OFFLINE.has(s.status)).map((s) => s.signal).filter((x): x is number => x !== null);
    return {
      id: ap.id,
      name: ap.name,
      siteName: ap.siteName,
      ssid: ap.ssid,
      status: ap.status,
      stations: mine.length || (ap.stations ?? 0),
      avgSignal: signals.length ? Math.round(signals.reduce((a, b) => a + b, 0) / signals.length) : null,
      weak: mine.filter((s) => !OFFLINE.has(s.status) && s.signal !== null && s.signal < t.signalMin).length,
      offline: mine.filter((s) => OFFLINE.has(s.status)).length,
    };
  });
  aps.sort((a, b) => b.offline + b.weak - (a.offline + a.weak) || a.name.localeCompare(b.name));

  const count = (k: IssueKind) => cpes.filter((c) => c.issues.includes(k)).length;
  return {
    totals: {
      cpes: cpes.length,
      ok: cpes.filter((c) => !c.issues.length).length,
      offline: count('offline'),
      pending: count('pending'),
      weak_signal: count('weak_signal'),
      ethernet: count('ethernet'),
      low_capacity: count('low_capacity'),
      firmware: count('firmware'),
      aps: aps.length,
      apsOffline: aps.filter((a) => OFFLINE.has(a.status)).length,
    },
    cpes,
    aps,
  };
}
