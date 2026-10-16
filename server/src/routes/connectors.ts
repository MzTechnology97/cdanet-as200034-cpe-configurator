import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { isPublicNominatim } from '../services/geocode.ts';
import { KEY_FORMAT, PROVIDERS, type Provider } from '../services/imagery.ts';
import { TELEGRAM_EVENTS } from '../services/telegram.ts';

/** Admin "Connettori": configure and test external integrations from the console. */
export function connectorRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };
  const tg = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('telegram')] };
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
      /** App key of the UISP CRM (new subscribers); empty = keep the saved one. */
      crmKey: z.string().trim().max(400).optional(),
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
    telegram: ctx.modules.enabled('telegram') ? { ...ctx.telegram.view(), publicUrl: ctx.cfg.publicUrl ?? '' } : null,
    crm: ctx.crm.view(),
    victron: ctx.victron.view(),
    mywic: ctx.mywic.view(),
    nas: ctx.nas.view(),
    imagery: ctx.imagery.view(),
    firebase: ctx.push.view(),
  }));

  // Firebase Cloud Messaging: the push notifications of the app. The two files of the Firebase
  // project are pasted as text; the service account's private key is sealed, never returned.
  const firebaseBody = z
    .object({
      enabled: z.boolean(),
      serviceAccount: z.string().trim().max(8000).optional(),
      googleServices: z.string().trim().max(20000).optional(),
    })
    .strict();

  app.put('/api/admin/connectors/firebase', admin, async (req) => {
    const b = firebaseBody.parse(req.body);
    const v = ctx.push.save({ enabled: b.enabled, serviceAccount: b.serviceAccount || undefined, googleServices: b.googleServices || undefined }, req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'connector.firebase.update', v.projectId || '—', `${v.enabled ? 'attivo' : 'disattivato'}${b.serviceAccount ? ' · nuovo service account' : ''}`);
    return v;
  });

  app.delete('/api/admin/connectors/firebase', admin, async (req) => {
    ctx.push.remove();
    recordEvent(ctx.db, req.user!.id, 'connector.firebase.delete', '—', 'Firebase rimosso');
    return ctx.push.view();
  });

  /** A test notification to the phones of the admin who asks (they must have opened the app once). */
  app.post('/api/admin/connectors/firebase/test', admin, async (req) => {
    if (!ctx.push.enabled()) throw new HttpError(409, 'firebase_not_configured');
    const sent = await ctx.push.send([req.user!.id], { title: 'Prova notifiche CDA Net', body: 'Se leggi questo messaggio, le notifiche push funzionano.', kind: 'test' });
    return { sent };
  });

  app.put('/api/admin/connectors/uisp', admin, async (req) => {
    const b = uispBody.parse(req.body);
    ctx.connectors.saveUisp({ ...b, token: b.token || undefined, crmKey: b.crmKey || undefined }, req.user!.id);
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

  // ---- Telegram -----------------------------------------------------------------------------
  const tgToken = z.string().trim().regex(/^\d{5,15}:[\w-]{30,60}$/, 'Token del bot non valido').optional();
  const chatId = z.string().trim().regex(/^(-?\d{3,20}|@[A-Za-z]\w{4,31})$/, 'Chat ID non valido');

  app.put('/api/admin/connectors/telegram', tg, async (req) => {
    const b = z
      .object({
        enabled: z.boolean(),
        token: tgToken.or(z.literal('')),
        chatId: chatId.or(z.literal('')),
        events: z.array(z.enum(TELEGRAM_EVENTS)).max(TELEGRAM_EVENTS.length),
        summaryHour: z.number().int().min(0).max(23).default(19),
        personal: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    ctx.telegram.save({ ...b, token: b.token || undefined }, req.user!.id);
    recordEvent(
      ctx.db,
      req.user!.id,
      'connector.telegram.update',
      b.chatId || '—',
      `${b.enabled ? 'NOC attivo' : 'NOC disattivato'} · personali ${b.personal === false ? 'no' : 'sì'} · ${b.events.join(', ')}${b.token ? ' · nuovo token' : ''}`,
    );
    return ctx.telegram.view();
  });

  app.delete('/api/admin/connectors/telegram', tg, async (req) => {
    ctx.telegram.reset();
    recordEvent(ctx.db, req.user!.id, 'connector.telegram.reset', 'Telegram', 'configurazione rimossa');
    return ctx.telegram.view();
  });

  const tokenOf = (t: string | undefined) => {
    const token = t || ctx.telegram.savedToken();
    if (!token) throw new HttpError(400, 'connector_incomplete');
    return token;
  };

  app.post('/api/admin/connectors/telegram/test', tg, async (req) => {
    const b = z.object({ token: tgToken.or(z.literal('')), chatId }).strict().parse(req.body);
    return ctx.telegram.test(tokenOf(b.token || undefined), b.chatId);
  });

  /** Groups/chats that wrote to the bot recently: to find the chat id without external tools. */
  app.post('/api/admin/connectors/telegram/chats', tg, async (req) => {
    const b = z.object({ token: tgToken.or(z.literal('')) }).strict().parse(req.body ?? {});
    return ctx.telegram.chats(tokenOf(b.token || undefined));
  });

  app.get('/api/admin/connectors/telegram/summary', tg, async () => ({ text: ctx.notify.summaryText() }));

  /** OpenStreetMap / Nominatim health (local container still importing shows here). */
  app.post('/api/admin/connectors/geocoder/test', admin, async () => ctx.geocoder.status());

  /** Tests the values in the form (token optional: the saved one is used) without saving them. */
  app.post('/api/admin/connectors/uisp/test', admin, async (req) => {
    const b = uispBody.partial({ enabled: true }).parse(req.body ?? {});
    const token = b.token || ctx.connectors.savedUispToken();
    if (!b.url || !token) throw new HttpError(400, 'connector_incomplete');
    const client = ctx.connectors.build({ url: b.url, token, ignoreTls: b.ignoreTls ?? false, cacheSeconds: 5 });
    // the CRM app key too, when typed or saved: the plans it can read (new subscribers at acceptance)
    const crmKey = b.crmKey || ctx.connectors.uispSettings()?.crmKey || null;
    const crmTest = async () => {
      if (!crmKey) return null;
      try {
        const plans = await ctx.connectors.crmWith(b.url!, crmKey, b.ignoreTls ?? false).servicePlans();
        return { ok: true, plans: plans.length };
      } catch (e) {
        return { ok: false, error: (e as HttpError).code ?? 'uisp_crm_error' };
      }
    };
    try {
      return { ...(await client.test()), crm: await crmTest() };
    } catch (e) {
      const err = e as HttpError;
      const detail = String(err.extra?.detail ?? '');
      const tls = /certificate|self[- ]signed|unable to verify|CERT_|SSL/i.test(detail);
      return { ok: false, error: tls ? 'uisp_tls_error' : (err.code ?? 'uisp_error'), status: err.extra?.status ?? null, detail: detail.slice(0, 200) };
    }
  });

  // ---- CRM (ISP Billing) ----------------------------------------------------------------------
  const crmBody = z
    .object({
      enabled: z.boolean(),
      url: z
        .string()
        .trim()
        .max(300)
        .regex(/^https:\/\/[^\s/$.?#][^\s]*$/i, 'Serve un indirizzo https://')
        .transform((v) => v.replace(/\/+(api(\/docs)?\/?)?$/i, '')), // accept the docs URL too
      apiId: z.string().trim().max(100).regex(/^[A-Za-z0-9._-]*$/, 'API ID non valido'),
      apiKey: z.string().trim().max(500).regex(/^[!-~]*$/, 'API key non valida').optional(),
    })
    .strict();

  app.put('/api/admin/connectors/crm', admin, async (req) => {
    const b = crmBody.parse(req.body);
    ctx.crm.save({ ...b, apiKey: b.apiKey || undefined }, req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'connector.crm.update', b.url, `${b.enabled ? 'attivo' : 'disattivato'} · API ID ${b.apiId || '—'}${b.apiKey ? ' · nuova chiave' : ''}`);
    return ctx.crm.view();
  });

  app.delete('/api/admin/connectors/crm', admin, async (req) => {
    ctx.crm.reset();
    recordEvent(ctx.db, req.user!.id, 'connector.crm.reset', 'CRM', 'configurazione rimossa');
    return ctx.crm.view();
  });

  /** Tests the values in the form (key optional: the saved one is used) without saving them. */
  app.post('/api/admin/connectors/crm/test', admin, async (req) => {
    const b = crmBody.partial({ enabled: true }).parse(req.body ?? {});
    const apiKey = b.apiKey || ctx.crm.savedKey();
    if (!b.url || !b.apiId || !apiKey) throw new HttpError(400, 'crm_incomplete');
    const r = await ctx.crm.build({ url: b.url, apiId: b.apiId, apiKey }).test();
    recordEvent(ctx.db, req.user!.id, 'connector.crm.test', b.url, 'modules' in r ? `${r.modules.filter((m) => m.ok).length}/${r.modules.length} moduli leggibili` : `errore ${r.error}`);
    return r;
  });

  // ---- Victron VRM: the solar and battery systems of the POPs (read only) --------------------------
  // A personal access token of a VRM user (VRM → Preferences → Integrations → Access tokens).
  const vrmBody = z
    .object({
      enabled: z.boolean(),
      token: z.string().trim().max(500).regex(/^[!-~]*$/, 'Token non valido').optional(),
    })
    .strict();

  app.put('/api/admin/connectors/victron', admin, async (req) => {
    const b = vrmBody.parse(req.body);
    ctx.victron.save({ enabled: b.enabled, token: b.token || undefined }, req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'connector.victron.update', 'Victron VRM', `${b.enabled ? 'attivo' : 'disattivato'}${b.token ? ' · nuovo token' : ''}`);
    return ctx.victron.view();
  });

  app.delete('/api/admin/connectors/victron', admin, async (req) => {
    ctx.victron.reset();
    recordEvent(ctx.db, req.user!.id, 'connector.victron.reset', 'Victron VRM', 'configurazione rimossa');
    return ctx.victron.view();
  });

  /** Tests the token in the form (or the saved one) without saving it: counts only, nothing written to VRM. */
  app.post('/api/admin/connectors/victron/test', admin, async (req) => {
    const b = vrmBody.partial({ enabled: true }).parse(req.body ?? {});
    const token = b.token || ctx.victron.savedToken();
    if (!token) throw new HttpError(400, 'vrm_incomplete');
    const r = await ctx.victron.build(token).test();
    recordEvent(ctx.db, req.user!.id, 'connector.victron.test', 'Victron VRM', r.ok ? `${r.installations} impianti · ${r.withAlarms} con allarmi · ${r.silent} senza dati da oltre un'ora` : `errore ${r.error}`);
    return r;
  });

  // ---- MyWic: coverage of the other operators (FTTH, FTTC, FWA), read only --------------------------
  // An API token generated in the MyWic dashboard («Generate API token»).
  const mywicBody = z
    .object({
      enabled: z.boolean(),
      token: z.string().trim().max(500).regex(/^[!-~]*$/, 'Token non valido').optional(),
    })
    .strict();

  app.put('/api/admin/connectors/mywic', admin, async (req) => {
    const b = mywicBody.parse(req.body);
    ctx.mywic.save({ enabled: b.enabled, token: b.token || undefined }, req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'connector.mywic.update', 'Copertura multi-operatore', `${b.enabled ? 'attivo' : 'disattivato'}${b.token ? ' · nuovo token' : ''}`);
    return ctx.mywic.view();
  });

  app.delete('/api/admin/connectors/mywic', admin, async (req) => {
    ctx.mywic.reset();
    recordEvent(ctx.db, req.user!.id, 'connector.mywic.reset', 'Copertura multi-operatore', 'configurazione rimossa');
    return ctx.mywic.view();
  });

  /** Tests the token in the form (or the saved one) without saving it: the operators and technologies it can check. */
  app.post('/api/admin/connectors/mywic/test', admin, async (req) => {
    const b = mywicBody.partial({ enabled: true }).parse(req.body ?? {});
    const token = b.token || ctx.mywic.savedToken();
    if (!token) throw new HttpError(400, 'mywic_incomplete');
    const r = await ctx.mywic.build(token).test();
    recordEvent(ctx.db, req.user!.id, 'connector.mywic.test', 'Copertura multi-operatore', r.ok ? `${r.providers?.length ?? 0} operatori leggibili` : `errore ${r.error}`);
    return r;
  });

  // ---- Immagini satellitari: one or more providers for the admins' maps --------------------------
  const NAMES: Record<Provider, string> = { mapbox: 'Mapbox', esri: 'Esri', google: 'Google', wms: 'Ortofoto WMS' };
  const providerOf = (req: { params: unknown }) => z.enum(PROVIDERS).parse((req.params as { provider: string }).provider);
  const keyField = (p: Provider) =>
    z
      .string()
      .trim()
      .max(600)
      .refine((v) => v === '' || p === 'wms' || KEY_FORMAT[p].test(v), `Chiave ${NAMES[p]} non valida`);
  const httpUrl = z
    .string()
    .trim()
    .max(500)
    .refine((v) => /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(v), 'URL non valido');
  const imageryBody = (p: Provider) =>
    z
      .object({
        enabled: z.boolean(),
        key: keyField(p).optional(),
        url: httpUrl.optional(),
        layers: z.string().trim().max(300).regex(/^[A-Za-z0-9_.:,\- ]*$/, 'Layer non validi').optional(),
        label: z.string().trim().max(60).optional(),
        attribution: z.string().trim().max(200).optional(),
      })
      .strict();

  app.put('/api/admin/connectors/imagery/:provider', admin, async (req) => {
    const p = providerOf(req);
    const b = imageryBody(p).parse(req.body);
    ctx.imagery.save(p, { ...b, key: b.key || undefined }, req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'connector.imagery.update', NAMES[p], `${b.enabled ? 'attivo' : 'disattivato'}${b.key ? ' · nuova chiave' : ''}${b.url ? ` · ${b.url.slice(0, 80)}` : ''}`);
    return ctx.imagery.view();
  });

  app.delete('/api/admin/connectors/imagery/:provider', admin, async (req) => {
    const p = providerOf(req);
    ctx.imagery.remove(p, req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'connector.imagery.reset', NAMES[p], 'configurazione rimossa');
    return ctx.imagery.view();
  });

  /** One tile with the values in the form (empty: the saved ones), without saving them. */
  app.post('/api/admin/connectors/imagery/:provider/test', admin, async (req) => {
    const p = providerOf(req);
    const b = imageryBody(p).partial({ enabled: true }).parse(req.body ?? {});
    const r = await ctx.imagery.test(p, { key: b.key || undefined, url: b.url, layers: b.layers });
    recordEvent(ctx.db, req.user!.id, 'connector.imagery.test', NAMES[p], r.ok ? 'immagini disponibili' : `errore ${r.error}`);
    return r;
  });
}
