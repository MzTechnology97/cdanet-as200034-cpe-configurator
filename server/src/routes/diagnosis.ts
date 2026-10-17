import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, isStaff } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { createDiagnosis } from '../services/diagnosis.ts';

/**
 * «Diagnosi a distanza»: the NOC for any line (work order, MAC or PPPoE user); an installer only for
 * the work orders assigned to them, with the findings and the essentials (no account or session).
 */
export function diagnosisRoutes(app: FastifyInstance, ctx: AppContext) {
  const d = createDiagnosis(ctx);
  const q = z.object({
    workOrderId: z.coerce.number().int().positive().optional(),
    mac: z.string().trim().max(40).optional(),
    pppoeUser: z.string().trim().max(128).optional(),
  });

  app.get('/api/admin/diagnosis', { preHandler: ctx.auth.requireStaff }, async (req) => d.run(q.parse(req.query)));

  app.get('/api/field/diagnosis', { preHandler: [ctx.auth.requireUser, ctx.modules.require('work_orders')] }, async (req) => {
    const { workOrderId } = z.object({ workOrderId: z.coerce.number().int().positive() }).parse(req.query);
    const o = ctx.db.prepare('SELECT assigned_to FROM work_orders WHERE id = ?').get(workOrderId) as { assigned_to: number | null } | undefined;
    if (!o) throw new HttpError(404, 'work_order_not_found');
    if (!isStaff(req.user!.role) && o.assigned_to !== req.user!.id) throw new HttpError(403, 'forbidden');
    const r = await d.run({ workOrderId });
    return {
      at: r.at,
      verdict: r.verdict,
      findings: r.findings,
      cpe: r.facts.cpe ? { found: r.facts.cpe.found, online: r.facts.cpe.online, signal: r.facts.cpe.signal } : null,
      ap: r.facts.ap ? { name: r.facts.ap.name, online: r.facts.ap.online } : null,
    };
  });
}
