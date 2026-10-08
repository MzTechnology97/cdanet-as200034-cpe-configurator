import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { parseClientHeader, versionAtLeast } from '../domain/policy.ts';
import { provisionRequestSchema, provisionResultSchema } from '../services/provisioning.ts';

export function provisioningRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: ctx.auth.requireUser };

  /** Templates selectable in the field app (names only, no content). */
  app.get('/api/provisioning/templates', user, async () =>
    ctx.templates.list().map((t) => ({ id: t.id, model: t.model, name: t.name, isDefault: t.isDefault })),
  );

  app.get('/api/wireless-networks', user, async () =>
    ctx.db.prepare('SELECT ssid, updated_at updatedAt FROM wireless_secrets ORDER BY ssid').all(),
  );

  /** Dry-run: validates the request and reports readiness without exposing any secret. */
  app.post('/api/provisioning/plan', user, async (req) => {
    const x = provisionRequestSchema.parse(req.body);
    return { ok: true, request: { ...x, pppoePassword: undefined }, ...ctx.provisioning.plan(x) };
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
    const pkg = ctx.provisioning.createJob(x, req.user!.id, `${client.platform}/${client.version}`);
    recordEvent(ctx.db, req.user!.id, 'job.create', pkg.jobId, `${x.model} ${x.mac}`);
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(pkg);
  });

  app.post('/api/provisioning/jobs/:id/result', user, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const body = provisionResultSchema.parse(req.body);
    return ctx.provisioning.recordResult(id, req.user!, body);
  });

  app.get('/api/provisioning/jobs', user, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        q: z.string().trim().max(80).optional(),
        status: z.enum(['prepared', 'success', 'failed', 'expired']).optional(),
      })
      .parse(req.query);
    return ctx.provisioning.listJobs(req.user!, q);
  });
}
