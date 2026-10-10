import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';

/** Assistente rete (admins): findings on APs and CPEs, dismissing one, a refresh on demand. */
export function advisorRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireAdmin] };

  app.get('/api/admin/advisor', admin, async () => ({ ...ctx.advisor.view(), loadAt: ctx.apLoad.at() }));

  app.post('/api/admin/advisor/dismiss', admin, async (req) => {
    const b = z.object({ id: z.string().min(3).max(200), days: z.number().int().min(0).max(365) }).strict().parse(req.body);
    ctx.advisor.dismiss(b.id, b.days);
    recordEvent(ctx.db, req.user!.id, 'advisor.dismiss', b.id, b.days ? `ignorato per ${b.days} giorni` : 'di nuovo visibile');
    return { ok: true };
  });

  /** New data from UISP now (one or two minutes), instead of waiting for the hourly refresh. */
  app.post('/api/admin/advisor/refresh', admin, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    recordEvent(ctx.db, req.user!.id, 'advisor.refresh', 'Assistente rete', 'aggiornamento manuale');
    void ctx.apLoad.refresh();
    return { started: true };
  });
}
