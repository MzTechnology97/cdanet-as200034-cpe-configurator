import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { escapeHtml } from '../services/telegram.ts';

/**
 * «Gruppi di lavoro» (#275, titolare 17/10/2026): specialists sharing templates, installations and
 * calendar. Only the admins make them and decide who is in them; a specialist only sees his own.
 */
export function workGroupRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };
  const name = z.string().trim().min(1).max(60).regex(/^[^\r\n\0]+$/);
  const idParam = z.object({ id: z.coerce.number().int().positive() });
  const g = () => ctx.workGroups;

  app.get('/api/admin/work-groups', admin, async () => ({ items: g().list() }));

  app.post('/api/admin/work-groups', admin, async (req, reply) => {
    const b = z.object({ name }).strict().parse(req.body);
    const group = g().create(b.name, req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'work_group.create', group.name, '');
    return reply.code(201).send(group);
  });

  app.patch('/api/admin/work-groups/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name }).strict().parse(req.body);
    const before = g().get(id).name;
    const group = g().rename(id, b.name);
    recordEvent(ctx.db, req.user!.id, 'work_group.rename', group.name, `prima «${before}»`);
    return group;
  });

  app.delete('/api/admin/work-groups/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const group = g().remove(id);
    recordEvent(ctx.db, req.user!.id, 'work_group.delete', group.name, group.members.map((m) => m.username).join(', '));
    if (group.members.length > 1) ctx.notify.security(`Gruppo di lavoro <b>${escapeHtml(group.name)}</b> eliminato da ${escapeHtml(req.user!.username)}: i membri non vedono più i dati degli altri`);
    return { ok: true };
  });

  /** The members (specialists only): who is in sees the others' templates, installations and calendar. */
  app.put('/api/admin/work-groups/:id/members', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ userIds: z.array(z.number().int().positive()).max(100) }).strict().parse(req.body);
    const { group, added, removed } = g().setMembers(id, b.userIds);
    const detail = [added.length ? `aggiunti ${added.map((m) => m.username).join(', ')}` : '', removed.length ? `tolti ${removed.map((m) => m.username).join(', ')}` : ''].filter(Boolean).join(' · ');
    recordEvent(ctx.db, req.user!.id, 'work_group.members', group.name, detail || 'nessun cambio');
    // who joins sees the data of the others: the NOC hears of it, like any other permission
    if (added.length) {
      ctx.notify.security(
        `${added.map((m) => `<b>${escapeHtml(m.username)}</b>`).join(', ')} nel gruppo di lavoro <b>${escapeHtml(group.name)}</b> (${escapeHtml(req.user!.username)}): vede template, storico e calendario degli altri membri`,
      );
    }
    return group;
  });

  /** The specialist's own groups (his pages show them): names and members, nothing else. */
  app.get('/api/specialist/groups', { preHandler: ctx.auth.requireSpecialist }, async (req) => ({
    items: g()
      .groupsOf(req.user!.id)
      .map((x) => ({ id: x.id, name: x.name, members: x.members.map((m) => m.username) })),
  }));
}
