import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent, type Db } from '../db.ts';
import { parseMac } from '../domain/policy.ts';

/** Why an installation did not end well: the same list in the app, the console and the stats. */
export const KO_REASONS = {
  no_signal: 'Segnale insufficiente o nessun AP',
  no_link: 'La CPE non si aggancia',
  obstacles: 'Ostacoli, nessuna visibilità',
  cpe_fault: 'CPE guasta',
  no_access: 'Cliente assente o accesso impossibile',
  weather: 'Maltempo',
  material: 'Materiale mancante',
  other: 'Altro',
} as const;
export const KO_KINDS = { postponed: 'Rimandata', definitive: 'KO definitivo' } as const;
export const KO_STEPS = { config: 'Configurazione', write: 'Scrittura nella CPE', verify: 'Verifica della CPE', link: "Aggancio all'AP", aim: 'Puntamento', final: 'Verifica finale e collaudo' } as const;

const num = z.number().finite().nullable().optional();
const keys = <T extends object>(o: T) => Object.keys(o) as [keyof T & string, ...Array<keyof T & string>];

/**
 * Reported by the technician from any step of the guided installation. A report never blocks the
 * installation: the technician (or a colleague) can retry, and the report is closed by itself when
 * a later acceptance test of the same CPE passes.
 */
export const koSchema = z
  .object({
    kind: z.enum(keys(KO_KINDS)),
    jobId: z.string().uuid().optional(),
    mode: z.enum(['new', 'repoint']),
    step: z.enum(keys(KO_STEPS)),
    reason: z.enum(keys(KO_REASONS)),
    /** Always required: why it was postponed or why it is a definitive KO. */
    note: z.string().trim().min(5, 'Scrivi la motivazione').max(1000),
    /** Postponed: the day agreed for the new attempt (optional). */
    retryOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    mac: z.string().max(40).optional(),
    ssid: z.string().max(64).optional(),
    measures: z
      .object({ signal: num, expectedSignal: num, distanceM: num, apName: z.string().max(100).nullable().optional(), associated: z.boolean().nullable().optional() })
      .strict()
      .default({}),
  })
  .strict();

/** Open reports of an installation are closed when the CPE later passes the acceptance test. */
export function resolveKoByAcceptance(db: Db, job: { id: string; mac: string }, userId: number) {
  const r = db
    .prepare(
      `UPDATE install_ko SET resolved_at = ?, resolved_by = ?, resolution = 'Collaudo superato in un tentativo successivo'
        WHERE resolved_at IS NULL AND (job_id = ? OR (mac <> '' AND mac = ?))`,
    )
    .run(nowIso(), userId, job.id, job.mac);
  return Number(r.changes);
}

export function koRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const user = { preHandler: ctx.auth.requireUser };
  const admin = { preHandler: ctx.auth.requireAdmin };

  app.post('/api/installs/ko', user, async (req, reply) => {
    const b = koSchema.parse(req.body);
    let mac = b.mac ? parseMac(b.mac) : null;
    if (b.mac && !mac) throw new HttpError(400, 'invalid_mac');
    let jobMac = '';
    if (b.jobId) {
      const job = db.prepare('SELECT id, user_id, mac FROM provisioning_jobs WHERE id = ?').get(b.jobId) as { id: string; user_id: number; mac: string } | undefined;
      if (!job) throw new HttpError(404, 'job_not_found');
      const assigned = !!db.prepare('SELECT 1 FROM cpe_assignments WHERE mac = ? AND user_id = ?').get(job.mac, req.user!.id);
      if (job.user_id !== req.user!.id && req.user!.role !== 'admin' && !assigned) throw new HttpError(403, 'forbidden');
      jobMac = job.mac;
    }
    mac = mac ?? (jobMac || null);
    const data = { ...b.measures, ...(b.kind === 'postponed' && b.retryOn ? { retryOn: b.retryOn } : {}) };
    const r = db
      .prepare('INSERT INTO install_ko(created_at, user_id, job_id, kind, mode, step, reason, note, mac, ssid, data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(nowIso(), req.user!.id, b.jobId ?? null, b.kind, b.mode, b.step, b.reason, b.note, mac ?? '', b.ssid ?? '', JSON.stringify(data));
    const id = Number(r.lastInsertRowid);
    recordEvent(db, req.user!.id, b.kind === 'postponed' ? 'install.postponed' : 'install.ko', mac ?? b.ssid ?? '', `${KO_REASONS[b.reason]} · ${KO_STEPS[b.step]}: ${b.note}`);
    ctx.notify.installKo(id);
    return reply.code(201).send({ id });
  });

  /** Reports, newest first: admins see all of them, installers their own. */
  app.get('/api/installs/ko', user, async (req, reply) => {
    const q = z.object({ open: z.enum(['1', '0']).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (req.user!.role !== 'admin') {
      where.push('k.user_id = ?');
      params.push(req.user!.id);
    }
    if (q.open === '1') where.push('k.resolved_at IS NULL');
    if (q.open === '0') where.push('k.resolved_at IS NOT NULL');
    const rows = db
      .prepare(
        `SELECT k.id, k.created_at createdAt, k.job_id jobId, k.kind, k.mode, k.step, k.reason, k.note, k.mac, k.ssid, k.data,
                k.resolved_at resolvedAt, k.resolution, u.username installer, r.username resolvedBy,
                j.device_name deviceName, j.pppoe_user pppoeUser, j.status jobStatus,
                (SELECT count(*) FROM install_ko o WHERE o.id <> k.id AND ((k.job_id IS NOT NULL AND o.job_id = k.job_id) OR (k.mac <> '' AND o.mac = k.mac))) others
           FROM install_ko k JOIN users u ON u.id = k.user_id
           LEFT JOIN users r ON r.id = k.resolved_by
           LEFT JOIN provisioning_jobs j ON j.id = k.job_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY k.created_at DESC LIMIT ?`,
      )
      .all(...params, q.limit) as Array<Record<string, unknown>>;
    reply.header('Cache-Control', 'no-store');
    return rows.map(({ data, others, ...r }) => ({ ...r, attempts: Number(others) + 1, ...JSON.parse(String(data || '{}')) }));
  });

  /** Closed by hand (solved in another way, or no longer to do). */
  app.post('/api/admin/installs/ko/:id/resolve', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = z.object({ note: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    const r = db.prepare('UPDATE install_ko SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL').run(nowIso(), req.user!.id, b.note, id);
    if (!r.changes) throw new HttpError(404, 'ko_not_found');
    recordEvent(db, req.user!.id, 'install.ko_resolved', String(id), b.note);
    return { ok: true };
  });
}
