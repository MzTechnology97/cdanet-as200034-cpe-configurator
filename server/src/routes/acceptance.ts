import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { REPOINT_GRANT_HOURS } from '../domain/policy.ts';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { distanceM } from '../domain/geo.ts';
import { photoDir } from '../services/photos.ts';
import { acceptanceReportPdf } from '../services/acceptance-report.ts';
import { FIELD_THRESHOLDS } from './field.ts';
import { resolveKoByAcceptance } from './ko.ts';

const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

const num = z.number().finite().nullable().optional();
const verdict = z.enum(['ok', 'warn', 'bad']);

/** Acceptance test (collaudo) sent by the app at the end of an installation. */
export const acceptanceSchema = z
  .object({
    verdict,
    measuredAt: z.string().datetime(),
    samples: z.number().int().min(1).max(600).default(1),
    cpe: z
      .object({
        hostname: z.string().max(100).nullable().optional(),
        model: z.string().max(100).nullable().optional(),
        firmware: z.string().max(100).nullable().optional(),
        apName: z.string().max(100).nullable().optional(),
        apMac: z.string().max(40).nullable().optional(),
        essid: z.string().max(64).nullable().optional(),
        distanceM: num,
        frequencyMhz: num,
        channelWidthMhz: num,
      })
      .strict(),
    radio: z
      .object({
        signal: num,
        signalMin: num,
        signalMax: num,
        noise: num,
        chains: z.array(z.number().finite()).max(4).default([]),
        remoteSignal: num,
        expectedSignal: num,
        cinrRx: num,
        cinrTx: num,
        dlCapacityMbps: num,
        ulCapacityMbps: num,
      })
      .strict(),
    lan: z.object({ plugged: z.boolean().nullable().optional(), speedMbps: num, fullDuplex: z.boolean().nullable().optional(), cableLenM: num }).strict().optional(),
    pppoe: z.object({ enabled: z.boolean().nullable().optional(), ip: z.string().max(64).nullable().optional() }).strict().optional(),
    internet: z
      .object({
        tested: z.boolean(),
        pingMs: num,
        jitterMs: num,
        downloadMbps: num,
        uploadMbps: num,
        note: z.string().max(300).optional(),
      })
      .strict(),
    checks: z.array(z.object({ title: z.string().max(80), verdict: z.enum(['ok', 'warn', 'bad', 'info']), detail: z.string().max(400) }).strict()).max(30),
    notes: z.string().max(1000).default(''),
    // phone GPS when the test is saved: checked against the work order's position (older apps: none)
    position: z.object({ lat: z.number(), lon: z.number(), accuracyM: z.number().min(0).max(100_000).nullable().optional() }).strict().optional(),
    // height of the CPE above the ground, typed by the technician (older apps do not send it)
    cpeHeightM: z.number().min(0.5).max(100).nullable().optional(),
    // a re-pointing or AP change: a new test, the earlier one kept in the history (older apps: install)
    kind: z.enum(['install', 'repoint']).default('install'),
    // one test sent twice (offline queue, retry) is the same test, never a second history entry
    testId: z.string().uuid().optional(),
    // the work order of a re-pointing (none: one is made, already done)
    workOrderId: z.number().int().positive().optional(),
    // the speedtest of the acceptance (the last one, against the OoklaServer, over the customer's Wi-Fi)
    speedtest: z
      .object({
        downMbps: num,
        upMbps: num,
        pingMs: num,
        jitterMs: num,
        server: z.string().max(260).optional(),
        attempts: z.number().int().min(1).max(1000).default(1),
        target: z.object({ profile: z.string().max(120), downMbps: z.number(), upMbps: z.number(), minPct: z.number() }).strict().nullable().optional(),
        passed: z.boolean().nullable().optional(),
      })
      .strict()
      .optional(),
    // the Wi-Fi of the customer's router as the phone saw it (and what the technician changed)
    wifi: z
      .object({
        ssid: z.string().max(64).optional(),
        rssi: num,
        band: z.enum(['2.4', '5', '6']).optional(),
        channel: num,
        widthMhz: num,
        linkMbps: num,
        neighborsSameChannel: num,
        neighborsOverlapping: num,
        congested: z.boolean().optional(),
        suggestedChannel: num,
        changed: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Radio checks of the app: a red one means a poor link the NOC has to accept. */
const RADIO_CHECKS = new Set(['Segnale ricevuto', 'Segnale lato AP', 'CINR (qualità)', 'Capacità airMAX', 'Catene (polarizzazioni)', "Collegamento all'AP"]);

/** Why the acceptance test needs the NOC's approval ('' = it does not). */

/** The kinds of photo of an acceptance test, and the ones each test needs. */
export const PHOTO_TYPES = ['antenna', 'bracket', 'cabling', 'router', 'other'] as const;
export const PHOTO_LABEL: Record<string, string> = { antenna: 'Antenna', bracket: 'Staffa', cabling: 'Cablaggio', router: 'Router', other: '' };
/** Only new installations: re-pointings and replacements need none (the owner's choice). */
export const REQUIRED_PHOTOS: Record<string, string[]> = { install: ['antenna', 'bracket', 'cabling', 'router'] };

export function poorRadio(a: z.infer<typeof acceptanceSchema>, signalMin: number = FIELD_THRESHOLDS.signalMin): string {
  const why: string[] = [];
  if (a.radio.signal != null && a.radio.signal < signalMin) why.push(`segnale ${a.radio.signal} dBm (minimo ${signalMin})`);
  for (const c of a.checks) if (c.verdict === 'bad' && RADIO_CHECKS.has(c.title) && !(c.title === 'Segnale ricevuto' && why.length)) why.push(`${c.title}: ${c.detail}`);
  return why.join(' · ').slice(0, 500);
}

interface JobRow {
  id: string;
  user_id: number;
  status: string;
  mac: string;
  work_order_id: number | null;
}

/** Same limit as the app: farther than this from the work order, the acceptance test is refused. */
export const ACCEPTANCE_MAX_M = 500;

export function acceptanceRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('acceptance')] };
  const { db } = ctx;
  const root = ctx.cfg.photosDir;

  app.addContentTypeParser(['image/jpeg'], { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES }, (_req, body, done) => done(null, body));

  const loadJob = (req: FastifyRequest) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const job = db.prepare('SELECT id, user_id, status, mac, work_order_id FROM provisioning_jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (!job) throw new HttpError(404, 'job_not_found');
    // installers: their own installations and the CPEs assigned to them (re-pointing, maintenance)
    const assigned = () => !!db.prepare('SELECT 1 FROM cpe_assignments WHERE mac = ? AND user_id = ?').get(job.mac, req.user!.id);
    // a technician who re-pointed this CPE (installed by someone else): its tests and photos
    const granted = () =>
      !!db
        .prepare('SELECT 1 FROM repoint_grants WHERE job_id = ? AND user_id = ? AND granted_at >= ?')
        .get(job.id, req.user!.id, new Date(Date.now() - REPOINT_GRANT_HOURS * 3_600_000).toISOString());
    if (job.user_id !== req.user!.id && req.user!.role !== 'admin' && !assigned() && !granted()) throw new HttpError(403, 'forbidden');
    return job;
  };

  /**
   * The work order of a re-pointing: the technician's own order it came from is closed; without
   * one, a «Ripuntamento» order is made for the record, already done (calendar, Interventi).
   */
  const repointOrder = (jobId: string, u: { id: number; role: string }, fromOrder: number | null): number => {
    const now = nowIso();
    if (fromOrder) {
      const o = db.prepare('SELECT id, assigned_to FROM work_orders WHERE id = ?').get(fromOrder) as { id: number; assigned_to: number | null } | undefined;
      if (o && (o.assigned_to === u.id || u.role === 'admin')) {
        db.prepare("UPDATE work_orders SET status = 'done', done_at = COALESCE(done_at, ?), job_id = COALESCE(job_id, ?), updated_at = ? WHERE id = ?").run(now, jobId, now, o.id);
        return o.id;
      }
    }
    const j = db
      .prepare(
        `SELECT j.device_name, j.pppoe_user, j.model, j.latitude, j.longitude, w.address, w.contact
           FROM provisioning_jobs j LEFT JOIN work_orders w ON w.id = j.work_order_id WHERE j.id = ?`,
      )
      .get(jobId) as { device_name: string; pppoe_user: string; model: string; latitude: number | null; longitude: number | null; address: string | null; contact: string | null };
    const day = now.slice(0, 10);
    const r = db
      .prepare(
        `INSERT INTO work_orders(created_at, created_by, updated_at, assigned_to, day, slot, kind, customer, address, lat, lon, contact, pppoe_user, model, notes, status, job_id, done_at, location_from)
         VALUES(?,?,?,?,?,'','repoint',?,?,?,?,?,?,?,?,'done',?,?,?)`,
      )
      .run(now, u.id, now, u.id, day, j.device_name || j.pppoe_user || 'CPE', j.address ?? '', j.latitude, j.longitude, j.contact ?? '', j.pppoe_user, j.model, 'Ripuntamento senza intervento: creato dal collaudo.', jobId, now, j.latitude != null ? 'office' : '');
    return Number(r.lastInsertRowid);
  };

  const photos = (jobId: string) =>
    db.prepare('SELECT id, created_at createdAt, caption, size, type FROM job_photos WHERE job_id = ? AND history_id IS NULL ORDER BY id').all(jobId);
  /**
   * The required photos the current test still lacks: only a new installation needs them (not a
   * re-pointing, not the replacement of a CPE). The queue of the phone may send them after the
   * test: a test is never refused for them, the NOC and the report see what is missing.
   */
  const photosMissing = (jobId: string, kind: string) => {
    const replaces = (db.prepare('SELECT replaces_job_id r FROM provisioning_jobs WHERE id = ?').get(jobId) as { r: string | null } | undefined)?.r;
    const need = kind === 'install' && !replaces ? REQUIRED_PHOTOS.install! : [];
    if (!need.length) return [];
    const have = new Set((db.prepare('SELECT DISTINCT type FROM job_photos WHERE job_id = ? AND history_id IS NULL').all(jobId) as Array<{ type: string }>).map((r) => r.type));
    return need.filter((t) => !have.has(t));
  };

  app.get('/api/provisioning/jobs/:id/acceptance', user, async (req) => {
    const job = loadJob(req);
    const row = db
      .prepare(
        `SELECT a.created_at, a.verdict, a.data, a.kind, u.username, a.review, a.review_reason, a.review_at, a.review_note, r.username reviewer
           FROM job_acceptance a JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.review_by WHERE a.job_id = ?`,
      )
      .get(job.id) as
      | { created_at: string; verdict: string; data: string; kind: string; username: string; review: string | null; review_reason: string; review_at: string | null; review_note: string; reviewer: string | null }
      | undefined;
    return {
      acceptance: row
        ? {
            createdAt: row.created_at,
            verdict: row.verdict,
            by: row.username,
            ...JSON.parse(row.data),
            review: row.review ? { state: row.review, reason: row.review_reason, at: row.review_at, by: row.reviewer, note: row.review_note } : null,
          }
        : null,
      photos: photos(job.id),
      photosMissing: row ? photosMissing(job.id, row.kind) : [],
    };
  });

  /** Every earlier test of the installation (re-pointings), newest first, with their photos. */
  app.get('/api/provisioning/jobs/:id/acceptance/history', user, async (req) => {
    const job = loadJob(req);
    const rows = db
      .prepare(
        `SELECT h.id, h.kind, h.created_at createdAt, h.archived_at archivedAt, h.verdict, h.data, h.review, h.review_reason reviewReason, h.review_at reviewAt,
                h.review_note reviewNote, h.work_order_id workOrderId, u.username, r.username reviewer
           FROM acceptance_history h LEFT JOIN users u ON u.id = h.user_id LEFT JOIN users r ON r.id = h.review_by
          WHERE h.job_id = ? ORDER BY h.created_at DESC`,
      )
      .all(job.id) as Array<Record<string, unknown> & { id: number; data: string }>;
    return {
      items: rows.map(({ data, ...h }) => ({
        ...h,
        ...JSON.parse(data),
        photos: db.prepare('SELECT id, created_at createdAt, caption, size, type FROM job_photos WHERE job_id = ? AND history_id = ? ORDER BY id').all(job.id, h.id),
      })),
    };
  });

  app.put('/api/provisioning/jobs/:id/acceptance', user, async (req) => {
    const job = loadJob(req);
    if (job.status !== 'success') throw new HttpError(409, 'job_not_completed');
    const a = acceptanceSchema.parse(req.body);
    // a job started from a work order: the test is valid only at the customer's (the app checks it
    // too, this covers tests sent later from the offline queue and any other client)
    if (job.work_order_id && a.position) {
      const o = db.prepare('SELECT lat, lon, customer FROM work_orders WHERE id = ?').get(job.work_order_id) as { lat: number | null; lon: number | null; customer: string } | undefined;
      if (o && o.lat != null && o.lon != null) {
        const d = Math.round(distanceM({ lat: o.lat, lon: o.lon }, { lat: a.position.lat, lon: a.position.lon }));
        if (d > ACCEPTANCE_MAX_M) {
          recordEvent(db, req.user!.id, 'job.acceptance_position', job.id, `${o.customer}: collaudo a ${d} m dall'intervento, rifiutato`);
          throw new HttpError(422, 'acceptance_position_mismatch');
        }
      }
    }
    const { verdict: v, position: _pos, kind, workOrderId, ...data } = a;
    // a new test replaces the previous decision: poor radio waits again for the NOC
    const reason = poorRadio(a, ctx.cfg.thresholds.signalMin);
    const cur = db.prepare('SELECT * FROM job_acceptance WHERE job_id = ?').get(job.id) as (Record<string, unknown> & { data: string; work_order_id: number | null }) | undefined;
    const sameTest = !!cur && !!a.testId && (JSON.parse(cur.data) as { testId?: string }).testId === a.testId;
    let orderId: number | null = sameTest ? (cur?.work_order_id ?? null) : null;
    db.exec('BEGIN');
    try {
      // a re-pointing never overwrites the earlier test: it goes into the history with its photos
      if (cur && kind === 'repoint' && !sameTest) {
        const h = db
          .prepare(
            `INSERT INTO acceptance_history(job_id, kind, created_at, archived_at, user_id, verdict, data, review, review_reason, review_at, review_by, review_note, work_order_id)
             SELECT job_id, kind, created_at, ?, user_id, verdict, data, review, review_reason, review_at, review_by, review_note, work_order_id FROM job_acceptance WHERE job_id = ?`,
          )
          .run(nowIso(), job.id);
        db.prepare('UPDATE job_photos SET history_id = ? WHERE job_id = ? AND history_id IS NULL').run(Number(h.lastInsertRowid), job.id);
      }
      // the work order of the re-pointing: the one it came from, else a new one, already done
      if (kind === 'repoint' && !sameTest) orderId = repointOrder(job.id, req.user!, workOrderId ?? null);
      db.prepare(
        `INSERT INTO job_acceptance(job_id, created_at, user_id, verdict, data, review, review_reason, review_at, review_by, review_note, kind, work_order_id) VALUES(?,?,?,?,?,?,?,NULL,NULL,'',?,?)
         ON CONFLICT(job_id) DO UPDATE SET created_at = excluded.created_at, user_id = excluded.user_id, verdict = excluded.verdict, data = excluded.data,
           review = excluded.review, review_reason = excluded.review_reason, review_at = NULL, review_by = NULL, review_note = '', kind = excluded.kind, work_order_id = excluded.work_order_id`,
      ).run(job.id, nowIso(), req.user!.id, v, JSON.stringify(data), reason ? 'pending' : null, reason, kind, orderId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    recordEvent(
      db,
      req.user!.id,
      kind === 'repoint' ? 'job.acceptance_repoint' : 'job.acceptance',
      job.id,
      `${kind === 'repoint' ? 'ripuntamento · ' : ''}esito ${v}${a.radio.signal != null ? ` · ${a.radio.signal} dBm` : ''}${reason ? ' · da approvare dal NOC' : ''}${orderId ? ` · intervento #${orderId}` : ''}`,
    );
    if (reason) ctx.notify.reviewPending(job.id);
    if (kind === 'repoint' && !sameTest && orderId !== null && (workOrderId == null || orderId !== workOrderId)) {
      const info = db
        .prepare('SELECT j.mac, j.ssid, j.device_name deviceName, j.pppoe_user pppoeUser, u.username installer FROM provisioning_jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.id = ?')
        .get(job.id) as { mac: string; ssid: string; deviceName: string; pppoeUser: string; installer: string | null };
      const ESITO: Record<string, string> = { ok: 'superato', warn: 'con riserva', bad: 'non superato' };
      ctx.notify.inbox.push('noc', {
        kind: 'repoint_unplanned',
        title: `Ripuntamento senza intervento: ${info.deviceName || info.pppoeUser || info.mac}`,
        lines: [
          `Tecnico: ${req.user!.username}`,
          `CPE: ${info.mac} · ${a.cpe?.essid ?? info.ssid}${a.radio.signal != null ? ` · ${a.radio.signal} dBm` : ''}`,
          `Esito del collaudo: ${ESITO[v] ?? v}`,
          ...(job.user_id !== req.user!.id ? [`Installata da ${info.installer ?? 'un altro installatore'}`] : []),
          `Intervento #${orderId} creato, già fatto`,
        ],
        jobId: job.id,
        mac: info.mac,
      });
    }
    // a passed test: the CPE is connected and online, the NOC may accept it in UISP
    if (v !== 'bad' && !reason) {
      ctx.notify.readyForUisp(job.id);
      ctx.warehouse.record('collaudo', job.mac, `collaudo superato (${req.user!.username})`, job.id);
    }
    // a passed test after a postponed or KO attempt closes those reports (with poor radio: once approved)
    const resolved = v === 'bad' || reason ? 0 : resolveKoByAcceptance(db, job, req.user!.id);
    return { ok: true, review: reason ? 'pending' : null, reviewReason: reason, resolvedKo: resolved };
  });

  /** The CDA Net logo for the reports (the console's own file), read once. */
  let logo: string | null | undefined;
  const logoSvg = () => {
    if (logo === undefined) {
      try {
        logo = readFileSync(join(ctx.cfg.staticDir, 'assets', 'cda-net-logo.svg'), 'utf8');
      } catch {
        logo = null;
      }
    }
    return logo;
  };

  /**
   * «Rapporto di collaudo» as a PDF: outcome, customer, CPE, radio, network, checks, notes, decision
   * and photos. The NOC for every job, an installer for their own (loadJob); ?view=1 opens it in the
   * browser instead of downloading it.
   */
  const acceptanceReport = async (req: FastifyRequest, reply: FastifyReply) => {
    const job = loadJob(req);
    const forInstaller = req.user!.role !== 'admin';
    const j = db
      .prepare(
        `SELECT j.id, j.device_name, j.pppoe_user, j.model, j.mac, j.serial, j.ssid, j.template_name, j.completed_at, j.latitude, j.longitude, j.uisp_site,
                u.username installer, w.customer, w.address
           FROM provisioning_jobs j LEFT JOIN users u ON u.id = j.user_id LEFT JOIN work_orders w ON w.id = j.work_order_id WHERE j.id = ?`,
      )
      .get(job.id) as {
      id: string; device_name: string; pppoe_user: string; model: string; mac: string; serial: string; ssid: string; template_name: string; completed_at: string | null;
      latitude: number | null; longitude: number | null; uisp_site: string | null; installer: string | null; customer: string | null; address: string | null;
    };
    const row = db
      .prepare(
        `SELECT a.created_at, a.verdict, a.data, u.username, a.review, a.review_reason, a.review_at, a.review_note, r.username reviewer
           FROM job_acceptance a JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.review_by WHERE a.job_id = ?`,
      )
      .get(job.id) as
      | { created_at: string; verdict: 'ok' | 'warn' | 'bad'; data: string; username: string; review: string | null; review_reason: string; review_at: string | null; review_note: string; reviewer: string | null }
      | undefined;
    if (!row) throw new HttpError(404, 'acceptance_not_found');
    const list = db.prepare('SELECT id, created_at createdAt, caption, type FROM job_photos WHERE job_id = ? AND history_id IS NULL ORDER BY id').all(job.id) as Array<{ id: number; createdAt: string; caption: string; type: string }>;
    const kind = (db.prepare('SELECT kind FROM job_acceptance WHERE job_id = ?').get(job.id) as { kind: string } | undefined)?.kind ?? 'install';
    const pdf = acceptanceReportPdf({
      job: {
        id: j.id,
        customer: j.customer || j.device_name,
        pppoeUser: j.pppoe_user,
        address: j.address ?? '',
        model: j.model,
        mac: j.mac,
        serial: j.serial,
        ssid: j.ssid,
        template: j.template_name,
        installer: j.installer ?? '',
        installedAt: j.completed_at,
        latitude: j.latitude,
        longitude: j.longitude,
        uispSite: j.uisp_site,
      },
      acceptance: {
        createdAt: row.created_at,
        by: row.username,
        verdict: row.verdict,
        data: JSON.parse(row.data) as Record<string, unknown>,
        review: row.review ? { state: row.review, reason: row.review_reason, at: row.review_at, by: row.reviewer, note: row.review_note } : null,
      },
      photos: list.map((p) => {
        let data: Buffer | null = null;
        try {
          data = readFileSync(join(photoDir(root, job.id), `${p.id}.jpg`));
        } catch {
          data = null;
        }
        return { caption: p.caption || PHOTO_LABEL[p.type] || '', createdAt: p.createdAt, data };
      }),
      photosMissing: photosMissing(job.id, kind).map((t) => PHOTO_LABEL[t] ?? t),
      logoSvg: logoSvg(),
      generatedAt: new Date(),
      forInstaller,
    });
    recordEvent(db, req.user!.id, 'job.acceptance_pdf', job.id, j.customer || j.device_name);
    const name = `collaudo-${(j.customer || j.device_name || 'cpe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cpe'}-${row.created_at.slice(0, 10)}.pdf`;
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${(req.query as { view?: string }).view === '1' ? 'inline' : 'attachment'}; filename="${name}"`)
      .header('Cache-Control', 'no-store')
      .send(pdf);
  };
  app.get('/api/admin/provisioning/jobs/:id/acceptance.pdf', { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('acceptance')] }, acceptanceReport);
  app.get('/api/provisioning/jobs/:id/acceptance.pdf', { preHandler: [ctx.auth.requireUser, ctx.modules.require('acceptance')] }, acceptanceReport);

  /** Decision of the NOC on an acceptance test with poor radio; the installer is told. */
  app.post('/api/admin/provisioning/jobs/:id/review', { preHandler: [ctx.auth.requireAdmin] }, async (req) => {
    const job = loadJob(req);
    const b = z
      .object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).default('') })
      .strict()
      .refine((x) => x.decision === 'approved' || x.note.length >= 3, { message: 'Scrivi il motivo del rifiuto', path: ['note'] })
      .parse(req.body);
    const r = db.prepare("UPDATE job_acceptance SET review = ?, review_at = ?, review_by = ?, review_note = ? WHERE job_id = ? AND review IS NOT NULL").run(b.decision, nowIso(), req.user!.id, b.note, job.id);
    if (!r.changes) throw new HttpError(409, 'review_not_required');
    recordEvent(db, req.user!.id, b.decision === 'approved' ? 'job.review_approved' : 'job.review_rejected', job.id, b.note);
    if (b.decision === 'approved') {
      resolveKoByAcceptance(db, job, req.user!.id);
      ctx.notify.readyForUisp(job.id);
      ctx.warehouse.record('collaudo', job.mac, `collaudo approvato dal NOC (${req.user!.username})`, job.id);
    }
    ctx.notify.reviewDecision(job.id, req.user!.username);
    return { ok: true };
  });

  /**
   * The NOC marks a test that did not pass (or passed with warnings) as passed, whatever the
   * measures said, with the reason. The test becomes «superato» everywhere (history, warehouse,
   * statistics, the report, «pronta da accettare»); what the app had measured stays in [data.override].
   */
  /** NOC: who may save re-pointing tests on this installation of someone else's (still valid or not). */
  app.get('/api/admin/provisioning/jobs/:id/repoint-grants', { preHandler: [ctx.auth.requireAdmin] }, async (req) => {
    const job = loadJob(req);
    const from = new Date(Date.now() - REPOINT_GRANT_HOURS * 3_600_000).toISOString();
    const rows = db
      .prepare('SELECT g.user_id userId, u.username, g.granted_at grantedAt FROM repoint_grants g JOIN users u ON u.id = g.user_id WHERE g.job_id = ? ORDER BY g.granted_at DESC')
      .all(job.id) as Array<{ userId: number; username: string; grantedAt: string }>;
    return { hours: REPOINT_GRANT_HOURS, items: rows.map((r) => ({ ...r, active: r.grantedAt >= from })) };
  });

  /** NOC: ends a technician's access to the re-pointing tests of an installation of someone else's. */
  app.delete('/api/admin/provisioning/jobs/:id/repoint-grants/:userId', { preHandler: [ctx.auth.requireAdmin] }, async (req) => {
    const job = loadJob(req);
    const userId = z.coerce.number().int().positive().parse((req.params as { userId: string }).userId);
    const r = db.prepare('DELETE FROM repoint_grants WHERE job_id = ? AND user_id = ?').run(job.id, userId);
    if (!r.changes) throw new HttpError(404, 'grant_not_found');
    recordEvent(db, req.user!.id, 'job.repoint_revoke', job.id, `accesso al ripuntamento revocato (utente ${userId})`);
    return { ok: true };
  });

  app.post('/api/admin/provisioning/jobs/:id/acceptance/pass', { preHandler: [ctx.auth.requireAdmin] }, async (req) => {
    const job = loadJob(req);
    const b = z.object({ note: z.string().trim().min(3, 'Scrivi il motivo').max(500) }).strict().parse(req.body);
    const row = db.prepare('SELECT verdict, data FROM job_acceptance WHERE job_id = ?').get(job.id) as { verdict: string; data: string } | undefined;
    if (!row) throw new HttpError(404, 'acceptance_not_found');
    if (row.verdict === 'ok') throw new HttpError(409, 'acceptance_already_passed');
    const data = JSON.parse(row.data) as Record<string, unknown>;
    data.override = { from: row.verdict, by: req.user!.username, at: nowIso(), note: b.note };
    db.prepare("UPDATE job_acceptance SET verdict = 'ok', data = ?, review = 'approved', review_at = ?, review_by = ?, review_note = ? WHERE job_id = ?").run(
      JSON.stringify(data),
      nowIso(),
      req.user!.id,
      b.note,
      job.id,
    );
    recordEvent(db, req.user!.id, 'job.acceptance_pass', job.id, `era ${row.verdict === 'bad' ? 'non superato' : 'con riserva'} · ${b.note}`);
    resolveKoByAcceptance(db, job, req.user!.id);
    ctx.notify.readyForUisp(job.id);
    ctx.warehouse.record('collaudo', job.mac, `collaudo segnato come superato dal NOC (${req.user!.username})`, job.id);
    ctx.notify.reviewDecision(job.id, req.user!.username);
    return { ok: true };
  });

  app.post('/api/provisioning/jobs/:id/photos', user, async (req, reply) => {
    const job = loadJob(req);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 1024) throw new HttpError(400, 'photo_invalid');
    if (!(body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)) throw new HttpError(415, 'photo_not_jpeg');
    const q = z.object({ caption: z.string().trim().max(80).default(''), type: z.enum(PHOTO_TYPES).default('other') }).parse(req.query);
    const caption = q.caption;
    const sha = createHash('sha256').update(body).digest('hex');
    // the same picture twice (a retry of the queue, or the same shot chosen again): kept once
    const same = db.prepare('SELECT id FROM job_photos WHERE job_id = ? AND history_id IS NULL AND sha256 = ?').get(job.id, sha) as { id: number } | undefined;
    if (same) throw new HttpError(409, 'photo_duplicate', { id: same.id });
    const count = (db.prepare('SELECT count(*) n FROM job_photos WHERE job_id = ? AND history_id IS NULL').get(job.id) as { n: number }).n;
    if (count >= MAX_PHOTOS) throw new HttpError(409, 'too_many_photos', { max: MAX_PHOTOS });
    const r = db
      .prepare('INSERT INTO job_photos(job_id, created_at, user_id, caption, size, sha256, type) VALUES(?,?,?,?,?,?,?)')
      .run(job.id, nowIso(), req.user!.id, caption, body.length, sha, q.type);
    const id = Number(r.lastInsertRowid);
    const dir = photoDir(root, job.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jpg`), body);
    recordEvent(db, req.user!.id, 'job.photo', job.id, caption || PHOTO_LABEL[q.type] || `foto ${id}`);
    return reply.code(201).send({ id, size: body.length });
  });

  app.get('/api/provisioning/jobs/:id/photos/:photoId', user, async (req, reply) => {
    const job = loadJob(req);
    const pid = z.coerce.number().int().positive().parse((req.params as { photoId: string }).photoId);
    const row = db.prepare('SELECT id FROM job_photos WHERE id = ? AND job_id = ?').get(pid, job.id);
    if (!row) throw new HttpError(404, 'photo_not_found');
    let data: Buffer;
    try {
      data = readFileSync(join(photoDir(root, job.id), `${pid}.jpg`));
    } catch {
      throw new HttpError(404, 'photo_not_found');
    }
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=86400').send(data);
  });

  app.delete('/api/provisioning/jobs/:id/photos/:photoId', user, async (req) => {
    const job = loadJob(req);
    const pid = z.coerce.number().int().positive().parse((req.params as { photoId: string }).photoId);
    const r = db.prepare('DELETE FROM job_photos WHERE id = ? AND job_id = ?').run(pid, job.id);
    if (!r.changes) throw new HttpError(404, 'photo_not_found');
    rmSync(join(photoDir(root, job.id), `${pid}.jpg`), { force: true });
    recordEvent(db, req.user!.id, 'job.photo_delete', job.id, `foto ${pid}`);
    return { ok: true };
  });
}
