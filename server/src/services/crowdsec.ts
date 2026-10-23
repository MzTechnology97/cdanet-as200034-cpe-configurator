import { readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../auth.ts';
import { nowIso, recordEvent, type Db } from '../db.ts';
import { addNet, plainIp, trustedNets } from './login-guard.ts';

/**
 * CrowdSec (titolare, 23/10/2026): the CrowdSec engine (optional container, deploy/docker-compose.yml)
 * reads Caddy's access log, recognises scanners, exploit attempts and the like and decides to block
 * their address; it also receives the community blocklist (addresses reported by every CrowdSec
 * user). This app is its bouncer: it reads the decisions from the local API every 10 seconds and
 * answers 403 to the blocked addresses, on every page and API.
 *
 * Never blocked (many installers share one public IP, the mobile operators' CGNAT, and the
 * community list may hold one of them):
 * - the networks never banned by the login guard (private, LOGIN_BAN_IGNORE);
 * - an address with a successful login in the last 30 days;
 * - the exceptions chosen by the admins (an IP or a network, for good or for some days);
 * - a request with a valid session: whoever is logged in keeps working.
 */

export const POLL_MS = 10_000;
const LOGIN_DAYS = 30;
const RECENT_MS = 24 * 3_600_000;
const RECENT_MAX = 500;

export interface Decision {
  id: number;
  origin: string;
  scenario: string;
  scope: string;
  value: string;
  until: number;
}
interface Wire {
  id?: number;
  origin?: string;
  scenario?: string;
  scope?: string;
  value?: string;
  type?: string;
  duration?: string;
}

/** A Go duration ("3h59m58.5s", "167h") in milliseconds; null when it is not one. */
export function goDurationMs(s: string): number | null {
  const m = s.trim().match(/^(-)?((?:\d+(?:\.\d+)?(?:h|ms|m|s|us|µs|ns))+)$/);
  if (!m) return null;
  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 1e-3, µs: 1e-3, ns: 1e-6 };
  let ms = 0;
  for (const p of m[2]!.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) ms += Number(p[1]) * unit[p[2]!]!;
  return m[1] ? -ms : ms;
}

/** Where a decision comes from, as the console says it. */
export function originLabel(origin: string): 'local' | 'community' | 'manual' | 'list' {
  if (origin === 'crowdsec') return 'local';
  if (origin === 'CAPI') return 'community';
  if (origin === 'cscli' || origin === 'console') return 'manual';
  return 'list';
}

export function createCrowdsec(
  db: Db,
  opts: { url: string; apiKey: string; infraDir: string; ignore?: string; version: string; fetchImpl?: typeof fetch; log?: (m: string) => void },
) {
  const doFetch = opts.fetchImpl ?? fetch;
  const trusted = trustedNets(opts.ignore);
  // the decisions in force: by address, and the networks (few: kept in a list)
  const byIp = new Map<string, Decision[]>();
  const ranges: Array<{ d: Decision; list: BlockList }> = [];
  const state = { key: '', lastSync: null as string | null, error: null as string | null, synced: false };
  const recent = new Map<string, { count: number; first: string; last: string; path: string; decision: Decision }>();
  const loginOk = new Map<string, { at: number; ok: boolean }>();

  /** The key of this app at the local API: the updater's file (present while CrowdSec is on). */
  function apiKey(): string {
    if (opts.apiKey) return opts.apiKey;
    try {
      return readFileSync(join(opts.infraDir, 'crowdsec.key'), 'utf8').trim();
    } catch {
      return '';
    }
  }

  const norm = (v: string) => plainIp(v).toLowerCase();
  function add(w: Wire) {
    if (w.type !== 'ban' || !w.value || !w.duration) return;
    const ms = goDurationMs(w.duration);
    if (ms === null || ms <= 0) return;
    const d: Decision = { id: w.id ?? 0, origin: w.origin ?? '', scenario: w.scenario ?? '', scope: (w.scope ?? 'ip').toLowerCase(), value: norm(w.value), until: Date.now() + ms };
    if (d.scope === 'range') {
      const list = new BlockList();
      if (addNet(list, d.value)) ranges.push({ d, list });
      return;
    }
    if (d.scope !== 'ip' || !isIP(d.value)) return;
    const all = (byIp.get(d.value) ?? []).filter((x) => x.id !== d.id || !d.id);
    byIp.set(d.value, [...all, d]);
  }
  function remove(w: Wire) {
    if (!w.value) return;
    const v = norm(w.value);
    const same = (d: Decision) => (w.id ? d.id === w.id : d.origin === w.origin && d.scenario === w.scenario);
    if ((w.scope ?? 'ip').toLowerCase() === 'range') {
      for (let i = ranges.length - 1; i >= 0; i--) if (ranges[i]!.d.value === v && same(ranges[i]!.d)) ranges.splice(i, 1);
      return;
    }
    const left = (byIp.get(v) ?? []).filter((d) => !same(d));
    if (left.length) byIp.set(v, left);
    else byIp.delete(v);
  }

  /** One round with the local API: everything at the first one (and after a new key), then what changed. */
  async function sync(): Promise<void> {
    const key = apiKey();
    if (!key) {
      if (state.key) Object.assign(state, { key: '', synced: false, error: null, lastSync: null });
      byIp.clear();
      ranges.length = 0;
      return;
    }
    const startup = !state.synced || key !== state.key;
    try {
      const r = await doFetch(`${opts.url}/v1/decisions/stream?startup=${startup}`, {
        headers: { 'X-Api-Key': key, 'User-Agent': `cdanet-cpe/${opts.version}` },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 403 || r.status === 401) throw new Error('chiave non accettata da CrowdSec (riavviare il container crowdsec)');
      if (!r.ok) throw new Error(`CrowdSec risponde ${r.status}`);
      const body = (await r.json()) as { new?: Wire[] | null; deleted?: Wire[] | null };
      if (startup) {
        byIp.clear();
        ranges.length = 0;
      }
      for (const w of body.deleted ?? []) remove(w);
      for (const w of body.new ?? []) add(w);
      Object.assign(state, { key, synced: true, error: null, lastSync: nowIso() });
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? 'CrowdSec non risponde' : /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(String((e as Error).message) + String((e as { cause?: Error }).cause?.message ?? '')) ? 'CrowdSec non raggiungibile (container avviato?)' : (e as Error).message;
      if (msg !== state.error) opts.log?.(`crowdsec: ${msg}`);
      // a first round (or a new key) not done: everything again at the next one
      Object.assign(state, { key, error: msg, ...(startup ? { synced: false } : {}) });
    }
  }

  // the exceptions of the admins, kept in memory (checked only for a blocked address)
  let allow = { at: 0, list: new BlockList(), rows: [] as Array<{ id: number; value: string; note: string; createdAt: string; until: string | null; by: string | null }> };
  function allowList() {
    if (Date.now() - allow.at < 60_000) return allow;
    const rows = db
      .prepare('SELECT a.id, a.value, a.note, a.created_at createdAt, a.until, u.username by_ FROM crowdsec_allow a LEFT JOIN users u ON u.id = a.created_by WHERE a.until IS NULL OR a.until > ? ORDER BY a.id DESC')
      .all(nowIso()) as Array<{ id: number; value: string; note: string; createdAt: string; until: string | null; by_: string | null }>;
    const list = new BlockList();
    for (const r of rows) addNet(list, r.value);
    allow = { at: Date.now(), list, rows: rows.map(({ by_, ...r }) => ({ ...r, by: by_ })) };
    return allow;
  }
  const inList = (list: BlockList, ip: string) => list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');

  /** A successful login from [ip] in the last 30 days (cached for 5 minutes). */
  function loggedInFrom(ip: string): boolean {
    const c = loginOk.get(ip);
    if (c && Date.now() - c.at < 300_000) return c.ok;
    const since = new Date(Date.now() - LOGIN_DAYS * 86_400_000).toISOString();
    const ok = !!db.prepare('SELECT 1 FROM login_attempts WHERE ip = ? AND ok = 1 AND created_at > ? LIMIT 1').get(ip, since);
    if (loginOk.size > 5000) loginOk.clear();
    loginOk.set(ip, { at: Date.now(), ok });
    return ok;
  }

  /** The decision in force for an address, if any (ignoring the exceptions). */
  function decisionFor(ip: string): Decision | null {
    const now = Date.now();
    const d = (byIp.get(ip) ?? []).filter((x) => x.until > now).sort((a, b) => b.until - a.until)[0];
    if (d) return d;
    for (const r of ranges) if (r.d.until > now && inList(r.list, ip)) return r.d;
    return null;
  }

  /** Why an address is not blocked although CrowdSec says so: null when it is blocked. */
  function exception(ip: string): 'trusted' | 'allowed' | 'login' | null {
    if (trusted(ip)) return 'trusted';
    if (inList(allowList().list, ip)) return 'allowed';
    if (loggedInFrom(ip)) return 'login';
    return null;
  }

  function note(ip: string, path: string, d: Decision) {
    const now = nowIso();
    const r = recent.get(ip);
    if (r) Object.assign(r, { count: r.count + 1, last: now, path, decision: d });
    else {
      if (recent.size >= RECENT_MAX) recent.delete(recent.keys().next().value!);
      recent.set(ip, { count: 1, first: now, last: now, path, decision: d });
    }
  }

  let timer: NodeJS.Timeout | null = null;
  const svc = {
    sync,
    start() {
      if (timer) return;
      void sync();
      timer = setInterval(() => void sync(), POLL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    /**
     * Before every request: the decision that blocks it, or null. [session] tells whether the
     * request carries a valid session (asked only for a blocked address: it costs a token check).
     */
    async blocked(req: FastifyRequest, session: () => Promise<boolean>): Promise<Decision | null> {
      if (!byIp.size && !ranges.length) return null;
      const ip = norm(req.ip);
      const d = decisionFor(ip);
      if (!d || exception(ip)) return null;
      if (req.headers.authorization && (await session())) return null;
      note(ip, req.url.split('?')[0]!.slice(0, 120), d);
      return d;
    },

    /** Console: an address checked by hand (is it blocked, and why). */
    check(value: string) {
      const ip = norm(value.trim());
      if (!isIP(ip)) throw new HttpError(400, 'invalid_ip');
      const d = decisionFor(ip);
      const ex = exception(ip);
      return { ip, blocked: !!d && !ex, decision: d ? view(d) : null, exception: ex };
    },

    /** Console: the state, the counts, the local decisions and the blocked requests of the last 24 hours. */
    status() {
      const now = Date.now();
      const counts = { local: 0, community: 0, manual: 0, list: 0 };
      const local: Decision[] = [];
      const seen = new Set<string>();
      for (const all of byIp.values())
        for (const d of all) {
          if (d.until <= now) continue;
          const o = originLabel(d.origin);
          if (seen.has(`${o}|${d.value}`)) continue;
          seen.add(`${o}|${d.value}`);
          counts[o]++;
          if (o === 'local' || o === 'manual') local.push(d);
        }
      for (const r of ranges)
        if (r.d.until > now) {
          const o = originLabel(r.d.origin);
          counts[o]++;
          if (o === 'local' || o === 'manual') local.push(r.d);
        }
      for (const [ip, r] of recent) if (now - Date.parse(r.last) > RECENT_MS) recent.delete(ip);
      const key = apiKey();
      return {
        enabled: !!key,
        connected: !!key && state.synced && !state.error,
        lastSync: state.lastSync,
        error: key ? state.error : null,
        counts,
        local: local.sort((a, b) => b.until - a.until).slice(0, 300).map(view),
        blocked: [...recent.entries()]
          .map(([ip, r]) => ({ ip, count: r.count, first: r.first, last: r.last, path: r.path, decision: view(r.decision), exception: exception(ip) }))
          .sort((a, b) => b.last.localeCompare(a.last)),
        allow: allowList().rows,
      };
    },

    allowAdd(input: { value: string; note?: string | undefined; days?: number | undefined }, by: number) {
      const value = input.value.trim().toLowerCase();
      if (!addNet(new BlockList(), value)) throw new HttpError(400, 'invalid_ip');
      const until = input.days ? new Date(Date.now() + input.days * 86_400_000).toISOString() : null;
      const r = db.prepare('INSERT INTO crowdsec_allow(value, note, created_at, created_by, until) VALUES(?,?,?,?,?)').run(value, input.note ?? '', nowIso(), by, until);
      allow.at = 0;
      recordEvent(db, by, 'security.crowdsec_allow', value, `${input.note ? `${input.note} · ` : ''}${until ? `fino al ${until.slice(0, 10)}` : 'sempre'}`);
      return { id: Number(r.lastInsertRowid) };
    },

    allowRemove(id: number, by: number) {
      const row = db.prepare('SELECT value FROM crowdsec_allow WHERE id = ?').get(id) as { value: string } | undefined;
      if (!row) throw new HttpError(404, 'not_found');
      db.prepare('DELETE FROM crowdsec_allow WHERE id = ?').run(id);
      allow.at = 0;
      recordEvent(db, by, 'security.crowdsec_allow_remove', row.value, '');
    },
  };
  const view = (d: Decision) => ({ value: d.value, scope: d.scope, origin: originLabel(d.origin), scenario: d.scenario, until: new Date(d.until).toISOString() });
  return svc;
}
export type Crowdsec = ReturnType<typeof createCrowdsec>;
