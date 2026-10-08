import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const HOST_RX = /^[A-Za-z0-9_.:-]{1,253}$/;

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, x) => ((n << 8) | (Number(x) & 255)) >>> 0, 0) >>> 0;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** RFC1918, CGNAT 100.64/10, link-local and loopback. */
export function isPrivateIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const n = ipToInt(ip);
  return (
    n >>> 24 === 10 ||
    n >>> 20 === 0xac1 ||
    n >>> 16 === 0xc0a8 ||
    n >>> 22 === 0x191 ||
    n >>> 16 === 0xa9fe ||
    n >>> 24 === 127
  );
}

export function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  return isIP(v) === 6 && (v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:'));
}

export async function resolveIPv4(host: string): Promise<string> {
  if (!HOST_RX.test(host)) throw new Error('host_non_valido');
  if (isIP(host) === 4) return host;
  return (await lookup(host, { family: 4 })).address;
}

export async function resolvePrivateIPv4(host: string): Promise<string> {
  const ip = await resolveIPv4(host);
  if (!isPrivateIPv4(ip)) throw new Error('target_non_privato');
  return ip;
}

export interface CidrRange {
  prefix: number;
  network: string;
  first: number;
  last: number;
}

/** Private/CGNAT networks only, /24 or smaller, to keep scans bounded. */
export function parseScanCidr(cidr: string): CidrRange {
  const m = /^((?:\d{1,3}\.){3}\d{1,3})\/(\d|[12]\d|3[0-2])$/.exec(String(cidr).trim());
  if (!m || isIP(m[1] as string) !== 4) throw new Error('cidr_non_valido');
  const prefix = Number(m[2]);
  if (prefix < 24) throw new Error('cidr_troppo_ampio');
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const base = (ipToInt(m[1] as string) & mask) >>> 0;
  if (!isPrivateIPv4(intToIp(base))) throw new Error('rete_non_privata');
  const broadcast = (base | (~mask >>> 0)) >>> 0;
  return {
    prefix,
    network: intToIp(base),
    first: prefix >= 31 ? base : base + 1,
    last: prefix >= 31 ? broadcast : broadcast - 1,
  };
}
