import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, seesAll } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { parseMac } from '../domain/policy.ts';

/**
 * Speedtest of the app (acceptance test, replacements and interventions on installed CPEs, the
 * network tools): the settings it runs with, the speed the customer's profile promises and every
 * result. The app measures against the OoklaServer of the settings, only over the Wi-Fi of the
 * customer's router (never mobile data), and is stopped when the phone is too far from the router.
 */

/** «CDA-NET-HOME-25-5», «ISP37@CDA-NET-B2B-100-100-NEW», «CDA NET HOME 25/5» → 25 / 5 Mbit/s. */
export function profileSpeed(profile: string): { downMbps: number; upMbps: number } | null {
  const name = profile.trim().replace(/^[^@]*@/, '');
  const m = /(\d+(?:[.,]\d+)?)\s*[-/xX]\s*(\d+(?:[.,]\d+)?)(?:\s*(?:M|Mb|Mbps|Mbit\/s))?(?:-NEW)?\s*$/i.exec(name);
  if (!m) return null;
  const downMbps = Number(m[1]!.replace(',', '.'));
  const upMbps = Number(m[2]!.replace(',', '.'));
  return downMbps > 0 && upMbps > 0 && downMbps <= 10_000 && upMbps <= 10_000 ? { downMbps, upMbps } : null;
}

const CONTEXTS = ['acceptance', 'work_order', 'cpe', 'tool'] as const;
const mbps = z.number().min(0).max(100_000);

const resultBody = z
  .object({
    /** Made by the phone: the same result sent again (offline queue, retry) is kept once. */
    id: z.string().uuid().optional(),
    /** When the phone measured it (results sent later from the offline queue). */
    at: z.string().datetime().optional(),
    context: z.enum(CONTEXTS),
    jobId: z.string().uuid().optional(),
    workOrderId: z.number().int().positive().optional(),
    mac: z.string().max(40).optional(),
    downMbps: mbps.nullable(),
    upMbps: mbps.nullable(),
    pingMs: z.number().min(0).max(60_000).nullable().default(null),
    jitterMs: z.number().min(0).max(60_000).nullable().default(null),
    server: z.string().max(260).default(''),
    wifi: z
      .object({
        ssid: z.string().max(64).optional(),
        bssid: z.string().max(40).optional(),
        rssi: z.number().int().min(-127).max(0).optional(),
        band: z.enum(['2.4', '5', '6']).optional(),
        channel: z.number().int().min(1).max(233).optional(),
        widthMhz: z.number().int().min(5).max(320).optional(),
        linkMbps: z.number().min(0).max(50_000).optional(),
        neighborsSameChannel: z.number().int().min(0).max(500).optional(),
        neighborsOverlapping: z.number().int().min(0).max(500).optional(),
        suggestedChannel: z.number().int().min(1).max(233).optional(),
      })
      .strict()
      .default({}),
    attempt: z.number().int().min(1).max(1000).default(1),
  })
  .strict();

export function speedtestRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const user = { preHandler: [ctx.auth.requireUser] };

  /** What the app needs to run the test: server, duration, streams and the thresholds. */
  app.get('/api/speedtest/config', user, async () => {
    const s = ctx.cfg.speedtest;
    const [host, port] = s.server.includes(':') ? [s.server.slice(0, s.server.lastIndexOf(':')), Number(s.server.slice(s.server.lastIndexOf(':') + 1))] : [s.server, 8080];
    return { host, port: port || 8080, seconds: s.seconds, streams: s.streams, minPct: s.minPct, wifiWarnDbm: s.wifiWarnDbm, wifiBlockDbm: s.wifiBlockDbm };
  });

  /**
   * The CPE a request is about, checked like the other job data: an installer only for their own
   * installations, the CPEs assigned to them and the work orders assigned to them.
   */
  const subject = (req: FastifyRequest, q: { jobId?: string; mac?: string; workOrderId?: number }) => {
    const admin = seesAll(req.user);
    const me = req.user!.id;
    let mac = q.mac ? parseMac(q.mac) : null;
    if (q.mac && !mac) throw new HttpError(400, 'invalid_mac');
    let pppoeUser = '';
    if (q.jobId) {
      const j = db.prepare('SELECT user_id, mac, pppoe_user FROM provisioning_jobs WHERE id = ?').get(q.jobId) as { user_id: number; mac: string; pppoe_user: string } | undefined;
      if (!j) throw new HttpError(404, 'job_not_found');
      const assigned = () => !!db.prepare('SELECT 1 FROM cpe_assignments WHERE mac = ? AND user_id = ?').get(j.mac, me);
      if (!admin && j.user_id !== me && !assigned()) throw new HttpError(403, 'forbidden');
      mac = mac ?? (j.mac || null);
      pppoeUser = j.pppoe_user;
    }
    if (q.workOrderId) {
      const o = db.prepare('SELECT assigned_to, pppoe_user FROM work_orders WHERE id = ?').get(q.workOrderId) as { assigned_to: number | null; pppoe_user: string } | undefined;
      if (!o) throw new HttpError(404, 'work_order_not_found');
      if (!admin && o.assigned_to !== me) throw new HttpError(403, 'forbidden');
      pppoeUser = pppoeUser || o.pppoe_user;
    }
    if (mac && !q.jobId && !admin) {
      const mine =
        db.prepare('SELECT 1 FROM provisioning_jobs WHERE mac = ? AND user_id = ? LIMIT 1').get(mac, me) ||
        db.prepare('SELECT 1 FROM cpe_assignments WHERE mac = ? AND user_id = ?').get(mac, me);
      if (!mine) throw new HttpError(403, 'forbidden');
    }
    // only the MAC (replacements, the network tools): the customer of the latest installation of that
    // CPE. The MAC of the RADIUS session is not enough: empty while offline, or another device's.
    if (mac && !pppoeUser) {
      const last = db.prepare("SELECT pppoe_user FROM provisioning_jobs WHERE mac = ? AND pppoe_user <> '' ORDER BY created_at DESC LIMIT 1").get(mac) as { pppoe_user: string } | undefined;
      pppoeUser = last?.pppoe_user ?? '';
    }
    return { mac: mac ?? '', pppoeUser };
  };

  /** The speed promised by the customer's PPPoE profile (RADIUS state copied from the CRM). */
  const targetOf = (s: { mac: string; pppoeUser: string }) => {
    const row = (s.pppoeUser && db.prepare('SELECT profile FROM crm_radius WHERE username = ? COLLATE NOCASE').get(s.pppoeUser)) || (s.mac && db.prepare('SELECT profile FROM crm_radius WHERE mac = ? COLLATE NOCASE').get(s.mac));
    const profile = (row as { profile?: string } | undefined)?.profile ?? '';
    const speed = profile ? profileSpeed(profile) : null;
    return speed ? { profile: profile.replace(/^[^@]*@/, ''), ...speed, minPct: ctx.cfg.speedtest.minPct } : null;
  };

  /** Target of a CPE: by job, work order or MAC. null when its profile is not known (no comparison). */
  app.get('/api/speedtest/target', user, async (req) => {
    const q = z.object({ jobId: z.string().uuid().optional(), mac: z.string().max(40).optional(), workOrderId: z.coerce.number().int().positive().optional() }).parse(req.query);
    if (!q.jobId && !q.mac && !q.workOrderId) throw new HttpError(400, 'invalid_request');
    return { target: targetOf(subject(req, q)) };
  });

  /** One result. The server compares it with the profile itself (the app's own verdict is not trusted). */
  app.post('/api/speedtests', user, async (req, reply) => {
    const b = resultBody.parse(req.body);
    if (b.id) {
      const seen = db.prepare('SELECT id, passed, target FROM speed_tests WHERE client_id = ?').get(b.id) as { id: number; passed: number | null; target: string | null } | undefined;
      if (seen) return reply.code(200).send({ id: seen.id, passed: seen.passed === null ? null : !!seen.passed, target: seen.target ? JSON.parse(seen.target) : null });
    }
    const s = b.jobId || b.mac || b.workOrderId ? subject(req, b) : { mac: '', pppoeUser: '' };
    const target = targetOf(s);
    const passed =
      target && b.downMbps != null && b.upMbps != null ? b.downMbps >= (target.downMbps * target.minPct) / 100 && b.upMbps >= (target.upMbps * target.minPct) / 100 : null;
    const r = db
      .prepare(
        `INSERT INTO speed_tests(created_at, measured_at, client_id, user_id, context, job_id, work_order_id, mac, pppoe_user, down_mbps, up_mbps, ping_ms, jitter_ms, server, wifi, target, passed, attempt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        nowIso(),
        b.at ?? nowIso(),
        b.id ?? null,
        req.user!.id,
        b.context,
        b.jobId ?? null,
        b.workOrderId ?? null,
        s.mac,
        s.pppoeUser,
        b.downMbps,
        b.upMbps,
        b.pingMs,
        b.jitterMs,
        b.server,
        JSON.stringify(b.wifi),
        target ? JSON.stringify(target) : null,
        passed === null ? null : passed ? 1 : 0,
        b.attempt,
      );
    recordEvent(
      db,
      req.user!.id,
      'speedtest',
      s.mac || b.context,
      `${b.downMbps ?? '—'}/${b.upMbps ?? '—'} Mbit/s${target ? ` su ${target.downMbps}/${target.upMbps} (${passed ? 'ok' : 'sotto soglia'})` : ''} · tentativo ${b.attempt}`,
    );
    return reply.code(201).send({ id: Number(r.lastInsertRowid), passed, target });
  });

  /** The results of a CPE (by job or MAC), newest first. */
  app.get('/api/speedtests', user, async (req) => {
    const q = z.object({ jobId: z.string().uuid().optional(), mac: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    if (!q.jobId && !q.mac) throw new HttpError(400, 'invalid_request');
    const s = subject(req, q);
    const rows = db
      .prepare(
        `SELECT t.id, t.measured_at at, t.context, t.job_id jobId, t.work_order_id workOrderId, t.mac, t.down_mbps downMbps, t.up_mbps upMbps, t.ping_ms pingMs, t.jitter_ms jitterMs,
                t.server, t.wifi, t.target, t.passed, t.attempt, u.username
           FROM speed_tests t LEFT JOIN users u ON u.id = t.user_id
          WHERE ${q.jobId ? 't.job_id = ?' : 't.mac = ?'} ORDER BY t.measured_at DESC LIMIT ?`,
      )
      .all(q.jobId ?? s.mac, q.limit) as Array<Record<string, unknown> & { wifi: string; target: string | null; passed: number | null }>;
    return {
      items: rows.map((r) => ({ ...r, wifi: JSON.parse(r.wifi), target: r.target ? JSON.parse(r.target) : null, passed: r.passed === null ? null : !!r.passed })),
    };
  });
}
