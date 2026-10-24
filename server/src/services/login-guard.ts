import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../auth.ts';
import type { Db } from '../db.ts';
import { nowIso, recordEvent } from '../db.ts';

/**
 * Like fail2ban for the platform's own logins (password, second step, quick login, consent of a
 * Claude connection): every attempt is logged; 5 failed in 15 minutes from one IP or one device
 * ban it for 30 minutes (24 hours if it was banned already in the last day).
 *
 * - An IP ban stops logins and requests without a valid session only: many installers share one
 *   public IP (mobile operators' CGNAT), and those already logged in keep working.
 * - A device ban (X-CDA-Device, a UUID chosen by the app) stops everything from that device. The
 *   id is the client's own: it stops an app or a PC failing in a loop, not an attacker, who can
 *   change it at every try (the IP ban is the one that counts against brute force).
 * - Never banned by IP: loopback, the private networks (the containers, the trusted LANs) and
 *   LOGIN_BAN_IGNORE; for them, the old limit of 10 attempts per username in 10 minutes stays.
 */

export const FAILS_TO_BAN = 5;
export const FAIL_WINDOW_MS = 15 * 60_000;
export const BAN_MS = 30 * 60_000;
export const REPEAT_BAN_MS = 24 * 3_600_000;
const USER_LIMIT = 10;
const USER_WINDOW_MS = 10 * 60_000;
const KEEP_DAYS = 90;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LoginKind = 'password' | 'totp' | 'quick' | 'oauth';
export type BanKind = 'ip' | 'device';

/** The device id of the request (a UUID from X-CDA-Device), null when absent or not a UUID. */
export function deviceOf(req: FastifyRequest): string | null {
  const v = req.headers['x-cda-device'];
  const s = Array.isArray(v) ? v[0] : v;
  return s && UUID.test(s) ? s.toLowerCase() : null;
}

/** Where the attempt came from: the app (its client header), Claude (OAuth), or a browser. */
function channelOf(req: FastifyRequest): string {
  if (req.url.startsWith('/oauth/')) return 'claude';
  return req.headers['x-cda-client'] ? 'app' : 'web';
}

/** An IPv4 address seen through an IPv6 socket (::ffff:a.b.c.d) as plain IPv4. */
export const plainIp = (ip: string) => ip.replace(/^::ffff:/, '');

/** Adds an address or a network (a.b.c.d/nn, ipv6/nn) to [list]; false when it is not one. */
export function addNet(list: BlockList, item: string): boolean {
  const [addr, bits, more] = item.trim().split('/');
  const fam = isIP(addr ?? '');
  if (!fam || more !== undefined) return false;
  const type = fam === 6 ? 'ipv6' : 'ipv4';
  if (bits === undefined) {
    list.addAddress(addr!, type);
    return true;
  }
  const n = Number(bits);
  if (!/^\d{1,3}$/.test(bits) || n > (fam === 6 ? 128 : 32)) return false;
  list.addSubnet(addr!, n, type);
  return true;
}

/**
 * The networks never banned by IP: loopback, the private networks (the containers, the trusted
 * LANs) and LOGIN_BAN_IGNORE. Also those that CrowdSec never blocks (services/crowdsec.ts).
 */
export function trustedNets(ignore = ''): (ip: string) => boolean {
  const exempt = new BlockList();
  exempt.addSubnet('127.0.0.0', 8);
  exempt.addAddress('::1', 'ipv6');
  for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]] as const) exempt.addSubnet(net, bits);
  exempt.addSubnet('fc00::', 7, 'ipv6');
  for (const item of ignore.split(/[\s,]+/).filter(Boolean)) addNet(exempt, item);
  return (ip: string) => {
    const p = plainIp(ip);
    const fam = isIP(p);
    return !fam || exempt.check(p, fam === 6 ? 'ipv6' : 'ipv4');
  };
}

export function createLoginGuard(db: Db, opts: { ignore?: string; notify?: (html: string) => void } = {}) {
  const ipExempt = trustedNets(opts.ignore);

  // the bans in force, kept in memory (checked on every request)
  const active = new Map<string, { id: number; until: string }>();
  const key = (kind: BanKind, value: string) => `${kind}|${value}`;
  function load() {
    active.clear();
    const rows = db.prepare('SELECT id, kind, value, until FROM login_bans WHERE lifted_at IS NULL AND until > ?').all(nowIso()) as Array<{ id: number; kind: BanKind; value: string; until: string }>;
    for (const r of rows) active.set(key(r.kind, r.value), { id: r.id, until: r.until });
  }
  load();

  function banUntil(kind: BanKind, value: string): string | null {
    const b = active.get(key(kind, value));
    if (!b) return null;
    if (b.until <= nowIso()) {
      active.delete(key(kind, value));
      return null;
    }
    return b.until;
  }

  /** The ban in force for this request, if any: by device always, by IP unless exempt. */
  function bannedFor(req: FastifyRequest): { kind: BanKind; until: string } | null {
    const dev = deviceOf(req);
    const d = dev ? banUntil('device', dev) : null;
    if (d) return { kind: 'device', until: d };
    const ip = plainIp(req.ip);
    if (ipExempt(ip)) return null;
    const i = banUntil('ip', ip);
    return i ? { kind: 'ip', until: i } : null;
  }

  function ban(kind: BanKind, value: string, attempts: number) {
    const since = new Date(Date.now() - REPEAT_BAN_MS).toISOString();
    // a ban lifted from the console does not count: whoever lifted it trusts it, it starts again
    const before = (db.prepare('SELECT count(*) n FROM login_bans WHERE kind = ? AND value = ? AND created_at > ? AND lifted_at IS NULL').get(kind, value, since) as { n: number }).n;
    const until = new Date(Date.now() + (before ? REPEAT_BAN_MS : BAN_MS)).toISOString();
    const reason = `${attempts} tentativi falliti in ${FAIL_WINDOW_MS / 60_000} minuti${before ? ', di nuovo nelle 24 ore' : ''}`;
    const r = db.prepare('INSERT INTO login_bans(kind, value, created_at, until, attempts, reason) VALUES(?,?,?,?,?,?)').run(kind, value, nowIso(), until, attempts, reason);
    active.set(key(kind, value), { id: Number(r.lastInsertRowid), until });
    recordEvent(db, null, 'auth.ban', kind === 'ip' ? value : `dispositivo ${value.slice(0, 8)}…`, `${reason}: bloccato fino alle ${until.slice(11, 16)} UTC${kind === 'device' ? ' (id scelto dal dispositivo: non ferma un attaccante)' : ''}`);
    opts.notify?.(`Accesso bloccato per ${kind === 'ip' ? `l'IP <b>${value}</b>` : `il dispositivo <b>${value.slice(0, 8)}…</b>`}: ${reason}, per ${before ? '24 ore' : '30 minuti'}.`);
  }

  /** Failures since the last ban of that IP/device, within the window. */
  function failures(column: 'ip' | 'device', value: string, kind: BanKind): number {
    const lastBan = (db.prepare('SELECT MAX(created_at) t FROM login_bans WHERE kind = ? AND value = ?').get(kind, value) as { t: string | null }).t ?? '';
    const from = new Date(Date.now() - FAIL_WINDOW_MS).toISOString();
    return (db.prepare(`SELECT count(*) n FROM login_attempts WHERE ok = 0 AND ${column} = ? AND created_at > ? AND created_at > ?`).get(value, from, lastBan) as { n: number }).n;
  }

  let purged = 0;
  return {
    /**
     * Before checking a login: throws while banned (429 «banned») or past the old per-username
     * limit (429 «too_many_attempts», for the exempt networks).
     */
    check(req: FastifyRequest, username: string) {
      const b = bannedFor(req);
      if (b) throw new HttpError(429, 'banned', { until: b.until });
      // the networks never banned by IP keep the old limit per username; the others have the ban
      if (!ipExempt(plainIp(req.ip))) return;
      const from = new Date(Date.now() - USER_WINDOW_MS).toISOString();
      const n = (db.prepare('SELECT count(*) n FROM login_attempts WHERE ok = 0 AND ip = ? AND username = ? AND created_at > ?').get(plainIp(req.ip), username.toLowerCase(), from) as { n: number }).n;
      if (n >= USER_LIMIT) throw new HttpError(429, 'too_many_attempts');
    },

    /** An attempt, logged; a failure may ban its IP and its device. */
    record(req: FastifyRequest, username: string, kind: LoginKind, ok: boolean, reason = '') {
      const ip = plainIp(req.ip);
      const dev = deviceOf(req);
      db.prepare('INSERT INTO login_attempts(created_at, ip, device, username, channel, kind, ok, reason) VALUES(?,?,?,?,?,?,?,?)').run(
        nowIso(),
        ip,
        dev,
        username.toLowerCase().slice(0, 80),
        channelOf(req),
        kind,
        ok ? 1 : 0,
        reason.slice(0, 80),
      );
      if (Date.now() - purged > 3_600_000) {
        purged = Date.now();
        db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString());
      }
      if (ok) return;
      if (!ipExempt(ip) && !banUntil('ip', ip)) {
        const n = failures('ip', ip, 'ip');
        if (n >= FAILS_TO_BAN) ban('ip', ip, n);
      }
      if (dev && !banUntil('device', dev)) {
        const n = failures('device', dev, 'device');
        if (n >= FAILS_TO_BAN) ban('device', dev, n);
      }
    },

    bannedFor,

    /** The bans in force read again from the database (after a change made outside, and in tests). */
    reload: load,

    /** Console: the bans (in force first) with the usernames tried and the last attempt. */
    list(limit = 200) {
      const now = nowIso();
      const rows = db
        .prepare('SELECT id, kind, value, created_at createdAt, until, attempts, reason, lifted_at liftedAt FROM login_bans ORDER BY (lifted_at IS NULL AND until > ?) DESC, created_at DESC LIMIT ?')
        .all(now, limit) as Array<{ id: number; kind: BanKind; value: string; createdAt: string; until: string; attempts: number; reason: string; liftedAt: string | null }>;
      return rows.map((r) => {
        const col = r.kind === 'ip' ? 'ip' : 'device';
        const last = db.prepare(`SELECT MAX(created_at) t FROM login_attempts WHERE ${col} = ?`).get(r.value) as { t: string | null };
        const users = db
          .prepare(`SELECT username, MAX(created_at) t FROM login_attempts WHERE ${col} = ? AND ok = 0 AND username != '' GROUP BY username ORDER BY t DESC LIMIT 5`)
          .all(r.value) as Array<{ username: string }>;
        return { ...r, lastAttemptAt: last.t, usernames: users.map((u) => u.username), active: !r.liftedAt && r.until > now, expired: !r.liftedAt && r.until <= now };
      });
    },

    /** Console: the attempts log (newest first), optionally only the failed ones. */
    attempts(q: { limit: number; failed?: boolean; ip?: string; username?: string }) {
      const where = ['1 = 1'];
      const args: Array<string | number> = [];
      if (q.failed) where.push('ok = 0');
      if (q.ip) {
        where.push('ip = ?');
        args.push(q.ip);
      }
      if (q.username) {
        where.push('username = ?');
        args.push(q.username.toLowerCase());
      }
      return db
        .prepare(`SELECT id, created_at createdAt, ip, device, username, channel, kind, ok, reason FROM login_attempts WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
        .all(...args, q.limit)
        .map((r) => ({ ...(r as Record<string, unknown>), ok: !!(r as { ok: number }).ok }));
    },

    /** Console: ends a ban now. */
    lift(id: number, by: number): boolean {
      const row = db.prepare('SELECT kind, value FROM login_bans WHERE id = ? AND lifted_at IS NULL').get(id) as { kind: BanKind; value: string } | undefined;
      if (!row) return false;
      db.prepare('UPDATE login_bans SET lifted_at = ?, lifted_by = ? WHERE id = ?').run(nowIso(), by, id);
      active.delete(key(row.kind, row.value));
      recordEvent(db, by, 'auth.unban', row.kind === 'ip' ? row.value : `dispositivo ${row.value.slice(0, 8)}…`, 'sbloccato dalla console');
      return true;
    },
  };
}
export type LoginGuard = ReturnType<typeof createLoginGuard>;
