import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { photoDir } from '../services/photos.ts';
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
    // height of the CPE above the ground, typed by the technician (older apps do not send it)
    cpeHeightM: z.number().min(0.5).max(100).nullable().optional(),
  })
  .strict();

/** Radio checks of the app: a red one means a poor link the NOC has to accept. */
const RADIO_CHECKS = new Set(['Segnale ricevuto', 'Segnale lato AP', 'CINR (qualità)', 'Capacità airMAX', 'Catene (polarizzazioni)', "Collegamento all'AP"]);

/** Why the acceptance test needs the NOC's approval ('' = it does not). */
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
}

export function acceptanceRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('acceptance')] };
  const { db } = ctx;
  const root = ctx.cfg.photosDir;

  app.addContentTypeParser(['image/jpeg'], { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES }, (_req, body, done) => done(null, body));

  const loadJob = (req: FastifyRequest) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const job = db.prepare('SELECT id, user_id, status, mac FROM provisioning_jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (!job) throw new HttpError(404, 'job_not_found');
    // installers: their own installations and the CPEs assigned to them (re-pointing, maintenance)
    const assigned = () => !!db.prepare('SELECT 1 FROM cpe_assignments WHERE mac = ? AND user_id = ?').get(job.mac, req.user!.id);
    if (job.user_id !== req.user!.id && req.user!.role !== 'admin' && !assigned()) throw new HttpError(403, 'forbidden');
    return job;
  };

  const photos = (jobId: string) =>
    db.prepare('SELECT id, created_at createdAt, caption, size FROM job_photos WHERE job_id = ? ORDER BY id').all(jobId);

  app.get('/api/provisioning/jobs/:id/acceptance', user, async (req) => {
    const job = loadJob(req);
    const row = db
      .prepare(
        `SELECT a.created_at, a.verdict, a.data, u.username, a.review, a.review_reason, a.review_at, a.review_note, r.username reviewer
           FROM job_acceptance a JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.review_by WHERE a.job_id = ?`,
      )
      .get(job.id) as
      | { created_at: string; verdict: string; data: string; username: string; review: string | null; review_reason: string; review_at: string | null; review_note: string; reviewer: string | null }
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
    };
  });

  app.put('/api/provisioning/jobs/:id/acceptance', user, async (req) => {
    const job = loadJob(req);
    if (job.status !== 'success') throw new HttpError(409, 'job_not_completed');
    const a = acceptanceSchema.parse(req.body);
    const { verdict: v, ...data } = a;
    // a new test replaces the previous decision: poor radio waits again for the NOC
    const reason = poorRadio(a, ctx.cfg.thresholds.signalMin);
    db.prepare(
      `INSERT INTO job_acceptance(job_id, created_at, user_id, verdict, data, review, review_reason, review_at, review_by, review_note) VALUES(?,?,?,?,?,?,?,NULL,NULL,'')
       ON CONFLICT(job_id) DO UPDATE SET created_at = excluded.created_at, user_id = excluded.user_id, verdict = excluded.verdict, data = excluded.data,
         review = excluded.review, review_reason = excluded.review_reason, review_at = NULL, review_by = NULL, review_note = ''`,
    ).run(job.id, nowIso(), req.user!.id, v, JSON.stringify(data), reason ? 'pending' : null, reason);
    recordEvent(db, req.user!.id, 'job.acceptance', job.id, `esito ${v}${a.radio.signal != null ? ` · ${a.radio.signal} dBm` : ''}${reason ? ' · da approvare dal NOC' : ''}`);
    if (reason) ctx.notify.reviewPending(job.id);
    // a passed test after a postponed or KO attempt closes those reports (with poor radio: once approved)
    const resolved = v === 'bad' || reason ? 0 : resolveKoByAcceptance(db, job, req.user!.id);
    return { ok: true, review: reason ? 'pending' : null, reviewReason: reason, resolvedKo: resolved };
  });

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
    if (b.decision === 'approved') resolveKoByAcceptance(db, job, req.user!.id);
    ctx.notify.reviewDecision(job.id, req.user!.username);
    return { ok: true };
  });

  app.post('/api/provisioning/jobs/:id/photos', user, async (req, reply) => {
    const job = loadJob(req);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 1024) throw new HttpError(400, 'photo_invalid');
    if (!(body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)) throw new HttpError(415, 'photo_not_jpeg');
    const count = (db.prepare('SELECT count(*) n FROM job_photos WHERE job_id = ?').get(job.id) as { n: number }).n;
    if (count >= MAX_PHOTOS) throw new HttpError(409, 'too_many_photos', { max: MAX_PHOTOS });
    const caption = z.string().trim().max(80).default('').parse((req.query as { caption?: string }).caption ?? '');
    const sha = createHash('sha256').update(body).digest('hex');
    const r = db
      .prepare('INSERT INTO job_photos(job_id, created_at, user_id, caption, size, sha256) VALUES(?,?,?,?,?,?)')
      .run(job.id, nowIso(), req.user!.id, caption, body.length, sha);
    const id = Number(r.lastInsertRowid);
    const dir = photoDir(root, job.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jpg`), body);
    recordEvent(db, req.user!.id, 'job.photo', job.id, caption || `foto ${id}`);
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
