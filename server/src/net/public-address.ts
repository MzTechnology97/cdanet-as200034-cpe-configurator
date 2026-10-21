import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { ipToInt } from './ip.ts';

/**
 * Requests towards the public Internet only (issue #275). A specialist may be outside CDA Net: the
 * UISP of his companies is on the Internet, and the server must never become his way into CDA
 * Net's own network (private and CGNAT addresses, the server itself). Every connection is checked,
 * redirects included: a name by the addresses it resolves to, an address as it is written.
 */

export const NOT_PUBLIC = 'connector_target_not_public';

/** IPv4 ranges that are not the public Internet: [first address, prefix length]. */
const V4_NOT_PUBLIC: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
];

const inV4 = (ip: string, [net, bits]: [string, number]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(net) & mask) >>> 0);
};

/** The 8 groups of an IPv6 address (null when it is not one). */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  // an IPv4 address at the end (::ffff:10.0.0.1): two groups
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const n = ipToInt(tail[1] as string);
    s = `${s.slice(0, -tail[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const a = head ? head.split(':') : [];
  const b = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - a.length - b.length;
  const all = [...a, ...Array<string>(Math.max(fill, 0)).fill('0'), ...b];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/** Whether an address is on the public Internet (IPv4 or IPv6, as text). */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return !V4_NOT_PUBLIC.some((r) => inV4(ip, r));
  if (kind !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = g;
  const v4 = `${g6 >>> 8}.${g6 & 255}.${g7 >>> 8}.${g7 & 255}`;
  // unspecified and loopback
  if (g.slice(0, 7).every((x) => x === 0) && g7 <= 1) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: the IPv4 address decides
  if (g.slice(0, 5).every((x) => x === 0) && (g5 === 0xffff || g5 === 0)) return isPublicAddress(v4);
  // NAT64 (64:ff9b::/96): the IPv4 address decides
  if (g0 === 0x64 && g1 === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicAddress(v4);
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return isPublicAddress(`${g1 >>> 8}.${g1 & 255}.${(g[2] ?? 0) >>> 8}.${(g[2] ?? 0) & 255}`); // 6to4
  return (g0 & 0xe000) === 0x2000; // global unicast 2000::/3 only
}

export const notPublic = (): NodeJS.ErrnoException => Object.assign(new Error(NOT_PUBLIC), { code: 'ENOTPUBLIC' });

/** dns.lookup that refuses a name when any of its addresses is not public. */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true } as LookupAllOptions, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, []);
    const first = addresses[0];
    if (!first || addresses.some((a) => !isPublicAddress(a.address))) return callback(notPublic(), []);
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

/** The host of a URL, without the brackets of an IPv6 address. */
export const hostOf = (h: string) => h.replace(/^\[|\]$/g, '');

/**
 * What is wrong with a URL the server would call, null when nothing: http(s), no user or password,
 * no query or fragment (nothing to steer the path the server appends), and an address written in
 * it must be public.
 */
export function publicUrlProblem(url: string): 'connector_url_invalid' | typeof NOT_PUBLIC | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'connector_url_invalid';
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || url.includes('?') || url.includes('#') || url.includes('@')) return 'connector_url_invalid';
  const host = hostOf(u.hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host))) return NOT_PUBLIC;
  return null;
}

/** Whether an error of a request comes from this guard (also when wrapped, as fetch does). */
export function isNotPublicError(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 5; i++) {
    const m = (x as Error).message ?? '';
    if (m.includes(NOT_PUBLIC)) return true;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
}
