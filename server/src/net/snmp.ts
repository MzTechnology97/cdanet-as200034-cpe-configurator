import { createSocket } from 'node:dgram';

/** Minimal SNMP v2c GET (BER) without native dependencies. */

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 255, n & 255]);
}

export function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

export function encodeOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  if (parts.length < 2 || parts.some((x) => !Number.isInteger(x) || x < 0)) throw new Error('oid_non_valido');
  const out = [(parts[0] as number) * 40 + (parts[1] as number)];
  for (const v0 of parts.slice(2)) {
    let v = v0;
    const stack = [v & 0x7f];
    while ((v = Math.floor(v / 128)) > 0) stack.push((v & 0x7f) | 0x80);
    out.push(...stack.reverse());
  }
  return Buffer.from(out);
}

function encodeInt(n: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  if ((bytes[0] as number) & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

export function buildGetRequest(community: string, oids: string[], requestId: number): Buffer {
  const varbinds = Buffer.concat(oids.map((o) => tlv(0x30, Buffer.concat([tlv(0x06, encodeOid(o)), Buffer.from([0x05, 0x00])]))));
  const pdu = tlv(0xa0, Buffer.concat([encodeInt(requestId), encodeInt(0), encodeInt(0), tlv(0x30, varbinds)]));
  return tlv(0x30, Buffer.concat([encodeInt(1), tlv(0x04, Buffer.from(community, 'utf8')), pdu]));
}

interface Node {
  tag: number;
  value: Buffer;
  end: number;
}

function readNode(buf: Buffer, pos: number): Node {
  if (pos + 2 > buf.length) throw new Error('ber_troncato');
  const tag = buf[pos] as number;
  let len = buf[pos + 1] as number;
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || p + n > buf.length) throw new Error('ber_lunghezza');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | (buf[p++] as number);
  }
  if (p + len > buf.length) throw new Error('ber_troncato');
  return { tag, value: buf.subarray(p, p + len), end: p + len };
}

function children(buf: Buffer): Node[] {
  const out: Node[] = [];
  for (let p = 0; p < buf.length; ) {
    const n = readNode(buf, p);
    out.push(n);
    p = n.end;
  }
  return out;
}

export function decodeOid(b: Buffer): string {
  if (!b.length) return '';
  const first = b[0] as number;
  const parts = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    const x = b[i] as number;
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

function decodeValue(tag: number, v: Buffer): string | null {
  switch (tag) {
    case 0x04:
      return v.toString('utf8').replace(/\0+$/, '').trim();
    case 0x02:
    case 0x41:
    case 0x42:
    case 0x43:
    case 0x46: {
      let n = 0n;
      for (const b of v) n = (n << 8n) | BigInt(b);
      if (tag === 0x02 && v.length && ((v[0] as number) & 0x80)) n -= 1n << BigInt(v.length * 8);
      return tag === 0x43 ? formatTicks(n) : n.toString();
    }
    case 0x40:
      return v.length === 4 ? [...v].join('.') : `0x${v.toString('hex')}`;
    case 0x06:
      return decodeOid(v);
    case 0x05:
    case 0x80:
    case 0x81:
    case 0x82:
      return null;
    default:
      return `0x${v.toString('hex').toUpperCase()}`;
  }
}

function formatTicks(t: bigint): string {
  let s = Number(t / 100n);
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  return `${d}g ${h}h ${m}m ${s % 60}s`;
}

export function parseResponse(buf: Buffer): { requestId: number; errorStatus: number; values: Record<string, string | null> } {
  const msg = readNode(buf, 0);
  if (msg.tag !== 0x30) throw new Error('snmp_risposta_non_valida');
  const [, , pdu] = children(msg.value);
  if (!pdu || pdu.tag !== 0xa2) throw new Error('snmp_pdu_non_valida');
  const [reqId, errStatus, , vbl] = children(pdu.value);
  if (!reqId || !errStatus || !vbl) throw new Error('snmp_pdu_incompleta');
  const values: Record<string, string | null> = {};
  for (const vb of children(vbl.value)) {
    const [oid, val] = children(vb.value);
    if (oid && val) values[decodeOid(oid.value)] = decodeValue(val.tag, val.value);
  }
  return {
    requestId: Number(decodeValue(0x02, reqId.value)),
    errorStatus: Number(decodeValue(0x02, errStatus.value)),
    values,
  };
}

export function snmpGet(ip: string, community: string, oids: string[], timeoutMs = 2500): Promise<Record<string, string | null>> {
  const requestId = Math.floor(Math.random() * 0x7fffffff);
  const msg = buildGetRequest(community, oids, requestId);
  return new Promise((resolve, reject) => {
    const s = createSocket('udp4');
    const timer = setTimeout(() => {
      s.close();
      reject(new Error('snmp_timeout'));
    }, timeoutMs);
    s.on('error', (e) => {
      clearTimeout(timer);
      s.close();
      reject(e);
    });
    s.on('message', (buf) => {
      try {
        const r = parseResponse(buf);
        if (r.requestId !== requestId) return;
        clearTimeout(timer);
        s.close();
        if (r.errorStatus !== 0) reject(new Error(`snmp_error_${r.errorStatus}`));
        else resolve(r.values);
      } catch (e) {
        clearTimeout(timer);
        s.close();
        reject(e);
      }
    });
    s.send(msg, 161, ip);
  });
}
