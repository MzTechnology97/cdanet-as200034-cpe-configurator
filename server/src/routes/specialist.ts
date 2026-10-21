import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { applyForm, formFieldsView, readForm, skeletonFor, templateFacts } from '../domain/airos-form.ts';
import { autoTemplate } from '../domain/autotemplate.ts';
import { toCsv } from '../domain/csv.ts';
import { BOARD_MATCH_SUGGESTIONS, SUPPORTED_MODELS, TARGET_FIRMWARE, parseClientHeader, versionAtLeast } from '../domain/policy.ts';
import { freeCopyOfCdaTemplate, inspectFreeTemplate, SPECIALIST_PLACEHOLDERS } from '../domain/specialist-cfg.ts';
import { cpeMacSchema, cpeSerialSchema } from '../services/provisioning.ts';
import { DEFAULT_PARAMS } from '../services/templates.ts';

/**
 * «Specialist» (owner, 17/10/2026): the section of the specialist, who works on his own for other
 * companies. His airOS templates (the form of the CPE's web interface, apart from CDA Net's), the
 * connectors of those companies (their UISP), his installations: prepared here with what he types
 * for each CPE, written by the app, the optional acceptance test, the authorization of the CPE in
 * the company's UISP. Only the specialist who made them sees them.
 */
export function specialistRoutes(app: FastifyInstance, ctx: AppContext) {
  const spec = { preHandler: ctx.auth.requireSpecialist };
  const s = () => ctx.specialist;
  const me = (req: FastifyRequest) => req.user!;
  const log = (req: FastifyRequest, action: string, target: string, detail = '') => recordEvent(ctx.db, me(req).id, action, target, detail);
  /** The work groups of the specialist, for the log (issue #275): who shares this piece of work. */
  const groups = (req: FastifyRequest) => {
    const names = ctx.workGroups.ofUser(me(req).id).map((g) => g.name);
    return names.length ? `gruppo ${names.join(', ')}` : '';
  };
  const detailOf = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' · ');

  const modelParam = z.object({ model: z.enum(SUPPORTED_MODELS) });
  const idParam = z.object({ id: z.coerce.number().int().positive() });
  const jobParam = z.object({ id: z.string().uuid() });
  const templateName = z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} ._()+\/'&,·-]+$/u, 'Caratteri non ammessi nel nome');
  const templateText = z.string().min(64).max(300_000);
  const boardMatch = z.string().trim().min(2).max(240);
  const notes = z.string().trim().max(500);
  const formError = (e: unknown): never => {
    const m = (e as Error).message;
    throw /^form_/.test(m) ? new HttpError(400, m) : e;
  };
  /** The form of a text, in the specialist's mode: the text is the whole truth. */
  const formOf = (model: (typeof SUPPORTED_MODELS)[number], template: string) => {
    const { values, missing } = readForm(template, DEFAULT_PARAMS, model, { free: true });
    return { template, values, missing, facts: templateFacts(template), report: inspectFreeTemplate(template) };
  };

  // ---- the form of the templates ----------------------------------------------------------------
  /** The fields (like the CPE's web interface), the placeholders and how each is filled, the models. */
  app.get('/api/specialist/template-form', spec, async () => ({
    fields: formFieldsView({ free: true }),
    placeholders: Object.entries(SPECIALIST_PLACEHOLDERS).map(([name, p]) => ({ name, ...p })),
    models: SUPPORTED_MODELS,
    boardMatch: BOARD_MATCH_SUGGESTIONS,
    targetFirmware: TARGET_FIRMWARE,
  }));

  /** The form of a text; without a text, a new template from the form alone (nothing stored). */
  app.post('/api/specialist/form/:model/read', spec, async (req) => {
    const { model } = modelParam.parse(req.params);
    const b = z.object({ template: templateText.optional() }).strict().parse(req.body ?? {});
    return formOf(model, b.template ?? skeletonFor(model));
  });

  /** The form's changes written into the text (only what changed): nothing is stored here. */
  app.post('/api/specialist/form/:model/apply', spec, async (req) => {
    const { model } = modelParam.parse(req.params);
    const b = z
      .object({ template: templateText, changes: z.record(z.string().max(40), z.union([z.string().max(300), z.number(), z.boolean()])) })
      .strict()
      .parse(req.body);
    let out: ReturnType<typeof applyForm>;
    try {
      out = applyForm(b.template, DEFAULT_PARAMS, model, b.changes, { free: true });
    } catch (e) {
      return formError(e);
    }
    return formOf(model, out.text);
  });

  /** A backup of a CPE (or its running configuration, read by the app) made a template: nothing stored. */
  app.post('/api/specialist/form/:model/autotemplate', spec, async (req) => {
    const { model } = modelParam.parse(req.params);
    const b = z.object({ backup: templateText }).strict().parse(req.body);
    const result = autoTemplate(b.backup);
    return { ...result, ...formOf(model, result.template), suggestedBoardMatch: BOARD_MATCH_SUGGESTIONS[model] };
  });

  // ---- templates ---------------------------------------------------------------------------------
  app.get('/api/specialist/templates', spec, async (req) => s().templates.list(me(req).id));

  app.get('/api/specialist/templates/:id', spec, async (req) => s().templates.get(me(req).id, idParam.parse(req.params).id));

  app.post('/api/specialist/templates', spec, async (req, reply) => {
    const b = z
      .object({
        model: z.enum(SUPPORTED_MODELS),
        name: templateName,
        template: templateText,
        boardMatch: boardMatch.optional(),
        notes: notes.optional(),
        snmpCommunity: z.string().max(200).nullable().optional(),
        /** The Wi-Fi key of the company's AP: sealed, never returned, used only in his installations. */
        wpa2Psk: z.string().max(64).nullable().optional(),
      })
      .strict()
      .parse(req.body);
    const t = s().templates.create(me(req).id, b);
    log(req, 'specialist.template_create', `${t.model} · ${t.name}`, detailOf(t.sha256, groups(req)));
    return reply.code(201).send(t);
  });

  /** A CDA Net template as the start of one of his own: the copy is his, the original stays as it is. */
  app.post('/api/specialist/templates/copy', spec, async (req, reply) => {
    const b = z.object({ fromId: z.number().int().positive(), name: templateName }).strict().parse(req.body);
    // only a CDA Net template he may use (all of them with «visibilità piena», issue #275)
    if (!ctx.templates.visibleTo(req.user!).some((t) => t.id === b.fromId)) throw new HttpError(404, 'template_not_found');
    const src = ctx.templates.get(b.fromId);
    const t = s().templates.create(me(req).id, {
      model: src.model,
      name: b.name,
      template: freeCopyOfCdaTemplate(src.template, src.params),
      boardMatch: src.boardMatch,
      notes: `Copia del template CDA Net «${src.name}»`,
      cdaSourceId: src.id,
    });
    log(req, 'specialist.template_copy', `${t.model} · ${t.name}`, detailOf(`da CDA Net «${src.name}»`, groups(req)));
    return reply.code(201).send(t);
  });

  app.patch('/api/specialist/templates/:id', spec, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({ name: templateName.optional(), template: templateText.optional(), boardMatch: boardMatch.optional(), notes: notes.optional(), snmpCommunity: z.string().max(200).nullable().optional(), wpa2Psk: z.string().max(64).nullable().optional() })
      .strict()
      .refine((x) => Object.keys(x).length > 0, 'empty')
      .parse(req.body);
    const t = s().templates.update(me(req).id, id, b);
    // the keys changed, never the values (the community least of all)
    log(req, b.template ? 'specialist.template_edit' : 'specialist.template_update', `${t.model} · ${t.name}`, detailOf(Object.keys(b).join(','), t.mine ? '' : `template di ${t.author}`, groups(req)));
    return t;
  });

  app.delete('/api/specialist/templates/:id', spec, async (req) => {
    const t = s().templates.remove(me(req).id, idParam.parse(req.params).id);
    log(req, 'specialist.template_delete', `${t.model} · ${t.name}`, groups(req));
    return { ok: true };
  });

  // ---- connectors (the companies' UISP; other kinds later) ------------------------------------------
  const url = z
    .string()
    .trim()
    .max(300)
    // no query, fragment or user: nothing to steer the path the server appends (issue #275)
    .regex(/^https?:\/\/[^\s/$.?#@][^\s?#@]*$/i, 'URL non valido')
    .transform((v) => v.replace(/\/+(nms(\/api(\/v2\.1)?)?\/?)?$/i, '').replace(/\/+$/, ''));
  const token = z.string().trim().max(400);
  const uispKey = z.string().trim().max(2000);
  const connectorName = z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} ._()+\/'&,·-]+$/u, 'Caratteri non ammessi nel nome');

  app.get('/api/specialist/connectors', spec, async (req) => ({ kinds: [{ kind: 'uisp', label: 'UISP' }], items: s().connectors.list(me(req).id) }));

  app.post('/api/specialist/connectors', spec, async (req, reply) => {
    const b = z
      .object({ kind: z.literal('uisp').default('uisp'), name: connectorName, url, token: token.min(8), uispKey: uispKey.optional(), ignoreTls: z.boolean().default(false), enabled: z.boolean().default(true) })
      .strict()
      .parse(req.body);
    const c = s().connectors.create(me(req).id, { name: b.name, url: b.url, token: b.token, ignoreTls: b.ignoreTls, enabled: b.enabled, ...(b.uispKey ? { uispKey: b.uispKey } : {}) });
    log(req, 'specialist.connector_create', `UISP · ${c.name}`, c.url);
    return reply.code(201).send(c);
  });

  app.patch('/api/specialist/connectors/:id', spec, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({ name: connectorName.optional(), url: url.optional(), token: token.optional(), uispKey: uispKey.nullable().optional(), ignoreTls: z.boolean().optional(), enabled: z.boolean().optional() })
      .strict()
      .refine((x) => Object.keys(x).length > 0, 'empty')
      .parse(req.body);
    const c = s().connectors.update(me(req).id, id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.url !== undefined ? { url: b.url } : {}),
      ...(b.token ? { token: b.token } : {}),
      ...(b.uispKey !== undefined ? { uispKey: b.uispKey === '' ? undefined : b.uispKey } : {}),
      ...(b.ignoreTls !== undefined ? { ignoreTls: b.ignoreTls } : {}),
      ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
    });
    log(req, 'specialist.connector_update', `UISP · ${c.name}`, Object.keys(b).join(','));
    return c;
  });

  app.delete('/api/specialist/connectors/:id', spec, async (req) => {
    const c = s().connectors.remove(me(req).id, idParam.parse(req.params).id);
    log(req, 'specialist.connector_delete', `UISP · ${c.name}`);
    return { ok: true };
  });

  /** Tests the values of the form (token empty: the saved one) without saving them. */
  app.post('/api/specialist/connectors/test', spec, async (req) => {
    const b = z.object({ id: z.number().int().positive().optional(), url: url.optional(), token: token.optional(), ignoreTls: z.boolean().optional() }).strict().parse(req.body ?? {});
    return s().connectors.test(me(req).id, b);
  });

  /** Tests a saved connector (the outcome stays with it). */
  app.post('/api/specialist/connectors/:id/test', spec, async (req) => s().connectors.test(me(req).id, { id: idParam.parse(req.params).id }));

  app.get('/api/specialist/connectors/:id/sites', spec, async (req) => s().connectors.sites(me(req).id, idParam.parse(req.params).id));

  // ---- installations ------------------------------------------------------------------------------
  app.get('/api/specialist/summary', spec, async (req) => s().jobs.summary(me(req).id));

  /** What is typed for a template (and what the server fills in by itself). */
  app.get('/api/specialist/templates/:id/values', spec, async (req) => {
    const { id } = idParam.parse(req.params);
    const { connectorId } = z.object({ connectorId: z.coerce.number().int().positive().optional() }).parse(req.query);
    return s().jobs.form(me(req).id, id, connectorId ?? null);
  });

  const jobBody = z
    .object({
      templateId: z.number().int().positive(),
      connectorId: z.number().int().positive().nullable().optional(),
      company: z.string().trim().max(80).optional(),
      model: z.enum(SUPPORTED_MODELS),
      // absent: prepared before connecting to the CPE, MAC and serial come with the outcome
      mac: cpeMacSchema.optional(),
      serial: cpeSerialSchema.optional(),
      firmware: z.string().trim().max(80).optional(),
      host: z.string().trim().max(64).optional(),
      sshPort: z.number().int().min(1).max(65535).optional(),
      cpe: z
        .object({
          username: z.string().trim().min(1).max(64).regex(/^[\x21-\x7e]+$/, 'Utente non valido'),
          password: z.string().min(1).max(200).regex(/^[^\r\n\0]+$/, 'Password non valida'),
        })
        .strict(),
      values: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/), z.string().max(4096)).default({}),
      customer: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(1000).optional(),
      location: z
        .object({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          accuracy: z.number().min(0).max(100_000).optional(),
          source: z.enum(['gps', 'address', 'manual']),
        })
        .strict()
        .optional(),
    })
    .strict();

  /**
   * Prepares the configuration of a CPE: only the app (which writes it over SSH) may ask for it.
   * The answer carries what was typed (Wi-Fi key, passwords) back to the phone, nothing is kept.
   */
  app.post('/api/specialist/jobs', spec, async (req, reply) => {
    const client = parseClientHeader(req.headers['x-cda-client'] as string | undefined);
    if (!client) throw new HttpError(403, 'trusted_client_required');
    if (!versionAtLeast(client.version, ctx.cfg.minAndroidVersion)) throw new HttpError(426, 'client_upgrade_required', { minVersion: ctx.cfg.minAndroidVersion });
    const b = jobBody.parse(req.body);
    const pkg = s().jobs.create(me(req), b, `${client.platform}/${client.version}`);
    // with a template of another member: whose it was (issue #275)
    const tpl = s().templates.get(me(req).id, b.templateId);
    log(req, 'specialist.job', `${b.model} · ${b.mac ?? 'CPE letta alla scrittura'}`, detailOf(pkg.summary.template, tpl.mine ? '' : `template di ${tpl.author}`, b.customer, pkg.summary.deviceName, groups(req)));
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(pkg);
  });

  const resultBody = z
    .object({
      result: z.enum(['success', 'failed']),
      stages: z.array(z.string().max(200)).max(40).default([]),
      error: z.string().max(1000).optional().default(''),
      detected: z.object({ firmware: z.string().max(80).optional(), board: z.string().max(120).optional(), mac: z.string().max(40).optional() }).strict().optional().default({}),
      completedAt: z.string().datetime().optional(),
      // the CPE read at the write, for a configuration prepared before connecting to it
      cpe: z.object({ mac: cpeMacSchema, serial: cpeSerialSchema.optional() }).strict().optional(),
    })
    .strict();

  app.post('/api/specialist/jobs/:id/result', spec, async (req) => {
    const { id } = jobParam.parse(req.params);
    const r = s().jobs.result(me(req).id, id, resultBody.parse(req.body));
    if (!r.duplicate) {
      const j = s().jobs.get(me(req).id, id);
      log(req, j.status === 'success' ? 'specialist.job_written' : 'specialist.job_failed', `${j.model} · ${j.mac || 'CPE non letta'}`, j.status === 'success' ? (j.customer || j.deviceName) : j.error.slice(0, 200));
    }
    return r;
  });

  const num = (max: number) => z.number().min(-max).max(max);
  const acceptanceBody = z
    .object({
      verdict: z.enum(['ok', 'warn', 'bad']),
      radio: z
        .object({
          signal: num(200).optional(),
          noise: num(200).optional(),
          ccq: z.number().min(0).max(100).optional(),
          txRate: z.number().min(0).max(100_000).optional(),
          rxRate: z.number().min(0).max(100_000).optional(),
          capacityDown: z.number().min(0).max(100_000).optional(),
          capacityUp: z.number().min(0).max(100_000).optional(),
          distanceM: z.number().min(0).max(1_000_000).optional(),
          frequency: z.number().min(0).max(100_000).optional(),
          channelWidth: z.number().min(0).max(1_000).optional(),
          ssid: z.string().max(64).optional(),
          apName: z.string().max(120).optional(),
          apMac: z.string().max(40).optional(),
        })
        .strict()
        .optional(),
      speedtest: z
        .object({ downMbps: z.number().min(0).max(100_000), upMbps: z.number().min(0).max(100_000), pingMs: z.number().min(0).max(100_000).optional(), jitterMs: z.number().min(0).max(100_000).optional(), server: z.string().max(200).optional() })
        .strict()
        .optional(),
      heightM: z.number().min(0).max(500).optional(),
      notes: z.string().trim().max(1000).optional(),
    })
    .strict();

  /** The optional acceptance test: the specialist's own judgment, no NOC. */
  app.put('/api/specialist/jobs/:id/acceptance', spec, async (req) => {
    const { id } = jobParam.parse(req.params);
    const j = s().jobs.acceptance(me(req).id, id, acceptanceBody.parse(req.body));
    log(req, 'specialist.acceptance', `${j.model} · ${j.mac}`, String((j.acceptance as { verdict?: string } | null)?.verdict ?? ''));
    return j;
  });

  app.delete('/api/specialist/jobs/:id/acceptance', spec, async (req) => s().jobs.clearAcceptance(me(req).id, jobParam.parse(req.params).id));

  const listQuery = z.object({
    q: z.string().trim().max(100).optional(),
    status: z.enum(['prepared', 'success', 'failed', 'to_authorize', 'no_acceptance']).optional(),
    connectorId: z.coerce.number().int().positive().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });
  const range = (q: { from?: string | undefined; to?: string | undefined }) => ({
    from: q.from ? `${q.from}T00:00:00.000Z` : undefined,
    to: q.to ? new Date(Date.parse(`${q.to}T00:00:00.000Z`) + 86400_000).toISOString() : undefined,
  });

  app.get('/api/specialist/jobs', spec, async (req) => {
    const q = listQuery.parse(req.query);
    return s().jobs.list(me(req).id, { ...q, ...range(q) });
  });

  /** The history as CSV for Excel (Italian locale: ';', UTF-8 BOM). */
  app.get('/api/specialist/jobs.csv', spec, async (req, reply) => {
    const q = listQuery.extend({ limit: z.coerce.number().int().min(1).max(20000).default(5000) }).parse(req.query);
    const { items } = s().jobs.list(me(req).id, { ...q, ...range(q) });
    const esito: Record<string, string> = { success: 'scritta', failed: 'non riuscita', prepared: 'preparata' };
    const collaudo: Record<string, string> = { ok: 'buono', warn: 'con riserva', bad: 'non buono' };
    const rows = items.map((j) => {
      const a = j.acceptance as { verdict?: string; radio?: { signal?: number }; speedtest?: { downMbps?: number; upMbps?: number } } | null;
      return [
        j.createdAt,
        j.author,
        esito[j.status] ?? j.status,
        j.company,
        j.customer,
        j.deviceName,
        j.model,
        j.template,
        j.mac,
        j.serial,
        j.firmware,
        j.ssid,
        j.pppoeUser,
        a?.verdict ? (collaudo[a.verdict] ?? a.verdict) : '',
        a?.radio?.signal ?? '',
        a?.speedtest?.downMbps ?? '',
        a?.speedtest?.upMbps ?? '',
        j.uisp.site,
        // written without the company's key: nothing to authorize
        j.uisp.off ? 'UISP spento' : (j.uisp.authorizedAt ?? ''),
        j.location?.lat ?? '',
        j.location?.lon ?? '',
        j.notes,
        j.error,
      ];
    });
    log(req, 'specialist.export', `${rows.length} righe`, [q.status, q.q, q.from, q.to].filter(Boolean).join(' · '));
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="storico-specialist-${new Date().toISOString().slice(0, 10)}.csv"`);
    return (
      '﻿' +
      toCsv([
        ['Data', 'Specialist', 'Esito', 'Azienda', 'Cliente', 'Nome CPE', 'Modello', 'Template', 'MAC', 'Seriale', 'Firmware', 'SSID', 'Utente PPPoE', 'Collaudo', 'Segnale', 'Download Mbit/s', 'Upload Mbit/s', 'Site UISP', 'Autorizzata in UISP', 'Latitudine', 'Longitudine', 'Note', 'Errore'],
        ...rows,
      ])
    );
  });

  app.get('/api/specialist/jobs/:id', spec, async (req) => s().jobs.get(me(req).id, jobParam.parse(req.params).id));

  app.delete('/api/specialist/jobs/:id', spec, async (req) => {
    const j = s().jobs.remove(me(req).id, jobParam.parse(req.params).id);
    log(req, 'specialist.job_delete', `${j.model} · ${j.mac}`, j.customer || j.deviceName);
    return { ok: true };
  });

  /** The CPE in the company's UISP: found by MAC, authorized or not, and the site of its AP. */
  app.get('/api/specialist/jobs/:id/uisp', spec, async (req) => s().jobs.uispState(me(req).id, jobParam.parse(req.params).id));

  /** Authorizes the installed CPE in the company's UISP (the site chosen, else the one of its AP). */
  app.post('/api/specialist/jobs/:id/uisp/authorize', spec, async (req) => {
    const { id } = jobParam.parse(req.params);
    const b = z.object({ siteId: z.string().min(1).max(100).optional() }).strict().parse(req.body ?? {});
    const r = await s().jobs.authorize(me(req).id, id, b.siteId);
    log(req, 'specialist.uisp_authorize', `${r.job.deviceName || r.job.mac} → ${r.site}`, r.job.company);
    return r;
  });
}
