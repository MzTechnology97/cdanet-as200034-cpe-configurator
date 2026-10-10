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

  /** Automatic optimisation: state, runs (newest first) and whether Impostazioni server allows it. */
  app.get('/api/admin/advisor/optimizer', admin, async () => ctx.optimizer.view());

  /** Starts (now or at night) the optimisation of the AP of a finding: the admin confirmed it. */
  app.post('/api/admin/advisor/optimizer', admin, async (req, reply) => {
    const b = z
      .object({ findingId: z.string().min(3).max(200), mode: z.enum(['suggested', 'search']), when: z.enum(['now', 'night']), confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    let run;
    try {
      run = ctx.optimizer.schedule({ findingId: b.findingId, mode: b.mode, when: b.when, by: req.user!.username });
    } catch (e) {
      const err = e as Error & { status?: number };
      throw new HttpError(err.status ?? 400, err.message);
    }
    recordEvent(ctx.db, req.user!.id, 'advisor.optimize', run.apName, `${b.mode === 'suggested' ? 'canale consigliato' : 'ricerca del canale migliore'} · ${run.candidates.map((c) => `${c.centre}/${c.width}`).join(', ')} · ${b.when === 'now' ? 'subito' : `alle ${run.startAt}`}`);
    if (b.when === 'now') void ctx.optimizer.tick();
    return reply.code(202).send(run);
  });

  /** Cancels a scheduled run or stops the active one (the AP goes back to its original channel). */
  app.post('/api/admin/advisor/optimizer/:id/cancel', admin, async (req) => {
    const id = z.string().min(3).max(80).parse((req.params as { id: string }).id);
    if (!ctx.optimizer.cancel(id)) throw new HttpError(409, 'not_cancellable');
    recordEvent(ctx.db, req.user!.id, 'advisor.optimize_cancel', id, 'annullata');
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
