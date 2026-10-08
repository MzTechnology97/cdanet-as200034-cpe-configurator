import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import type { Db } from './db.ts';

export type Role = 'admin' | 'installer';

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
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

  const userStmt = db.prepare('SELECT id, username, role, active, token_version FROM users WHERE id = ?');

  /** Verifies the bearer token and re-checks the account on every request (disable/reset revoke immediately). */
  async function authenticate(req: FastifyRequest): Promise<AuthUser> {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) throw new HttpError(401, 'unauthorized');
    try {
      const { payload } = await jwtVerify(m[1] as string, secret, { issuer: ISSUER, algorithms: ['HS256'] });
      const row = userStmt.get(Number(payload.sub)) as
        | { id: number; username: string; role: Role; active: number; token_version: number }
        | undefined;
      if (!row || !row.active || row.token_version !== payload.tv) throw new Error('revoked');
      return { id: row.id, username: row.username, role: row.role };
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
  };

  return { issueToken, authenticate, requireUser, requireAdmin };
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
