import type { Db } from '../db.ts';
import { recordEvent } from '../db.ts';
import type { Sealer } from '../crypto.ts';
import { hashRecovery, looksLikeRecoveryCode, verifyCode } from '../domain/totp.ts';

/** The fields of a user the second step needs. */
export interface SecondFactorUser {
  id: number;
  username: string;
  totp_secret: string;
  totp_last_step: number;
  recovery_codes: string;
}

/**
 * TOTP code (anti-replay) or one-time recovery code; consumes what it uses. Shared by the login
 * and by the consent of a Claude connection (MCP), which asks for the same two steps.
 */
export function checkSecondFactor(db: Db, sealer: Sealer, u: SecondFactorUser, code: string): boolean {
  if (looksLikeRecoveryCode(code) && !/^\d{6}$/.test(code)) {
    const hashes = JSON.parse(u.recovery_codes || '[]') as string[];
    const h = hashRecovery(code);
    if (!hashes.includes(h)) return false;
    db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes.filter((x) => x !== h)), u.id);
    recordEvent(db, u.id, 'account.recovery_code', u.username, `codice di recupero usato, ne restano ${hashes.length - 1}`);
    return true;
  }
  const step = verifyCode(sealer.open(u.totp_secret), code, { lastStep: u.totp_last_step });
  if (step === null) return false;
  db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id);
  return true;
}
