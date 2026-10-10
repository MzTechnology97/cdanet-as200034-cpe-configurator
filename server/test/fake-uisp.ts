import { createUisp } from '../src/services/uisp.ts';

// UISP v2.1-shaped fixtures: two APs (one located via its site), one pending station.
const SITES = [
  { id: 'site-n2', identification: { name: 'Nodo 2 - Monte', type: 'site', status: 'active' }, description: { address: 'Contrada Monte, 94100 Enna EN', location: { latitude: 37.6, longitude: 14.1 } } },
  { id: 'site-n7', identification: { name: 'Nodo 7 - Valle', type: 'site' }, description: { location: { latitude: 37.51, longitude: 14.01 } } },
];
const AP_N2 = {
  identification: { id: 'ap-n2', name: 'AP N2 D01', mac: '24:A4:3C:00:00:01', role: 'ap', model: 'R5AC-Lite', site: { id: 'site-n2', name: 'Nodo 2 - Monte' }, authorized: true },
  overview: { status: 'active', stationsCount: 12, frequency: 5600, wirelessMode: 'ap-ptmp' },
  attributes: { ssid: 'CDA-NET-N2-D01' },
  location: { latitude: 37.6, longitude: 14.1 },
};
const AP_N7 = {
  identification: { id: 'ap-n7', name: 'AP N7 D03', mac: '24A43C000002', role: 'ap', site: { id: 'site-n7', name: 'Nodo 7 - Valle' }, authorized: true },
  overview: { status: 'active', stationsCount: 3 },
  attributes: { ssid: 'CDA-NET-N7-D03' },
  location: null, // falls back to the site position
};
const FAR_AP = {
  identification: { id: 'ap-far', name: 'AP lontano', role: 'ap', site: { id: 'x', name: 'Lontano' }, authorized: true },
  overview: { status: 'active' },
  attributes: { ssid: 'CDA-NET-N99-D01' },
  location: { latitude: 45.46, longitude: 9.19 },
};
/** PtP backhaul end next to Nodo 2: never a coverage target. */
const PTP = {
  identification: { id: 'ptp-1', name: 'PtP Monte-Valle', role: 'ap', site: { id: 'x', name: 'Lontano' }, authorized: true },
  overview: { status: 'active', stationsCount: 1, wirelessMode: 'ap-ptp' },
  location: { latitude: 37.6005, longitude: 14.1005 },
};
/** Customer installed before the app (only in UISP), on AP N2. */
const OLD_CPE = {
  identification: { id: 'cpe-old', name: 'BIANCHI LUCA', mac: '22:33:44:55:66:77', role: 'station', authorized: true, firmwareVersion: '8.7.4' },
  overview: { status: 'active', signal: -66, wirelessMode: 'sta-ptmp' },
  attributes: { ssid: 'CDA-NET-N2-D01', apDevice: { id: 'ap-n2', name: 'AP N2 D01' } },
};
export const STATION = {
  identification: { id: 'cpe-1', name: 'ROSSI MARIO', mac: 'aa-bb-cc-dd-ee-ff', role: 'station', authorized: false, firmwareVersion: '8.7.4' },
  overview: { status: 'active', signal: -58, wirelessMode: 'sta-ptmp', mainInterfaceSpeed: { interfaceId: 'eth0', availableSpeed: '10-half' }, downlinkCapacity: 250000000 },
  attributes: { ssid: 'CDA-NET-N2-D01', apDevice: { id: 'ap-n2', name: 'AP N2 D01' } },
};

export function fakeUisp(opts: { authorizeMethod?: 'POST' | 'PUT'; backupCfg?: string } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown; token: string | null }> = [];
  const devices = [AP_N2, AP_N7, FAR_AP, PTP, STATION, OLD_CPE].map((d) => structuredClone(d));
  const unms: Record<string, unknown> = {};
  let wireless: unknown = {
    mode: 'sta-ptmp', ssid: 'CDA-NET-N2-D01', txPower: 24, antennaGain: 23, ackDistance: 2400, isACKAutoDistanceEnabled: true, isAutoChannelWidthEnabled: false, channelWidth: 20,
    boardInfo: { radio1: { txPowerRange: { min: -4, max: 24 }, channelWidthList: [10, 20, 40, 80] } },
    securityConfig: { security: 'wpa2AES', presharedKey: 'chiave-segreta-wpa', authServerSecret: 'segreto-radius' },
  };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/nms/api/v2.1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, token: new Headers(init?.headers).get('x-auth-token') });
    if (url.host === 'geo.test') {
      return new Response(JSON.stringify([{ display_name: 'Via Roma 1, 94100 Enna', lat: '37.58', lon: '14.12', type: 'house' }]));
    }
    if (new Headers(init?.headers).get('x-auth-token') !== 'tok-secret') return new Response('{"message":"unauthorized"}', { status: 401 });
    if (path === '/nms/version') return new Response(JSON.stringify({ version: '3.1.65', deployment: 'docker', build: 'x', time: '' }));
    if (path === '/devices' && method === 'GET') return new Response(JSON.stringify(devices));
    if (path === '/sites' && method === 'GET') return new Response(JSON.stringify(SITES));
    const auth = /^\/devices\/([^/]+)\/authorize$/.exec(path);
    if (auth) {
      if (method !== (opts.authorizeMethod ?? 'POST')) return new Response('', { status: 405 });
      const d = devices.find((x) => x.identification.id === auth[1])!;
      d.identification.authorized = true;
      (d.identification as Record<string, unknown>).site = { id: body.siteId, name: SITES.find((s) => s.id === body.siteId)?.identification.name };
      return new Response('{}');
    }
    if (/^\/devices\/[^/]+\/backups$/.test(path)) {
      const list = [{ id: 'bk1', timestamp: '2026-10-08T10:00:00Z', type: 'manual', extension: 'cfg' }];
      if (opts.backupCfg) list.push({ id: 'bk2', timestamp: '2026-10-09T03:00:00Z', type: 'auto', extension: 'cfg' });
      return method === 'POST' ? new Response('{}') : new Response(JSON.stringify(list));
    }
    if (/^\/devices\/[^/]+\/statistics$/.test(path)) {
      // a week of hourly samples, signal slowly degrading from -58 to -66 dBm
      const now = Date.now();
      const series = (f: (i: number) => number) => ({ avg: Array.from({ length: 168 }, (_, i) => ({ x: now - (167 - i) * 3600_000, y: f(i) })) });
      return new Response(JSON.stringify({ signal: series((i) => -58 - (8 * i) / 167), remoteSignal: series(() => -60), downlinkCapacity: series(() => 250000), uplinkCapacity: series(() => 200000), ping: { avg: [] } }));
    }
    // admin "Stato CPE"
    const one = /^\/devices\/([^/]+)\/(detail|interfaces|system\/unms|restart|refresh|upgrade-to-latest)$/.exec(path);
    if (one) {
      const d = devices.find((x) => x.identification.id === one[1]);
      if (!d) return new Response('{"message":"Device not found"}', { status: 404 });
      if (one[2] === 'detail') {
        return new Response(
          JSON.stringify({
            ...d,
            identification: { ...d.identification, model: 'LBE-5AC-Gen2', modelName: 'LiteBeam 5AC Gen2', serialNumber: 'S123', displayName: d.identification.name },
            overview: { ...d.overview, uptime: 86400, cpu: 12, ram: 40, frequency: 5600, channelWidth: 20, distance: 2300, canUpgrade: true, lastSeen: '2026-10-10T10:00:00Z' },
            firmware: { compatible: true },
            upgrade: { status: null, progress: 0, firmwareVersion: '8.7.15' },
            meta: { alias: null, note: null, maintenance: false },
            latestBackup: { id: 'bk1', timestamp: '2026-10-08T10:00:00Z' },
            location: { latitude: 37.58, longitude: 14.12 },
            ipAddress: '10.99.0.21/32',
          }),
        );
      }
      if (one[2] === 'interfaces') return new Response(JSON.stringify([{ identification: { name: 'eth0', type: 'ethernet' }, enabled: true, status: { plugged: true, currentSpeed: '1000-full' }, addresses: [] }]));
      if (one[2] === 'system/unms') {
        if (method === 'PUT') {
          unms[one[1]!] = body;
          return new Response('{}');
        }
        return new Response(JSON.stringify(unms[one[1]!] ?? { overrideGlobal: false, devicePingAddress: null, meta: { alias: null, note: null, maintenance: false, customIpAddress: null } }));
      }
      return new Response(JSON.stringify({ result: true, message: 'ok' }));
    }
    if (/^\/devices\/airmaxes\/[^/]+\/config\/wireless$/.test(path)) {
      if (method === 'PUT') {
        wireless = body;
        return new Response('{}');
      }
      return new Response(JSON.stringify(wireless));
    }
    if (/^\/devices\/[^/]+\/backups\/[^/]+\/apply$/.test(path)) return new Response('{"result":true}');
    if (path === '/outages') return new Response(JSON.stringify({ items: [{ id: 'o1', startTimestamp: '2026-10-05T02:00:00Z', endTimestamp: '2026-10-05T02:20:00Z', type: 'outage', aggregatedTime: 1200, inProgress: false }] }));
        if (opts.backupCfg && /^\/devices\/[^/]+\/backups\/bk2$/.test(path)) return new Response(opts.backupCfg, { headers: { 'content-type': 'text/plain' } });
    if (/^\/devices\/[^/]+\/backups\/bk1$/.test(path)) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, uisp: createUisp({ url: 'https://uisp.test', token: 'tok-secret', fetchImpl }) };
}

