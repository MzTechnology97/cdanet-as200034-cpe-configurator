import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { isPublicNominatim } from '../services/geocode.ts';

/** Admin "Connettori": configure and test external integrations from the console. */
export function connectorRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };
  const url = z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === '' || /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v), 'URL non valido')
    .transform((v) => v.replace(/\/+(nms(\/api(\/v2\.1)?)?\/?)?$/i, '')); // accept a pasted API URL too
  const uispBody = z
    .object({
      enabled: z.boolean(),
      url,
      token: z.string().trim().max(400).optional(),
      ignoreTls: z.boolean().default(false),
      autoBackup: z.boolean().default(true),
      coverageMaxKm: z.number().int().min(1).max(100).default(15),
      cacheSeconds: z.number().int().min(5).max(3600).default(60),
    })
    .strict();

  /** Applies the saved configuration to the running server (no restart needed). */
  const reload = () => {
    const s = ctx.connectors.uispSettings();
    ctx.uisp = s ? ctx.connectors.build(s) : null;
    ctx.uispSettings = { autoBackup: s?.autoBackup ?? ctx.cfg.uispAutoBackup, coverageMaxKm: s?.coverageMaxKm ?? ctx.cfg.coverageMaxKm };
  };

  app.get('/api/admin/connectors', admin, async () => ({
    uisp: { ...ctx.connectors.uispView(), active: !!ctx.uisp },
    geocoder: {
      url: ctx.cfg.geocoder.url,
      local: !isPublicNominatim(ctx.cfg.geocoder.url),
      fallbackUrl: ctx.cfg.geocoder.fallbackUrl ?? '',
      contact: ctx.cfg.geocoder.contact ?? '',
    },
  }));

  app.put('/api/admin/connectors/uisp', admin, async (req) => {
    const b = uispBody.parse(req.body);
    ctx.connectors.saveUisp({ ...b, token: b.token || undefined }, req.user!.id);
    reload();
    recordEvent(ctx.db, req.user!.id, 'connector.uisp.update', b.url || '—', `${b.enabled ? 'attivo' : 'disattivato'}${b.ignoreTls ? ' · TLS non verificato' : ''}${b.token ? ' · nuovo token' : ''}`);
    return { ...ctx.connectors.uispView(), active: !!ctx.uisp };
  });

  app.delete('/api/admin/connectors/uisp', admin, async (req) => {
    ctx.connectors.resetUisp();
    reload();
    recordEvent(ctx.db, req.user!.id, 'connector.uisp.reset', 'UISP', 'tornato alla configurazione .env');
    return { ...ctx.connectors.uispView(), active: !!ctx.uisp };
  });

  /** OpenStreetMap / Nominatim health (local container still importing shows here). */
  app.post('/api/admin/connectors/geocoder/test', admin, async () => ctx.geocoder.status());

  /** Tests the values in the form (token optional: the saved one is used) without saving them. */
  app.post('/api/admin/connectors/uisp/test', admin, async (req) => {
    const b = uispBody.partial({ enabled: true }).parse(req.body ?? {});
    const token = b.token || ctx.connectors.savedUispToken();
    if (!b.url || !token) throw new HttpError(400, 'connector_incomplete');
    const client = ctx.connectors.build({ url: b.url, token, ignoreTls: b.ignoreTls ?? false, cacheSeconds: 5 });
    try {
      return await client.test();
    } catch (e) {
      const err = e as HttpError;
      const detail = String(err.extra?.detail ?? '');
      const tls = /certificate|self[- ]signed|unable to verify|CERT_|SSL/i.test(detail);
      return { ok: false, error: tls ? 'uisp_tls_error' : (err.code ?? 'uisp_error'), status: err.extra?.status ?? null, detail: detail.slice(0, 200) };
    }
  });
}
