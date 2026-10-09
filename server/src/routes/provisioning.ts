import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { toCsv } from '../domain/csv.ts';
import { parseClientHeader, versionAtLeast } from '../domain/policy.ts';
import { provisionRequestSchema, provisionResultSchema } from '../services/provisioning.ts';

export function provisioningRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: ctx.auth.requireUser };

  /** Templates selectable in the field app (names only, no content). */
  app.get('/api/provisioning/templates', user, async (req) =>
    ctx.templates.visibleTo(req.user!),
  );

  app.get('/api/wireless-networks', user, async () =>
    ctx.db.prepare('SELECT ssid, updated_at updatedAt FROM wireless_secrets ORDER BY ssid').all(),
  );

  /** Dry-run: validates the request and reports readiness without exposing any secret. */
  app.post('/api/provisioning/plan', user, async (req) => {
    const x = provisionRequestSchema.parse(req.body);
    return { ok: true, request: { ...x, pppoePassword: undefined }, ...ctx.provisioning.plan(x, req.user!) };
  });

  /**
   * Creates a short-lived job and returns the fully rendered system.cfg.
   * Only the Android field client (which applies it over SSH) may call this.
   */
  app.post('/api/provisioning/jobs', user, async (req, reply) => {
    const client = parseClientHeader(req.headers['x-cda-client'] as string | undefined);
    if (!client) throw new HttpError(403, 'trusted_client_required');
    if (!versionAtLeast(client.version, ctx.cfg.minAndroidVersion)) {
      throw new HttpError(426, 'client_update_required', { minVersion: ctx.cfg.minAndroidVersion });
    }
    const x = provisionRequestSchema.parse(req.body);
    const pkg = ctx.provisioning.createJob(x, req.user!, `${client.platform}/${client.version}`);
    recordEvent(ctx.db, req.user!.id, 'job.create', pkg.jobId, `${x.model} ${x.mac}`);
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(pkg);
  });

  app.post('/api/provisioning/jobs/:id/result', user, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const body = provisionResultSchema.parse(req.body);
    const r = ctx.provisioning.recordResult(id, req.user!, body);
    if (!r.duplicate) ctx.notify.provisioningResult(id);
    return r;
  });

  const listQuery = z.object({
    limit: z.coerce.number().int().min(1).max(1000).default(200),
    q: z.string().trim().max(80).optional(),
    status: z.enum(['prepared', 'success', 'failed', 'expired']).optional(),
    /** YYYY-MM-DD, both inclusive. */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });
  const range = (q: { from?: string | undefined; to?: string | undefined }) => ({
    from: q.from ? `${q.from}T00:00:00.000Z` : undefined,
    to: q.to ? new Date(Date.parse(`${q.to}T00:00:00.000Z`) + 86400_000).toISOString() : undefined,
  });

  app.get('/api/provisioning/jobs', user, async (req) => {
    const q = listQuery.parse(req.query);
    return ctx.provisioning.listJobs(req.user!, { ...q, ...range(q) });
  });

  /** Same filters as the history page, as CSV for Excel (Italian locale: ';', UTF-8 BOM). */
  app.get('/api/provisioning/jobs.csv', user, async (req, reply) => {
    const q = listQuery.extend({ limit: z.coerce.number().int().min(1).max(20000).default(5000) }).parse(req.query);
    const rows = ctx.provisioning.listJobs(req.user!, { ...q, ...range(q) }) as Array<Record<string, unknown>>;
    const header = ['Data', 'Esito', 'Cliente', 'Utente PPPoE', 'Modello', 'Template', 'MAC', 'Seriale', 'SSID', 'Installatore', 'Collaudo', 'Foto', 'Site UISP', 'Accettata in UISP', 'Latitudine', 'Longitudine', 'Sostituisce job', 'Errore'];
    const esito: Record<string, string> = { success: 'completato', failed: 'fallito', prepared: 'preparato', expired: 'scaduto' };
    const collaudo: Record<string, string> = { ok: 'superato', warn: 'con riserva', bad: 'non superato' };
    const lines = rows.map((r) => [
      r.createdAt, esito[String(r.status)] ?? r.status, r.deviceName, r.pppoeUser, r.model, r.template, r.mac, r.serial, r.ssid, r.installer,
      r.acceptance ? (collaudo[String(r.acceptance)] ?? r.acceptance) : '', r.photos ?? 0, r.uispSite, r.uispAuthorizedAt ?? '',
      r.latitude ?? '', r.longitude ?? '', r.replacesJobId ?? '', r.error,
    ]);
    recordEvent(ctx.db, req.user!.id, 'jobs.export', `${rows.length} righe`, [q.status, q.q, q.from, q.to].filter(Boolean).join(' · '));
    const name = `storico-provisioning-${new Date().toISOString().slice(0, 10)}.csv`;
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}"`);
    return '\uFEFF' + toCsv([header, ...lines]);
  });
}
