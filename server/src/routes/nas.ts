import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';

/**
 * Connettori → NAS (admins): the network path recognized and browsed on the NAS (to choose the
 * folder from the console), a new folder, the connection test with a write, the configuration with
 * the nightly backup, a backup now, the copies on the NAS and the restore test of one of them.
 * The NAS password typed in the form is used for the request only; the saved one never comes back.
 */
export function nasRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };
  const text = (max: number) => z.string().trim().max(max).refine((v) => !/[\r\n\0]/.test(v), 'Caratteri non ammessi');
  // the NAS account as typed (empty password: the saved one, for the same user)
  const account = {
    path: text(500).min(3, 'Scrivi il percorso di rete del NAS'),
    username: text(128).optional(),
    password: z.string().max(256).refine((v) => !/[\r\n\0]/.test(v), 'Caratteri non ammessi').optional(),
    domain: text(128).optional(),
  };
  const credOf = (b: { path: string; username?: string | undefined; password?: string | undefined; domain?: string | undefined }) => ctx.nas.cred(b);

  app.post('/api/admin/connectors/nas/browse', admin, async (req) => {
    const b = z.object(account).strict().parse(req.body);
    return ctx.nas.probe(b.path, credOf(b));
  });

  app.post('/api/admin/connectors/nas/mkdir', admin, async (req) => {
    const b = z
      .object({ ...account, name: text(255).min(1) })
      .strict()
      .parse(req.body);
    const r = await ctx.nas.mkdir(b.path, b.name, credOf(b));
    recordEvent(ctx.db, req.user!.id, 'nas.mkdir', r.path, 'cartella creata sul NAS');
    return r;
  });

  app.post('/api/admin/connectors/nas/test', admin, async (req) => {
    const b = z.object(account).strict().parse(req.body);
    try {
      const r = await ctx.nas.test(b.path, credOf(b));
      recordEvent(ctx.db, req.user!.id, 'connector.nas.test', r.path, r.writable ? 'scrittura riuscita' : r.exists ? 'cartella in sola lettura' : 'cartella da creare');
      return { ok: true, ...r };
    } catch (e) {
      const err = e as HttpError;
      if (!err.code) throw e;
      recordEvent(ctx.db, req.user!.id, 'connector.nas.test', b.path, `errore ${err.code}`);
      return { ok: false, error: err.code, ...(err.extra ?? {}) };
    }
  });

  app.put('/api/admin/connectors/nas', admin, async (req) => {
    const b = z
      .object({
        enabled: z.boolean(),
        path: account.path,
        username: text(128).default(''),
        password: account.password,
        domain: text(128).default(''),
        backupPassword: z.string().min(12, 'Password del backup: almeno 12 caratteri').max(200).or(z.literal('')).optional(),
        includeKey: z.boolean().default(false),
        hour: z.number().int().min(0).max(23).default(3),
        keep: z.number().int().min(1).max(365).default(14),
      })
      .strict()
      .parse(req.body);
    ctx.nas.save({ ...b, password: b.password || undefined, backupPassword: b.backupPassword || undefined }, req.user!.id);
    const v = ctx.nas.view();
    recordEvent(
      ctx.db,
      req.user!.id,
      'connector.nas.update',
      v.path,
      `${b.enabled ? `backup ogni notte alle ${b.hour}:00` : 'backup automatico spento'} · tiene ${b.keep} copie${b.includeKey ? ' · con la chiave principale' : ''}${b.password ? ' · nuova password NAS' : ''}${b.backupPassword ? ' · nuova password del backup' : ''}`,
    );
    return v;
  });

  app.delete('/api/admin/connectors/nas', admin, async (req) => {
    ctx.nas.reset();
    recordEvent(ctx.db, req.user!.id, 'connector.nas.reset', 'NAS', 'configurazione rimossa (i backup sul NAS restano)');
    return ctx.nas.view();
  });

  app.post('/api/admin/connectors/nas/run', admin, async (req) => ctx.nas.run(req.user!.id));

  app.get('/api/admin/connectors/nas/files', admin, async () => ctx.nas.files());

  app.post('/api/admin/connectors/nas/verify', admin, async (req) => {
    const b = z
      .object({ file: z.string().max(80).optional() })
      .strict()
      .parse(req.body ?? {});
    const r = await ctx.nas.verify(b.file);
    recordEvent(ctx.db, req.user!.id, 'nas.verify', r.file, r.ok ? 'backup integro' : `backup danneggiato: ${r.integrity}`);
    return r;
  });
}
