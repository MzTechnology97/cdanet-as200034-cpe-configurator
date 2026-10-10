/**
 * Admin "Stato CPE": what the console and the app show of a UISP device, built from the UISP
 * detail, its interfaces, the airMAX wireless configuration and its UISP settings. Only technical
 * fields: Wi-Fi keys, RADIUS secrets and passwords of the configuration never leave the server.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** "8.7.15" from UISP's {major, minor, patch}. */
const semver = (v: unknown): string | null => {
  const o = obj(v);
  return num(o.major) !== null ? `${o.major}.${o.minor}.${o.patch}` : null;
};

export interface CpeView {
  id: string;
  name: string;
  alias: string | null;
  note: string | null;
  maintenance: boolean;
  model: string | null;
  modelName: string | null;
  mac: string | null;
  serial: string | null;
  ip: string | null;
  role: string | null;
  site: string | null;
  ap: string | null;
  status: string;
  online: boolean;
  lastSeen: string | null;
  uptimeSec: number | null;
  cpu: number | null;
  ram: number | null;
  temperature: number | null;
  firmware: { current: string | null; compatible: boolean | null; canUpgrade: boolean; upgradeTo: string | null; upgradeStatus: string | null; upgradeProgress: number | null };
  radio: {
    mode: string | null;
    frequency: number | null;
    channelWidth: number | null;
    signal: number | null;
    remoteSignal: number | null;
    distanceM: number | null;
    txPower: number | null;
    antennaGain: number | null;
    downlinkMbps: number | null;
    uplinkMbps: number | null;
    ssid: string | null;
    security: string | null;
    ackDistanceM: number | null;
    autoChannelWidth: boolean | null;
  };
  interfaces: Array<{ name: string; type: string | null; enabled: boolean | null; plugged: boolean | null; speed: string | null; addresses: string[] }>;
  latestBackup: { id: string; at: string | null } | null;
  location: { lat: number; lon: number } | null;
}

const mbps = (v: unknown) => (num(v) !== null ? Math.round(num(v)! / 1e6) : null);

export function cpeView(detail: unknown, interfaces: unknown, wireless: unknown, unms: unknown): CpeView {
  const d = obj(detail);
  const id = obj(d.identification);
  const ov = obj(d.overview);
  const up = obj(d.upgrade);
  const meta = { ...obj(d.meta), ...obj(obj(unms).meta) };
  const w = obj(wireless);
  const loc = obj(d.location);
  const status = str(ov.status) ?? 'unknown';
  return {
    id: str(id.id) ?? '',
    name: str(id.displayName) ?? str(id.name) ?? '',
    alias: str(meta.alias),
    note: str(meta.note),
    maintenance: meta.maintenance === true,
    model: str(id.model),
    modelName: str(id.modelName),
    mac: str(id.mac),
    serial: str(id.serialNumber),
    ip: str(d.ipAddress),
    role: str(id.role),
    site: str(obj(id.site).name),
    ap: str(obj(obj(d.attributes).apDevice).name) ?? str(obj(d.uplinkDevice).name),
    status,
    online: status === 'active',
    lastSeen: str(ov.lastSeen),
    uptimeSec: num(ov.uptime),
    cpu: num(ov.cpu),
    ram: num(ov.ram),
    temperature: num(ov.temperature),
    firmware: {
      current: str(id.firmwareVersion),
      compatible: bool(obj(d.firmware).compatible),
      canUpgrade: ov.canUpgrade === true,
      upgradeTo: str(up.firmwareVersion) ?? semver(up.firmware),
      upgradeStatus: str(up.status),
      upgradeProgress: num(up.progress),
    },
    radio: {
      mode: str(w.mode) ?? str(ov.wirelessMode),
      frequency: num(ov.frequency) ?? num(w.centerFrequency),
      channelWidth: num(ov.channelWidth) ?? (num(w.channelWidth) || null),
      signal: num(ov.signal),
      remoteSignal: num(ov.remoteSignalMax),
      distanceM: num(ov.distance),
      txPower: num(ov.transmitPower) ?? num(w.txPower),
      antennaGain: num(w.antennaGain) ?? num(obj(ov.antenna).gain),
      downlinkMbps: mbps(ov.downlinkCapacity),
      uplinkMbps: mbps(ov.uplinkCapacity),
      ssid: str(w.ssid) ?? str(obj(d.attributes).ssid),
      // only the kind of security, never the key
      security: str(obj(w.securityConfig).security),
      ackDistanceM: num(w.ackDistance),
      autoChannelWidth: bool(w.isAutoChannelWidthEnabled),
    },
    interfaces: arr(interfaces).map((i) => {
      const o = obj(i);
      const ident = obj(o.identification);
      const st = obj(o.status);
      return {
        name: str(ident.displayName) ?? str(ident.name) ?? '?',
        type: str(ident.type),
        enabled: bool(o.enabled),
        plugged: bool(st.plugged),
        speed: str(st.currentSpeed) ?? str(st.speed),
        addresses: arr(o.addresses).map((a) => str(obj(a).cidr)).filter((x): x is string => !!x),
      };
    }),
    latestBackup: str(obj(d.latestBackup).id) ? { id: str(obj(d.latestBackup).id)!, at: str(obj(d.latestBackup).timestamp) } : null,
    location: num(loc.latitude) !== null && num(loc.longitude) !== null ? { lat: num(loc.latitude)!, lon: num(loc.longitude)! } : null,
  };
}

/**
 * Body for PUT /devices/{id}/system/unms: the device's current UISP settings with only alias, note
 * and maintenance changed (the endpoint wants the whole object back).
 */
export function unmsWithMeta(current: unknown, change: { alias?: string | null; note?: string | null; maintenance?: boolean }) {
  const c = obj(current);
  const meta = { ...obj(c.meta) };
  if (change.alias !== undefined) meta.alias = change.alias || null;
  if (change.note !== undefined) meta.note = change.note || null;
  if (change.maintenance !== undefined) meta.maintenance = change.maintenance;
  return { ...c, meta };
}
