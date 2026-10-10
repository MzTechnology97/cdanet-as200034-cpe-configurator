import type { UispDevice } from '../services/uisp.ts';
import { isSuspended, radiusState, type RadiusInfo } from '../services/crm-sync.ts';

/**
 * Health of the customer CPEs: current UISP state compared with the acceptance test (when the
 * CPE was installed with the app). Admins see every customer CPE in UISP; installers the ones they
 * installed with the app plus those assigned to them. No sensitive data (PPPoE credentials,
 * configuration) is involved.
 */

export type IssueKind =
  | 'offline'
  | 'not_in_uisp'
  | 'pending'
  | 'weak_signal'
  | 'signal_drop'
  | 'ethernet'
  | 'low_capacity'
  | 'firmware'
  /** CPE online in UISP, PPPoE session down in RADIUS: the customer has no Internet (admins only). */
  | 'pppoe_offline'
  /** Account, customer or a service suspended in the CRM (admins only). */
  | 'account_suspended'
  /** Account terminated or customer ceased (or ceasing) while the CPE is still there (admins only). */
  | 'account_terminated';

export interface HealthThresholds {
  signalGood: number;
  signalMin: number;
  ethMinMbps: number;
  capacityMinMbps: number;
  targetFirmware: string;
  /** dB lost since the acceptance test that makes it worth a visit. */
  signalDropDb: number;
}

export interface InstalledJob {
  /** null for CPEs found only in UISP (not installed with the app). */
  jobId: string | null;
  createdAt: string | null;
  deviceName: string;
  model: string;
  mac: string;
  ssid: string;
  installer: string;
  acceptanceVerdict: string | null;
  acceptanceSignal: number | null;
  acceptanceDownload: number | null;
}

export interface CpeNow {
  status: string;
  authorized: boolean;
  signal: number | null;
  ethMbps: number | null;
  ethHalfDuplex: boolean;
  dlCapacityMbps: number | null;
  firmware: string;
  apName: string | null;
  lastSeen: string | null;
}

const OFFLINE = new Set(['disconnected', 'inactive', 'unknown']);
const WEIGHT: Record<IssueKind, number> = { offline: 50, pppoe_offline: 45, not_in_uisp: 30, weak_signal: 20, signal_drop: 18, ethernet: 15, pending: 10, low_capacity: 8, account_suspended: 5, account_terminated: 6, firmware: 3 };

export function firmwareIs(version: string, target: string): boolean {
  return new RegExp(`(^|[^0-9.])v?${target.replace(/\./g, '\\.')}(?![0-9])`).test(version);
}

/** "XC.qca956x.v8.7.11.46972…", "WA.v8.7.4", "8.7.4" → [8, 7, 11]; null if no version in it. */
export function firmwareVersion(fw: string): [number, number, number] | null {
  const m = /(?:^|[^0-9.])v?(\d+)\.(\d+)\.(\d+)/.exec(fw);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Firmware of a CPE against the reference version: 'ok' when equal or newer (newer is fine),
 * 'old' when older (to update), 'legacy' for the airMAX M series (XM/XW/TI, airOS 6), which
 * cannot run airOS 8 at all, 'unknown' when no version can be read.
 */
export type FirmwareState = 'ok' | 'old' | 'legacy' | 'unknown';
export function firmwareState(fw: string | null | undefined, target: string): FirmwareState {
  const v = fw ? firmwareVersion(fw) : null;
  const t = firmwareVersion(target);
  if (!v || !t) return 'unknown';
  if (v[0] < 8 && /^(XM|XW|TI)\./i.test(fw!.trim())) return 'legacy';
  for (let i = 0; i < 3; i++) if (v[i] !== t[i]) return v[i]! > t[i]! ? 'ok' : 'old';
  return 'ok';
}

export function nowOf(d: UispDevice): CpeNow {
  return {
    status: d.status,
    authorized: d.authorized,
    signal: d.signal,
    ethMbps: d.ethMbps,
    ethHalfDuplex: d.ethHalfDuplex,
    dlCapacityMbps: d.dlCapacityMbps,
    firmware: d.firmware,
    apName: d.apName,
    lastSeen: d.lastSeen,
  };
}

export function issuesOf(job: InstalledJob, now: CpeNow | null, t: HealthThresholds, radius: RadiusInfo | null = null): IssueKind[] {
  const state = radius ? radiusState(radius) : null;
  const ceased = state === 'terminated' || state === 'terminating';
  const suspended = !ceased && radius !== null && isSuspended(radius);
  if (!now) return ceased ? ['not_in_uisp', 'account_terminated'] : suspended ? ['not_in_uisp', 'account_suspended'] : ['not_in_uisp'];
  const issues: IssueKind[] = [];
  const offline = OFFLINE.has(now.status);
  if (offline) issues.push('offline');
  if (!now.authorized) issues.push('pending');
  if (!offline && now.signal !== null && now.signal < t.signalMin) issues.push('weak_signal');
  if (!offline && now.signal !== null && job.acceptanceSignal !== null && now.signal - job.acceptanceSignal <= -t.signalDropDb) issues.push('signal_drop');
  if (!offline && ((now.ethMbps !== null && now.ethMbps > 0 && now.ethMbps < t.ethMinMbps) || now.ethHalfDuplex)) issues.push('ethernet');
  if (!offline && now.dlCapacityMbps !== null && now.dlCapacityMbps > 0 && now.dlCapacityMbps < t.capacityMinMbps) issues.push('low_capacity');
  // only an older firmware is a problem: newer is fine, the M series cannot be updated to 8.x
  if (firmwareState(now.firmware, t.targetFirmware) === 'old') issues.push('firmware');
  // RADIUS (admins): a suspended customer is offline on purpose, not a fault
  if (radius) {
    if (ceased) issues.push('account_terminated');
    else if (suspended) issues.push('account_suspended');
    else if (!offline && radius.online === false) issues.push('pppoe_offline');
  }
  return issues;
}

/**
 * [radiusOf] (admins, CRM connected): the RADIUS account of a CPE, added to the row with the
 * pppoe_offline / account_suspended issues.
 */
export function installedHealth<J extends InstalledJob>(jobs: J[], byMac: Map<string, UispDevice>, t: HealthThresholds, radiusOf?: (j: J) => RadiusInfo | null) {
  const cpes = jobs.map((j) => {
    const d = byMac.get(j.mac);
    const now = d ? nowOf(d) : null;
    const radius = radiusOf ? radiusOf(j) : null;
    return {
      ...j,
      now,
      firmware: now?.firmware ? { version: firmwareVersion(now.firmware)?.join('.') ?? now.firmware, state: firmwareState(now.firmware, t.targetFirmware) } : null,
      signalDelta: now?.signal != null && j.acceptanceSignal != null ? Math.round(now.signal - j.acceptanceSignal) : null,
      issues: issuesOf(j, now, t, radius),
      ...(radiusOf ? { radius: radius ? radiusView(radius) : null } : {}),
    };
  });
  const score = (c: (typeof cpes)[number]) => c.issues.reduce((s, i) => s + WEIGHT[i], 0);
  cpes.sort((a, b) => score(b) - score(a) || (a.signalDelta ?? 0) - (b.signalDelta ?? 0) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const count = (k: IssueKind) => cpes.filter((c) => c.issues.includes(k)).length;
  // how many CPEs per firmware version (Salute CPE: where the "firmware" ones come from)
  const versions = new Map<string, { version: string; state: FirmwareState; count: number }>();
  for (const c of cpes) {
    if (!c.firmware) continue;
    const v = versions.get(c.firmware.version) ?? { ...c.firmware, count: 0 };
    v.count++;
    versions.set(c.firmware.version, v);
  }
  const firmwareVersions = [...versions.values()].sort((a, b) => b.count - a.count || b.version.localeCompare(a.version, 'en', { numeric: true }));
  return {
    targetFirmware: t.targetFirmware,
    firmwareVersions,
    totals: {
      cpes: cpes.length,
      ok: cpes.filter((c) => !c.issues.length).length,
      offline: count('offline'),
      not_in_uisp: count('not_in_uisp'),
      pending: count('pending'),
      weak_signal: count('weak_signal'),
      signal_drop: count('signal_drop'),
      ethernet: count('ethernet'),
      low_capacity: count('low_capacity'),
      firmware: count('firmware'),
      // only with the RADIUS state (admins, CRM connected)
      ...(radiusOf ? { pppoe_offline: count('pppoe_offline'), account_suspended: count('account_suspended'), account_terminated: count('account_terminated') } : {}),
    },
    cpes,
  };
}

/** What the NOC sees of a RADIUS account next to a CPE. */
export function radiusView(r: RadiusInfo) {
  return {
    username: r.username,
    /** Synthetic state for the filters: terminated, terminating, suspended, services_suspended, offline, online, unknown. */
    state: radiusState(r),
    accountStatus: r.accountStatus,
    customerName: r.customerName,
    customerStatus: r.customerStatus,
    servicesSuspended: r.servicesSuspended,
    suspended: isSuspended(r),
    profile: r.profile,
    speed: r.speed,
    online: r.online,
    clientIp: r.clientIp,
    sessionSeconds: r.sessionSeconds,
    checkedAt: r.checkedAt,
  };
}
