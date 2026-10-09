import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { HttpError, createAuth } from './auth.ts';
import type { Config } from './config.ts';
import type { AppContext } from './context.ts';
import { createSealer, hashPassword } from './crypto.ts';
import { nowIso, openDatabase, type Db } from './db.ts';
import { adminRoutes } from './routes/admin.ts';
import { acceptanceRoutes } from './routes/acceptance.ts';
import { fieldRoutes } from './routes/field.ts';
import { provisioningRoutes } from './routes/provisioning.ts';
import { replaceRoutes } from './routes/replace.ts';
import { outageRoutes } from './routes/outages.ts';
import { statsRoutes } from './routes/stats.ts';
import { publicRoutes } from './routes/public.ts';
import { toolRoutes } from './routes/tools.ts';
import { createProvisioning } from './services/provisioning.ts';
import { createTemplates } from './services/templates.ts';
import { createGeocoder } from './services/geocode.ts';
import { createModules } from './services/modules.ts';
import { createOui } from './services/oui.ts';
import { createOutages, type Outages } from './services/outages.ts';
import { createNotifier, type Notifier } from './services/notify.ts';
import { createTelegram } from './services/telegram.ts';
import type { Uisp } from './services/uisp.ts';
import { createConnectors } from './services/connectors.ts';
import { connectorRoutes } from './routes/connectors.ts';
import { uispRoutes } from './routes/uisp.ts';
import { mapRoutes } from './routes/map.ts';
import { networkRoutes } from './routes/network.ts';
import { pointingRoutes } from './routes/pointing.ts';
import { serverSettingsRoutes } from './routes/server-settings.ts';
import { createServerSettings } from './services/server-settings.ts';
import { createDem } from './services/dem.ts';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // OpenStreetMap tiles: map fallback when the local Protomaps basemap is not installed yet.
  "img-src 'self' data: https://tile.openstreetmap.org",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function ensureBootstrapAdmin(db: Db, cfg: Config): 'created' | 'exists' {
  const n = (db.prepare("SELECT count(*) n FROM users WHERE role = 'admin'").get() as { n: number }).n;
  if (n > 0) return 'exists';
  const p = cfg.bootstrapAdmin.password;
  if (!p || p.length < 14) throw new Error('First boot requires ADMIN_PASSWORD of at least 14 characters');
  db.prepare('INSERT INTO users(username, password_hash, role, created_at) VALUES(?,?,?,?)').run(
    cfg.bootstrapAdmin.username,
    hashPassword(p),
    'admin',
    nowIso(),
  );
  return 'created';
}

export async function buildApp(
  cfg: Config,
  version: string,
  opts: { db?: Db; logger?: boolean; uisp?: Uisp | null; fetchImpl?: typeof fetch; telegramIntervalMs?: number } = {},
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const db = opts.db ?? openDatabase(cfg.dbPath);
  ensureBootstrapAdmin(db, cfg);
  const sealer = createSealer(cfg.masterKey);
  // values set from the console override .env before anything reads them
  const serverSettings = createServerSettings(db, cfg, sealer);
  serverSettings.applyAll();
  const templates = createTemplates(db, sealer);
  const connectors = createConnectors(db, sealer, cfg, { fetchImpl: opts.fetchImpl });
  const uispCfg = connectors.uispSettings();
  const modules = createModules(db);
  const oui = createOui(cfg.ouiDir, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const telegram = createTelegram(db, sealer, { fetchImpl: opts.fetchImpl, ...(opts.telegramIntervalMs !== undefined ? { minIntervalMs: opts.telegramIntervalMs } : {}) });
  const ctx: AppContext = {
    cfg,
    db,
    sealer,
    auth: createAuth(db, cfg.jwtSecret, cfg.jwtTtlHours),
    provisioning: createProvisioning(db, cfg, sealer, templates),
    templates,
    uisp: opts.uisp !== undefined ? opts.uisp : uispCfg ? connectors.build(uispCfg) : null,
    uispSettings: { autoBackup: uispCfg?.autoBackup ?? cfg.uispAutoBackup, coverageMaxKm: uispCfg?.coverageMaxKm ?? cfg.coverageMaxKm },
    connectors,
    geocoder: createGeocoder({ ...cfg.geocoder, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
    telegram,
    modules,
    oui,
    outages: undefined as unknown as Outages,
    serverSettings,
    dem: createDem({ dir: cfg.dem.dir, baseUrl: cfg.dem.url, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
    notify: undefined as unknown as Notifier,
    version,
  };
  ctx.outages = createOutages(db, {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    getUisp: () => ctx.uisp,
    notify: (html) => {
      if (modules.enabled('telegram')) void telegram.notify('power_outage', html);
    },
    isOn: () => modules.enabled('power_outages') || (db.prepare("SELECT 1 FROM user_modules WHERE module = 'power_outages' AND enabled = 1 LIMIT 1").get() !== undefined),
    sendPersonal: (chatId, html) => {
      if (modules.enabled('telegram')) void telegram.sendTo(chatId, html);
    },
    userOn: (id) => modules.stateFor(id).power_outages,
  });
  ctx.notify = createNotifier(db, cfg, telegram, () => ctx.uisp, version, () => modules.enabled('telegram'));

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: cfg.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-cda-bridge-token"]'],
          },
    bodyLimit: 512 * 1024,
    trustProxy: cfg.trustProxy,
  });

  // Speed-test uploads: count bytes without buffering them.
  app.addContentTypeParser('application/octet-stream', { bodyLimit: 50 * 1024 * 1024 }, (_req, payload, done) => {
    let bytes = 0;
    payload.on('data', (c: Buffer) => (bytes += c.length));
    payload.on('end', () => done(null, { bytes }));
    payload.on('error', (e) => done(e, undefined));
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', reply.getHeader('Cache-Control') ?? 'no-store');
    else reply.header('Content-Security-Policy', CSP);
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, ...err.extra });
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'invalid_request',
        issues: err.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as { code?: string }).code ?? 'bad_request' });
    // Tool errors carry short, user-facing codes (e.g. target_non_privato); everything else is opaque.
    if (req.url.startsWith('/api/tools/') || req.url.startsWith('/api/routeros/')) {
      return reply.code(400).send({ error: (err as Error).message.slice(0, 300) });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  publicRoutes(app, ctx);
  provisioningRoutes(app, ctx);
  fieldRoutes(app, ctx);
  acceptanceRoutes(app, ctx);
  replaceRoutes(app, ctx);
  statsRoutes(app, ctx);
  outageRoutes(app, ctx);
  mapRoutes(app, ctx);
  networkRoutes(app, ctx);
  pointingRoutes(app, ctx);
  serverSettingsRoutes(app, ctx);
  adminRoutes(app, ctx);
  toolRoutes(app, ctx);
  uispRoutes(app, ctx);
  connectorRoutes(app, ctx);

  if (existsSync(join(cfg.staticDir, 'index.html'))) {
    // Revalidate on every load (ETag/Last-Modified): after an auto-update the console must never mix old and new assets.
    await app.register(fastifyStatic, {
      root: cfg.staticDir,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (reply) => {
        reply.header('Cache-Control', 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.method !== 'GET' || !existsSync(join(cfg.staticDir, 'index.html'))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });

  return { app, ctx };
}
