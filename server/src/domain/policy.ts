/**
 * CDA Net provisioning policy: the single source of truth shared by the API,
 * the Admin web UI (via /api/meta) and the Android client (via the job package).
 */

export const SUPPORTED_MODELS = [
  'NanoStation Loco 5AC',
  'NanoStation 5AC',
  'NanoBeam 5AC',
  'LiteBeam 5AC',
  'PowerBeam 5AC',
] as const;
export type CpeModel = (typeof SUPPORTED_MODELS)[number];

/** Production airOS baseline. Other builds are detected but writing is blocked. */
export const TARGET_FIRMWARE = '8.7.4';
export const COMPATIBILITY_FIRMWARE = ['8.7.11', '8.7.25'] as const;

/**
 * Suggested board match (regex on /etc/board.info), proposed when importing a backup.
 * Always confirm with `cat /etc/board.info` on the lab CPE before field use.
 */
export const BOARD_MATCH_SUGGESTIONS: Record<CpeModel, string> = {
  'NanoStation Loco 5AC': 'board\\.name=NanoStation 5AC ?loco',
  'NanoStation 5AC': 'board\\.name=NanoStation 5AC(?! ?loco)',
  'NanoBeam 5AC': 'board\\.name=NanoBeam 5AC',
  'LiteBeam 5AC': 'board\\.name=LiteBeam 5AC',
  'PowerBeam 5AC': 'board\\.name=PowerBeam 5AC',
};

export const MANAGEMENT_PORTS = { http: 20080, https: 20443 } as const;

export const NODE_RANGE = { min: 2, max: 99 } as const;
export const DISTRICT_RANGE = { min: 1, max: 99 } as const;
export const SSID_RX = /^CDA-NET-N(?:[2-9]|[1-9][0-9])-D(?:0[1-9]|[1-9][0-9])$/;

export function ssidFor(node: number, district: number): string {
  return `CDA-NET-N${node}-D${String(district).padStart(2, '0')}`;
}

export const PPPOE_USER_RX = /^[A-Za-z0-9._-]+@cda-net\.it$/i;
/**
 * Accepts 24A43C112233, 24:a4:3c:11:22:33, 24-A4-3C-11-22-33, 24a4.3c11.2233 (any case)
 * and returns AA:BB:CC:DD:EE:FF, or null when the input is not a MAC address.
 */
export function parseMac(input: string): string | null {
  const hex = String(input).trim().replace(/[\s:.-]/g, '');
  return /^[0-9A-Fa-f]{12}$/.test(hex) ? (hex.toUpperCase().match(/../g) as string[]).join(':') : null;
}

/** `ROSSI.MARIO@cda-net.it` -> `ROSSI MARIO` (SNMP location and Device Name). */
export function customerNameFromRadius(username: string): string {
  const local = String(username).trim().replace(/@cda-net\.it$/i, '').split('@')[0] ?? '';
  return local.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Template keys that would reintroduce the legacy WAN VLAN (forbidden by current policy). */
export function containsLegacyVlan(cfg: string): boolean {
  return /^(?:vlan\.|ebtables\.sys\.vlan\.)/im.test(cfg) || /^ppp\.\d+\.devname=ath0\.\d+/im.test(cfg);
}

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(v: string, min: string): boolean {
  const a = parseVersion(v);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return true;
}

/** `X-CDA-Client: android/1.2.3` */
export function parseClientHeader(value: string | undefined): { platform: string; version: string } | null {
  const m = /^(android)\/(\d+\.\d+\.\d+)(?:[-+][A-Za-z0-9._-]+)?$/.exec(String(value ?? '').trim());
  return m ? { platform: m[1] as string, version: m[2] as string } : null;
}
