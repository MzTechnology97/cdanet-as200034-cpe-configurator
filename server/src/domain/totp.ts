import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238: HMAC-SHA1, 30 s, 6 digits), as used by Google/Microsoft Authenticator,
 * plus one-time recovery codes. The shared secret is stored sealed with the master key.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid_base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/** 6-digit code for a time step (RFC 4226 dynamic truncation). */
export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = (h[h.length - 1] as number) & 0x0f;
  const bin = (((h[off] as number) & 0x7f) << 24) | ((h[off + 1] as number) << 16) | ((h[off + 2] as number) << 8) | (h[off + 3] as number);
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Step of the matching code (±1 step for clock drift), or null. Steps not newer than
 * [lastStep] are refused, so a code cannot be replayed.
 */
export function verifyCode(secret: string, code: string, opts: { nowMs?: number; lastStep?: number } = {}): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = currentStep(opts.nowMs);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= (opts.lastStep ?? -1)) continue;
    const expected = Buffer.from(codeAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(c))) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'CDA Net CPE'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// ---- Recovery codes: 8 one-time codes like "7KQ2-M9XD", stored as SHA-256 ------------------
const RC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const hashRecovery = (code: string) => createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

export function newRecoveryCodes(n = 8): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => RC[x % RC.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
  return { codes, hashes: codes.map(hashRecovery) };
}

export const looksLikeRecoveryCode = (code: string) => /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code.trim());
