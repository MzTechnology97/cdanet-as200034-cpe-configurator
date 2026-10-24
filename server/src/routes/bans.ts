import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';

/** Console: the login attempts and the banned IPs and devices (fail2ban-like), with unban; CrowdSec. */
export function banRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };

  app.get('/api/admin/bans', admin, async () => ({ items: ctx.loginGuard.list() }));

  app.delete('/api/admin/bans/:id', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    if (!ctx.loginGuard.lift(id, req.user!.id)) throw new HttpError(404, 'ban_not_found');
    return { ok: true };
  });

  app.get('/api/admin/login-attempts', admin, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        failed: z.enum(['0', '1']).default('0'),
        ip: z.string().trim().max(64).optional(),
        username: z.string().trim().max(80).optional(),
      })
      .parse(req.query);
    return { items: ctx.loginGuard.attempts({ limit: q.limit, failed: q.failed === '1', ip: q.ip, username: q.username }) };
  });

  // CrowdSec (services/crowdsec.ts): state, what it blocks here, the exceptions of the admins
  app.get('/api/admin/crowdsec', admin, async () => ctx.crowdsec.status());

  app.get('/api/admin/crowdsec/check', admin, async (req) => ctx.crowdsec.check(z.object({ ip: z.string().trim().min(2).max(64) }).parse(req.query).ip));

  app.post('/api/admin/crowdsec/allow', admin, async (req, reply) => {
    const b = z
      .object({ value: z.string().trim().min(2).max(64), note: z.string().trim().max(120).optional(), days: z.number().int().min(1).max(365).optional() })
      .strict()
      .parse(req.body);
    reply.code(201);
    return ctx.crowdsec.allowAdd(b, req.user!.id);
  });

  app.delete('/api/admin/crowdsec/allow/:id', admin, async (req) => {
    ctx.crowdsec.allowRemove(z.coerce.number().int().positive().parse((req.params as { id: string }).id), req.user!.id);
    return { ok: true };
  });
}
