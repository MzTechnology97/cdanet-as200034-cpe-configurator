import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import type { Db } from './db.ts';

export type Role = 'admin' | 'installer';

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
  /** Two-step verification enabled on the account. */
  totp?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown> | undefined;
  constructor(status: number, code: string, extra?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function createAuth(db: Db, secret: Uint8Array, ttlHours: number) {
  const ISSUER = 'cdanet-cpe';

  /** Short-lived proof that the password was right; only exchangeable for a session with the TOTP code. */
  async function issueMfaToken(u: { id: number; username: string; token_version: number }) {
    return new SignJWT({ username: u.username, tv: u.token_version, mfa: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(u.id))
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
  }

  async function verifyMfaToken(token: string): Promise<{ id: number; tv: number }> {
    try {
      const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ['HS256'] });
      if (payload.mfa !== true) throw new Error('not_mfa');
      return { id: Number(payload.sub), tv: Number(payload.tv) };
    } catch {
      throw new HttpError(401, 'mfa_expired');
    }
  }

  /**
   * Long-lived token for the app's background checks (power outages): it only opens
   * the outage feed, never a session; revoked with the account's sessions.
   */
  async function issueFeedToken(u: { id: number; username: string; token_version: number }, scope: 'outages' | 'feed' = 'outages') {
    return new SignJWT({ username: u.username, tv: u.token_version, scope })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(u.id))
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('90d')
      .sign(secret);
  }

  /** [scopes]: "outages" opens only the outage feed; "feed" (app 1.32.15+) also the notifications. */
  async function verifyFeedToken(req: FastifyRequest, scopes: string[] = ['outages', 'feed']): Promise<AuthUser> {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    try {
      if (!m) throw new Error('missing');
      const { payload } = await jwtVerify(m[1] as string, secret, { issuer: ISSUER, algorithms: ['HS256'] });
      if (typeof payload.scope !== 'string' || !scopes.includes(payload.scope)) throw new Error('scope');
      const row = userStmt.get(Number(payload.sub)) as { id: number; username: string; role: Role; active: number; token_version: number } | undefined;
      if (!row || !row.active || row.token_version !== payload.tv) throw new Error('revoked');
      return { id: row.id, username: row.username, role: row.role };
    } catch {
      throw new HttpError(401, 'unauthorized');
    }
  }

  /** Admin policy: two-step verification required for administrators (settings table). */
  const policyStmt = db.prepare("SELECT value FROM settings WHERE key = 'security.totp_admins'");
  const totpRequiredForAdmins = () => (policyStmt.get() as { value: string } | undefined)?.value === 'required';

  async function issueToken(u: { id: number; username: string; role: Role; token_version: number }) {
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
    const token = await new SignJWT({ username: u.username, role: u.role, tv: u.token_version })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(u.id))
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(secret);
    return { token, expiresAt: expiresAt.toISOString() };
  }

  const userStmt = db.prepare('SELECT id, username, role, active, token_version, totp_enabled FROM users WHERE id = ?');

  /** Verifies the bearer token and re-checks the account on every request (disable/reset revoke immediately). */
  async function authenticate(req: FastifyRequest): Promise<AuthUser> {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) throw new HttpError(401, 'unauthorized');
    try {
      const { payload } = await jwtVerify(m[1] as string, secret, { issuer: ISSUER, algorithms: ['HS256'] });
      if (payload.mfa === true || payload.scope !== undefined) throw new Error('not_a_session_token');
      const row = userStmt.get(Number(payload.sub)) as
        | { id: number; username: string; role: Role; active: number; token_version: number; totp_enabled: number }
        | undefined;
      if (!row || !row.active || row.token_version !== payload.tv) throw new Error('revoked');
      return { id: row.id, username: row.username, role: row.role, totp: !!row.totp_enabled };
    } catch {
      throw new HttpError(401, 'unauthorized');
    }
  }

  const requireUser = async (req: FastifyRequest, _reply: FastifyReply) => {
    req.user = await authenticate(req);
  };
  const requireAdmin = async (req: FastifyRequest, _reply: FastifyReply) => {
    req.user = await authenticate(req);
    if (req.user.role !== 'admin') throw new HttpError(403, 'forbidden');
    // Policy on: admin pages are closed until the admin enables two-step verification (Il mio account stays open).
    if (!req.user.totp && totpRequiredForAdmins()) throw new HttpError(403, 'mfa_setup_required');
  };

  return { issueToken, issueMfaToken, verifyMfaToken, issueFeedToken, verifyFeedToken, totpRequiredForAdmins, authenticate, requireUser, requireAdmin };
}
export type Auth = ReturnType<typeof createAuth>;

/** Sliding-window login limiter per IP+username. */
export function createLoginLimiter(maxAttempts = 10, windowMs = 10 * 60_000) {
  const attempts = new Map<string, { started: number; count: number }>();
  const key = (ip: string, username: string) => `${ip}|${username.toLowerCase()}`;
  return {
    blocked(ip: string, username: string): boolean {
      const k = key(ip, username);
      const x = attempts.get(k);
      if (!x) return false;
      if (Date.now() - x.started > windowMs) {
        attempts.delete(k);
        return false;
      }
      return x.count >= maxAttempts;
    },
    fail(ip: string, username: string): void {
      const k = key(ip, username);
      const x = attempts.get(k) ?? { started: Date.now(), count: 0 };
      x.count++;
      attempts.set(k, x);
      if (attempts.size > 10_000) {
        const cutoff = Date.now() - windowMs;
        for (const [kk, v] of attempts) if (v.started < cutoff) attempts.delete(kk);
      }
    },
    clear(ip: string, username: string): void {
      attempts.delete(key(ip, username));
    },
  };
}
