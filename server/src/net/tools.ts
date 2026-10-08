import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import dns from 'node:dns/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { MAC_RX, normalizeMac } from '../domain/policy.ts';
import { intToIp, ipToInt, parseScanCidr, resolveIPv4, resolvePrivateIPv4 } from './ip.ts';
import { snmpGet } from './snmp.ts';

/** Network diagnostics executed from the CDA Net server (NOC vantage point). */

const execFileP = promisify(execFile);
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

async function run(cmd: string, args: string[], timeout: number): Promise<string> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout, maxBuffer: 256 * 1024, env: { PATH: SAFE_PATH } });
    return String(stdout || stderr || '');
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const out = String(err.stdout || err.stderr || '');
    if (out) return out;
    throw e;
  }
}

async function reverseName(ip: string): Promise<string> {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 700)),
    ]);
    return names[0] ?? '';
  } catch {
    return '';
  }
}

export async function ping(host: string) {
  const ip = await resolveIPv4(host);
  try {
    const out = await run('ping', ['-c', '1', '-W', '2', ip], 3500);
    const m = /time[=<]\s*([0-9.]+)\s*ms/i.exec(out);
    const reachable = /\b1 (?:packets )?received\b|bytes from/i.test(out);
    return { host, ip, reachable, ms: reachable && m ? Number(m[1]) : null };
  } catch {
    return { host, ip, reachable: false, ms: null };
  }
}

export async function traceroute(host: string) {
  const ip = await resolveIPv4(host);
  const out = await run('traceroute', ['-n', '-q', '1', '-w', '1', '-m', '20', ip], 25_000).catch(() => '');
  const hops: Array<{ hop: number; ip?: string; hostname?: string; ms?: number; timeout?: boolean; reached?: boolean }> = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(?:(\d{1,3}(?:\.\d{1,3}){3})|\*)\s*(?:([0-9.]+)\s*ms)?/.exec(line);
    if (!m) continue;
    if (m[2]) {
      hops.push({ hop: Number(m[1]), ip: m[2], hostname: await reverseName(m[2]), ms: m[3] ? Number(m[3]) : undefined, reached: m[2] === ip });
    } else {
      hops.push({ hop: Number(m[1]), timeout: true });
    }
  }
  return { target: ip, hops, reached: hops.some((h) => h.reached) };
}

export async function dnsLookup(host: string) {
  if (!/^[A-Za-z0-9_.:-]{1,253}$/.test(host)) throw new Error('host_non_valido');
  const xs = await dns.lookup(host, { all: true });
  return { host, addresses: xs.map((x) => x.address) };
}

export async function interfaces() {
  const addresses: string[] = [];
  let iface = '';
  let cidr = '';
  for (const [name, vals] of Object.entries(networkInterfaces())) {
    for (const v of vals ?? []) {
      if (v.internal || v.family !== 'IPv4') continue;
      addresses.push(v.cidr ?? v.address);
      if (!iface) {
        iface = name;
        cidr = v.cidr ?? '';
      }
    }
  }
  let gateway = '';
  try {
    const r = await run('ip', ['route', 'show', 'default'], 2500);
    gateway = /default via\s+(\S+)/.exec(r)?.[1] ?? '';
  } catch {
    /* ip not available */
  }
  return { interface: iface, addresses, cidr, gateway, dns: dns.getServers() };
}

export async function neighbors() {
  const out = await run('ip', ['neigh', 'show'], 3000).catch(() => '');
  const list: Array<{ ip: string; interface: string; mac: string; state: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^((?:\d{1,3}\.){3}\d{1,3})\s+dev\s+(\S+)(?:\s+lladdr\s+([0-9a-f:]{17}))?.*?\s(\w+)\s*$/i.exec(line);
    if (m) list.push({ ip: m[1] as string, interface: m[2] as string, mac: (m[3] ?? '').toUpperCase(), state: m[4] as string });
  }
  return { neighbors: list };
}

export async function discover(cidr: string) {
  const range = parseScanCidr(cidr);
  const ips: string[] = [];
  for (let n = range.first; n <= range.last && ips.length < 254; n++) ips.push(intToIp(n >>> 0));
  const hosts: Array<{ ip: string; hostname: string; mac?: string }> = [];
  let pos = 0;
  const worker = async () => {
    while (pos < ips.length) {
      const ip = ips[pos++] as string;
      if ((await ping(ip)).reachable) hosts.push({ ip, hostname: await reverseName(ip) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, ips.length) }, worker));
  const macs = new Map((await neighbors()).neighbors.map((x) => [x.ip, x.mac]));
  for (const h of hosts) {
    const mac = macs.get(h.ip);
    if (mac) h.mac = mac;
  }
  hosts.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  return { cidr: `${range.network}/${range.prefix}`, hosts };
}

export async function snmpSystem(host: string, community: string) {
  if (!community || community.length > 64) throw new Error('community_non_valida');
  const ip = await resolvePrivateIPv4(host);
  const oids = { sysDescr: '1.3.6.1.2.1.1.1.0', sysUpTime: '1.3.6.1.2.1.1.3.0', sysContact: '1.3.6.1.2.1.1.4.0', sysName: '1.3.6.1.2.1.1.5.0', sysLocation: '1.3.6.1.2.1.1.6.0' };
  const v = await snmpGet(ip, community, Object.values(oids));
  const out: Record<string, string> = { host: ip };
  for (const [k, oid] of Object.entries(oids)) out[k] = v[oid] ?? '—';
  return out;
}

export async function tcpProbe(host: string, ports: number[]) {
  const ip = await resolvePrivateIPv4(host);
  const open: number[] = [];
  await Promise.all(
    [...new Set(ports)].map(
      (port) =>
        new Promise<void>((done) => {
          const s = createConnection({ host: ip, port, timeout: 700 }, () => {
            open.push(port);
            s.destroy();
            done();
          });
          s.on('timeout', () => {
            s.destroy();
            done();
          });
          s.on('error', () => done());
        }),
    ),
  );
  return { host: ip, openPorts: open.sort((a, b) => a - b), reachable: open.length > 0 };
}

function netbiosQuery(): Buffer {
  const q = Buffer.alloc(50);
  q.writeUInt16BE(0x4344, 0);
  q.writeUInt16BE(1, 4);
  q[12] = 32;
  for (let i = 0; i < 16; i++) {
    const v = i === 0 ? 0x2a : 0x20;
    q[13 + i * 2] = 65 + ((v >> 4) & 15);
    q[14 + i * 2] = 65 + (v & 15);
  }
  q.writeUInt16BE(0x21, 46);
  q.writeUInt16BE(1, 48);
  return q;
}

export function parseNetbiosNames(buf: Buffer): string[] {
  // Header(12) + name(34) + type/class(4) + ttl(4) + rdlength(2) = 56, then count byte.
  const count = buf[56] ?? 0;
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const off = 57 + i * 18;
    if (off + 18 > buf.length) break;
    const name = buf.subarray(off, off + 15).toString('ascii').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export async function netbios(host: string) {
  const ip = await resolvePrivateIPv4(host);
  return new Promise<{ host: string; available: boolean; names: string[] }>((resolve) => {
    const s = createSocket('udp4');
    const timer = setTimeout(() => {
      s.close();
      resolve({ host: ip, available: false, names: [] });
    }, 2000);
    s.once('message', (buf) => {
      clearTimeout(timer);
      s.close();
      resolve({ host: ip, available: true, names: parseNetbiosNames(buf) });
    });
    s.send(netbiosQuery(), 137, ip);
  });
}

function udpDiscovery(kind: 'onvif' | 'hikvision') {
  const devices: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  return new Promise<{ protocol: string; devices: Array<Record<string, string>> }>((resolve, reject) => {
    const s = createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => {
      s.close();
      reject(e);
    });
    s.on('message', (buf, rinfo) => {
      if (seen.has(rinfo.address)) return;
      seen.add(rinfo.address);
      const body = buf.toString('utf8');
      const d: Record<string, string> = { ip: rinfo.address };
      const xaddrs = /<[^>]*XAddrs[^>]*>([^<]+)/i.exec(body)?.[1];
      if (xaddrs) d.xaddrs = xaddrs;
      for (const tag of ['DeviceDescription', 'DeviceSN', 'MAC', 'IPv4Address', 'HttpPort', 'SoftwareVersion']) {
        const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(body);
        if (m) d[tag] = m[1] as string;
      }
      devices.push(d);
    });
    s.bind(() => {
      if (kind === 'onvif') {
        const xml =
          '<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:' +
          randomUUID() +
          '</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
        s.setMulticastTTL(2);
        s.send(Buffer.from(xml), 3702, '239.255.255.250');
      } else {
        s.setBroadcast(true);
        const xml = `<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${randomUUID().toUpperCase()}</Uuid><Types>inquiry</Types></Probe>`;
        s.send(Buffer.from(xml), 37020, '239.255.255.250');
        s.send(Buffer.from(xml), 37020, '255.255.255.255');
      }
    });
    setTimeout(() => {
      s.close();
      resolve({ protocol: kind === 'onvif' ? 'ONVIF WS-Discovery' : 'Hikvision SADP', devices });
    }, 3200);
  });
}
export const onvifDiscovery = () => udpDiscovery('onvif');
export const hikvisionDiscovery = () => udpDiscovery('hikvision');

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'CDA-Net-CPE-Configurator/1' } });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
}

export async function bgpView(resource: string) {
  if (!/^(AS\d{1,10}|[0-9A-Fa-f:.]+(?:\/\d{1,3})?)$/i.test(resource)) throw new Error('risorsa_bgp_non_valida');
  const j = (await fetchJson(
    `https://stat.ripe.net/data/routing-status/data.json?resource=${encodeURIComponent(resource)}`,
    8000,
  )) as { data?: { visibility?: unknown; origins?: Array<{ origin?: number }>; first_seen?: unknown; less_specifics?: unknown[] } };
  return {
    resource,
    visibility: j.data?.visibility ?? null,
    origins: (j.data?.origins ?? []).map((o) => o.origin),
    firstSeen: j.data?.first_seen ?? null,
    lessSpecifics: j.data?.less_specifics ?? [],
    source: 'RIPEstat',
  };
}

const vendorCache = new Map<string, string>();
export async function macVendor(mac: string) {
  if (!MAC_RX.test(mac)) throw new Error('mac_non_valido');
  const norm = normalizeMac(mac);
  const oui = norm.slice(0, 8);
  const cached = vendorCache.get(oui);
  if (cached) return { mac: norm, vendor: cached };
  try {
    const r = await fetch(`https://api.macvendors.com/${encodeURIComponent(norm)}`, { signal: AbortSignal.timeout(5000) });
    const vendor = r.ok ? (await r.text()).trim() : 'Non trovato';
    if (r.ok || r.status === 404) vendorCache.set(oui, vendor);
    return { mac: norm, vendor };
  } catch {
    return { mac: norm, vendor: 'Lookup non disponibile' };
  }
}
