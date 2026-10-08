import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * AES-256-GCM sealing for secrets at rest (WPA2 keys, airOS templates).
 * Format `iv.tag.ciphertext` (base64) is compatible with databases created by v0.5.x.
 */
export function createSealer(masterKey: Buffer) {
  if (masterKey.length !== 32) throw new Error('master key must be 32 bytes');
  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', masterKey, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
    },
    open(sealed: string): string {
      const parts = sealed.split('.');
      if (parts.length !== 3) throw new Error('invalid sealed value');
      const [iv, tag, ct] = parts.map((x) => Buffer.from(x, 'base64')) as [Buffer, Buffer, Buffer];
      const d = createDecipheriv('aes-256-gcm', masterKey, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    },
  };
}
export type Sealer = ReturnType<typeof createSealer>;

/** scrypt password hash `salthex:hashhex`, compatible with v0.5.x accounts. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A dummy hash used to keep login timing constant for unknown usernames. */
export const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(12).toString('hex'));

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * FreeBSD MD5-crypt (`$1$salt$hash`), the format airOS stores in `users.N.password`.
 * Used for the `${CPE_PASSWORD_HASH}` template placeholder.
 */
export function md5Crypt(password: string, salt = randomSalt(8)): string {
  const magic = '$1$';
  const pw = Buffer.from(password, 'utf8');
  const s = Buffer.from(salt.slice(0, 8), 'utf8');
  const md5 = () => createHash('md5');

  const alt = md5().update(pw).update(s).update(pw).digest();
  const ctx = md5().update(pw).update(magic).update(s);
  for (let pl = pw.length; pl > 0; pl -= 16) ctx.update(alt.subarray(0, Math.min(16, pl)));
  for (let i = pw.length; i; i >>= 1) ctx.update(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  let fin = ctx.digest();

  for (let i = 0; i < 1000; i++) {
    const c = md5();
    c.update(i & 1 ? pw : fin);
    if (i % 3) c.update(s);
    if (i % 7) c.update(pw);
    c.update(i & 1 ? fin : pw);
    fin = c.digest();
  }

  const b = (i: number) => fin[i] as number;
  const to64 = (v: number, n: number) => {
    let out = '';
    while (n-- > 0) {
      out += ITOA64[v & 0x3f];
      v >>= 6;
    }
    return out;
  };
  const hash =
    to64((b(0) << 16) | (b(6) << 8) | b(12), 4) +
    to64((b(1) << 16) | (b(7) << 8) | b(13), 4) +
    to64((b(2) << 16) | (b(8) << 8) | b(14), 4) +
    to64((b(3) << 16) | (b(9) << 8) | b(15), 4) +
    to64((b(4) << 16) | (b(10) << 8) | b(5), 4) +
    to64(b(11), 2);
  return `${magic}${s.toString('utf8')}$${hash}`;
}

function randomSalt(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (const x of bytes) out += ITOA64[x & 0x3f];
  return out;
}
