import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';

/** Console: the login attempts and the banned IPs and devices (fail2ban-like), with unban. */
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
}
