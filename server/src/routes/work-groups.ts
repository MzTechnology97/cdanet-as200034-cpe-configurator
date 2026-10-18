import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { escapeHtml } from '../services/telegram.ts';

/**
 * Gruppi di lavoro (issue #275): the admins, and the «direttore tecnico» (a specialist with
 * «visibilità piena»), make the groups of specialists that share templates, installation history
 * and calendar; a specialist reads only the groups he is in. Who is a specialist and who has
 * «visibilità piena» stays with the admins (Account).
 */
export function workGroupRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireSeesAll };
  const idParam = z.object({ id: z.coerce.number().int().positive() });
  const body = z
    .object({
      name: z.string().trim().min(1).max(80),
      notes: z.string().trim().max(500).optional(),
      members: z.array(z.number().int().positive()).max(200).optional(),
    })
    .strict();
  const names = (ids: number[]) =>
    ids.map((id) => (ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined)?.username ?? `#${id}`).join(', ');
  /** Who sees whose work changes: the NOC hears of it, like «visibilità piena». */
  const tell = (by: string, group: string, what: string) =>
    ctx.notify.security(`Gruppo di lavoro <b>${escapeHtml(group)}</b>: ${what} (da ${escapeHtml(by)})`);

  app.get('/api/admin/work-groups', admin, async () => ({ items: ctx.workGroups.list(), specialists: ctx.workGroups.specialists() }));

  app.post('/api/admin/work-groups', admin, async (req, reply) => {
    const b = body.parse(req.body);
    const g = ctx.workGroups.create(b, req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'work_group.create', g.name, g.members.length ? `membri: ${g.members.map((m) => m.username).join(', ')}` : 'senza membri');
    if (g.members.length) tell(req.user!.username, g.name, `creato con ${escapeHtml(g.members.map((m) => m.username).join(', '))}`);
    return reply.code(201).send(g);
  });

  app.put('/api/admin/work-groups/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = body.partial().parse(req.body);
    const r = ctx.workGroups.update(id, b);
    const detail = [r.added.length ? `entrati: ${names(r.added)}` : '', r.removed.length ? `usciti: ${names(r.removed)}` : '', b.name !== undefined ? 'nome' : '', b.notes !== undefined ? 'note' : '']
      .filter(Boolean)
      .join(' · ');
    recordEvent(ctx.db, req.user!.id, 'work_group.update', r.group.name, detail || 'nessuna modifica');
    const moved = [r.added.length ? `entrati ${escapeHtml(names(r.added))}` : '', r.removed.length ? `usciti ${escapeHtml(names(r.removed))}` : ''].filter(Boolean).join(', ');
    if (moved) tell(req.user!.username, r.group.name, moved);
    return r.group;
  });

  app.delete('/api/admin/work-groups/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const members = ctx.workGroups.get(id).members.length;
    const g = ctx.workGroups.remove(id);
    recordEvent(ctx.db, req.user!.id, 'work_group.delete', g.name, 'gruppo eliminato: template e installazioni restano ai loro autori');
    if (members) tell(req.user!.username, g.name, `eliminato (${members === 1 ? '1 membro' : `${members} membri`})`);
    return { ok: true };
  });

  /** The specialist: his groups and their members (names only). */
  app.get('/api/specialist/work-groups', { preHandler: ctx.auth.requireSpecialist }, async (req) => ({
    items: ctx.workGroups.ofUser(req.user!.id).map((g) => ({ id: g.id, name: g.name, members: g.members.filter((m) => m.active).map((m) => ({ id: m.id, username: m.username })) })),
  }));
}
