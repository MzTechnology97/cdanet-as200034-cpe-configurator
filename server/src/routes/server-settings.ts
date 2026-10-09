import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';

/** "Impostazioni server" (admin): the .env parameters editable from the console. */
export function serverSettingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };

  app.get('/api/admin/server-settings', admin, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return ctx.serverSettings.view();
  });

  app.put('/api/admin/server-settings', admin, async (req) => {
    const b = z.object({ values: z.record(z.string(), z.unknown()) }).strict().parse(req.body);
    let r;
    try {
      r = ctx.serverSettings.update(b.values, req.user!.id);
    } catch (e) {
      if ((e as { code?: string }).code === 'unknown_setting') throw new HttpError(400, 'unknown_setting');
      throw e;
    }
    // names only: secret values never reach the activity log
    recordEvent(ctx.db, req.user!.id, 'server.settings', r.changed.join(', '), r.restart.length ? 'riavvio richiesto' : '');
    return { ...ctx.serverSettings.view(), restartNeeded: r.restart };
  });

  /** Restarts the app process (Docker brings it back): for the settings read only at start-up. */
  app.post('/api/admin/server-settings/restart', admin, async (req) => {
    recordEvent(ctx.db, req.user!.id, 'server.restart', 'app', 'dalla console');
    if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) setTimeout(() => process.exit(0), 800).unref();
    return { ok: true };
  });
}
