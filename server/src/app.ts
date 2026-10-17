import { existsSync, readFileSync } from 'node:fs';
import { MANAGEMENT_PORTS, parseClientHeader, versionAtLeast } from './domain/policy.ts';
import { loadLatestRelease } from './services/releases.ts';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { HttpError, createAuth } from './auth.ts';
import type { Config } from './config.ts';
import type { AppContext } from './context.ts';
import { createSealer, hashPassword } from './crypto.ts';
import { nowIso, openDatabase, recordEvent, type Db } from './db.ts';
import { adminRoutes } from './routes/admin.ts';
import { acceptanceRoutes } from './routes/acceptance.ts';
import { koRoutes } from './routes/ko.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { liveRoutes } from './routes/live.ts';
import { createLive } from './services/live.ts';
import { createPush } from './services/push.ts';
import { fieldRoutes } from './routes/field.ts';
import { provisioningRoutes } from './routes/provisioning.ts';
import { replaceRoutes } from './routes/replace.ts';
import { outageRoutes } from './routes/outages.ts';
import { statsRoutes } from './routes/stats.ts';
import { publicRoutes } from './routes/public.ts';
import { toolRoutes } from './routes/tools.ts';
import { createProvisioning, type Provisioning } from './services/provisioning.ts';
import { createTemplates, type LegacyValues, type Templates } from './services/templates.ts';
import { createGeocoder } from './services/geocode.ts';
import { createModules } from './services/modules.ts';
import { createOui } from './services/oui.ts';
import { createOutages, type Outages } from './services/outages.ts';
import { createNotifier, type Notifier } from './services/notify.ts';
import { createTelegram } from './services/telegram.ts';
import type { Uisp } from './services/uisp.ts';
import { createConnectors } from './services/connectors.ts';
import { createCrmSettings } from './services/crm.ts';
import { createVrmSettings } from './services/victron.ts';
import { createMyWicSettings } from './services/mywic.ts';
import { createNas, type reachSmb, type SmbClient } from './services/nas.ts';
import { createVictronSync, type VictronSync } from './services/victron-sync.ts';
import { createImagery } from './services/imagery.ts';
import { createCrmSync, type CrmSync } from './services/crm-sync.ts';
import { createWarehouse, type Warehouse } from './services/warehouse.ts';
import { warehouseRoutes } from './routes/warehouse.ts';
import { crmRoutes } from './routes/crm.ts';
import { connectorRoutes } from './routes/connectors.ts';
import { victronRoutes } from './routes/victron.ts';
import { speedtestRoutes } from './routes/speedtest.ts';
import { coverageOpsRoutes } from './routes/coverage-operators.ts';
import { diagnosisRoutes } from './routes/diagnosis.ts';
import { feasibilityRoutes } from './routes/feasibility.ts';
import { savedCheckRoutes } from './routes/saved-checks.ts';
import { specialistRoutes } from './routes/specialist.ts';
import { createSpecialist } from './services/specialist.ts';
import { createWorkGroups } from './services/work-groups.ts';
import { workGroupRoutes } from './routes/work-groups.ts';
import { mcpRoutes } from './routes/mcp.ts';
import { banRoutes } from './routes/bans.ts';
import { createLoginGuard } from './services/login-guard.ts';
import { createCoverageOps, type CoverageOps } from './services/coverage-operators.ts';
import { createPlatformHealth, type PlatformHealth } from './services/platform-health.ts';
import { platformRoutes } from './routes/platform.ts';
import { nasRoutes } from './routes/nas.ts';
import { createProactiveAlerts, type ProactiveAlerts } from './services/proactive-alerts.ts';
import { cpeAdminRoutes } from './routes/cpe-admin.ts';
import { uispRoutes } from './routes/uisp.ts';
import { mapRoutes } from './routes/map.ts';
import { networkRoutes } from './routes/network.ts';
import { pointingRoutes } from './routes/pointing.ts';
import { terrainRoutes } from './routes/terrain.ts';
import { antennaRoutes } from './routes/antennas.ts';
import { advisorRoutes } from './routes/advisor.ts';
import { serverSettingsRoutes } from './routes/server-settings.ts';
import { infraRoutes } from './routes/infra.ts';
import { guideRoutes } from './routes/guide.ts';
import { workOrderRoutes } from './routes/work-orders.ts';
import { firmwareRoutes } from './routes/firmware.ts';
import { privacyRoutes } from './routes/privacy.ts';
import { createServerSettings } from './services/server-settings.ts';
import { createDem } from './services/dem.ts';
import { createTerrainStore } from './services/terrain-store.ts';
import { createAntennas } from './services/antennas.ts';
import { createAnncsu } from './services/anncsu.ts';
import { createApLoad, type ApLoadService } from './services/ap-load.ts';
import { createAdvisor, type Advisor } from './services/ap-advisor.ts';
import { createOptimizer, type Optimizer } from './services/ap-optimizer.ts';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // OpenStreetMap tiles: map fallback when the local Protomaps basemap is not installed yet.
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
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
  opts: { db?: Db; logger?: boolean; uisp?: Uisp | null; fetchImpl?: typeof fetch; telegramIntervalMs?: number; smb?: SmbClient; reachSmb?: typeof reachSmb } = {},
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const db = opts.db ?? openDatabase(cfg.dbPath);
  ensureBootstrapAdmin(db, cfg);
  const sealer = createSealer(cfg.masterKey);
  // values set from the console override .env before anything reads them
  const serverSettings = createServerSettings(db, cfg, sealer);
  const workGroups = createWorkGroups(db);
  serverSettings.applyAll();
  const templates = createTemplates(db, sealer);
  const provisioning = createProvisioning(db, cfg, sealer, templates);
  convertOldTemplates(db, cfg, templates, provisioning);
  const connectors = createConnectors(db, sealer, cfg, { fetchImpl: opts.fetchImpl });
  const uispCfg = connectors.uispSettings();
  const modules = createModules(db);
  const oui = createOui(cfg.ouiDir, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const telegram = createTelegram(db, sealer, { fetchImpl: opts.fetchImpl, ...(opts.telegramIntervalMs !== undefined ? { minIntervalMs: opts.telegramIntervalMs } : {}) });
  const dem = createDem({ dir: cfg.dem.dir, baseUrl: cfg.dem.url, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  // Firebase refusals go to the server log once Fastify (and its logger) exists
  let pushLog: (m: string) => void = () => {};
  const ctx: AppContext = {
    cfg,
    live: createLive(),
    push: createPush(db, sealer, { fetchImpl: opts.fetchImpl, log: (m) => pushLog(m) }),
    db,
    sealer,
    auth: createAuth(db, cfg.jwtSecret, cfg.jwtTtlHours, () => cfg.jwtMfaTtlDays),
    provisioning,
    templates,
    uisp: opts.uisp !== undefined ? opts.uisp : uispCfg ? connectors.build(uispCfg) : null,
    uispSettings: { autoBackup: uispCfg?.autoBackup ?? cfg.uispAutoBackup, coverageMaxKm: uispCfg?.coverageMaxKm ?? cfg.coverageMaxKm },
    connectors,
    crm: createCrmSettings(db, sealer, { fetchImpl: opts.fetchImpl }),
    victron: createVrmSettings(db, sealer, { fetchImpl: opts.fetchImpl }),
    mywic: createMyWicSettings(db, sealer, { fetchImpl: opts.fetchImpl }),
    nas: createNas(db, sealer, { version, masterKey: cfg.masterKey, smb: opts.smb, reach: opts.reachSmb, log: (m) => pushLog(m) }),
    imagery: createImagery(db, sealer, {
      fetchImpl: opts.fetchImpl,
      dir: cfg.imageryDir,
      // the sea is at 0 m in the terrain model: 9×9 points of the tile, any of them on the sea
      touchesSea: async ([s, w, n, e]) => {
        const at = await dem.sampler(s, w, n, e);
        if (!at) return false;
        for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) if ((at(s + ((n - s) * i) / 8, w + ((e - w) * j) / 8) ?? 1) <= 0) return true;
        return false;
      },
    }),
    crmSync: undefined as unknown as CrmSync,
    victronSync: undefined as unknown as VictronSync,
    coverageOps: undefined as unknown as CoverageOps,
    platformHealth: undefined as unknown as PlatformHealth,
    proactive: undefined as unknown as ProactiveAlerts,
    warehouse: undefined as unknown as Warehouse,
    apLoad: undefined as unknown as ApLoadService,
    advisor: undefined as unknown as Advisor,
    optimizer: undefined as unknown as Optimizer,
    geocoder: createGeocoder({ ...cfg.geocoder, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
    telegram,
    modules,
    oui,
    outages: undefined as unknown as Outages,
    serverSettings,
    dem,
    terrain: createTerrainStore({ dir: cfg.terrainDir, dem, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
    antennas: createAntennas({ dir: join(dirname(cfg.terrainDir), 'antennas'), db, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
    anncsu: createAnncsu({ dir: join(dirname(cfg.terrainDir), 'anncsu'), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
    notify: undefined as unknown as Notifier,
    loginGuard: createLoginGuard(db, { ignore: cfg.loginBanIgnore, notify: (html) => ctx.notify.security(html) }),
    specialist: createSpecialist(db, cfg, sealer, { fetchImpl: opts.fetchImpl, workGroups }),
    workGroups,
    version,
  };
  ctx.crmSync = createCrmSync(db, ctx.crm);
  ctx.victronSync = createVictronSync(db, ctx.victron);
  ctx.coverageOps = createCoverageOps(db, cfg, () => ctx.mywic.client());
  ctx.warehouse = createWarehouse(db, ctx.crm);
  ctx.advisor = createAdvisor(ctx);
  ctx.optimizer = createOptimizer(ctx);
  ctx.apLoad = createApLoad(db, () => ctx.uisp, undefined, (inputs) => ctx.advisor.run(inputs));
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
    onChange: () => ctx.live.publish('outages', 'all'),
    offGridPops: () => ctx.victronSync?.offGridPops() ?? new Set(),
  });
  ctx.notify = createNotifier(db, cfg, telegram, () => ctx.uisp, version, () => modules.enabled('telegram'), undefined, (ids, n) => {
    ctx.live.publish('notifications', ids);
    // to the phones at once (Firebase); the reminders of the work orders are scheduled by the app itself
    if (n.kind !== 'work_order_reminder') void ctx.push.send(ids, { title: n.title, body: n.lines.join('\n'), kind: n.kind });
  });

  // what each source says about its last reading (null: not configured, never an alert)
  ctx.platformHealth = createPlatformHealth(db, {
    dbPath: cfg.dbPath,
    version,
    alert: (ok, title, lines) => ctx.notify.platform(ok, title, lines),
    probes: () => [
      {
        id: 'uisp', label: 'UISP', everyMin: 5,
        read: () => {
          const h = ctx.uisp?.health?.();
          return h ? { at: h.lastOkAt ?? h.dataAt, error: h.online ? null : h.lastError } : null;
        },
      },
      { id: 'crm', label: 'ISP Billing (RADIUS e clienti)', everyMin: 10, read: () => (ctx.crm.client() ? ctx.crmSync.state() : null) },
      { id: 'warehouse', label: 'Magazzino ISP Billing', everyMin: 60, read: () => (ctx.crm.client() ? ctx.warehouse.state() : null) },
      {
        id: 'outages', label: 'Guasti Enel', everyMin: 10,
        read: () => {
          if (!modules.enabled('power_outages')) return null;
          const s = ctx.outages.status();
          return s ? { at: s.ok ? s.at : null, error: s.ok ? null : (s.error ?? 'errore') } : { at: null, error: null };
        },
      },
      { id: 'victron', label: 'Victron VRM (batterie dei POP)', everyMin: 5, read: () => (ctx.victron.client() ? ctx.victronSync.state() : null) },
      // one copy a night: late when the last good one is older than 30 hours
      { id: 'nas', label: 'Backup sul NAS', everyMin: 24 * 60, lateMin: 30 * 60, read: () => ctx.nas.health() },
    ],
  });
  ctx.proactive = createProactiveAlerts(ctx, (m) => app.log.warn(m));

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: cfg.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-cda-bridge-token"]', 'req.headers["x-backup-password"]'],
          },
    bodyLimit: 512 * 1024,
    trustProxy: cfg.trustProxy,
  });
  pushLog = (m) => app.log.warn(m);

  // Android app always on the latest release (Impostazioni server → "App sempre all'ultima
  // versione"): an older app gets 426 on every call, login included, and can only update itself.
  // Apps before v1.31 send their version only on some calls: their OkHttp user agent gives them away.
  let latest: { at: number; version: string | null } = { at: 0, version: null };
  const requiredAndroid = (): string => {
    if (Date.now() - latest.at > 30_000) latest = { at: Date.now(), version: loadLatestRelease(cfg.releases.dir)?.versionName ?? null };
    const pinned = cfg.minAndroidVersion;
    const newest = cfg.appForceLatest ? latest.version?.replace(/[-+].*$/, '') : undefined;
    return newest && !versionAtLeast(pinned, newest) ? newest : pinned;
  };
  const ALWAYS_OPEN = ['/api/health', '/api/mobile/', '/api/map/'];
  // fail2ban-like: a banned device is stopped everywhere; a banned IP only at the logins and
  // without a session (many installers share one public IP: those logged in keep working)
  const LOGINS = ['/api/auth/login', '/api/login', '/api/auth/device-login', '/oauth/authorize', '/oauth/token'];
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (!(path.startsWith('/api/') || path.startsWith('/oauth/') || path === '/mcp') || ALWAYS_OPEN.some((p) => path.startsWith(p))) return;
    const b = ctx.loginGuard.bannedFor(req);
    if (!b) return;
    const login = LOGINS.some((p) => path === p || path.startsWith(`${p}/`));
    if (b.kind === 'ip' && !login && req.headers.authorization) return;
    const secs = Math.max(1, Math.ceil((Date.parse(b.until) - Date.now()) / 1000));
    return reply.code(429).header('Retry-After', String(secs)).send({ error: 'banned', until: b.until });
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || ALWAYS_OPEN.some((p) => req.url.startsWith(p))) return;
    const client = parseClientHeader(req.headers['x-cda-client'] as string | undefined);
    const version = client?.version ?? (/^okhttp\//i.test(String(req.headers['user-agent'] ?? '')) ? '0.0.0' : null);
    if (version === null) return; // browsers (console) and other tools
    const min = requiredAndroid();
    if (!versionAtLeast(version, min)) return reply.code(426).send({ error: 'client_update_required', minVersion: min });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', reply.getHeader('Cache-Control') ?? 'no-store');
    // a page with its own policy keeps it (the Claude consent page: its inline style, the redirect as form target)
    else if (!reply.getHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', CSP);
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      if (err.code === 'banned' && typeof err.extra?.until === 'string') reply.header('Retry-After', String(Math.max(1, Math.ceil((Date.parse(err.extra.until) - Date.now()) / 1000))));
      return reply.code(err.status).send({ error: err.code, ...err.extra });
    }
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
  koRoutes(app, ctx);
  notificationRoutes(app, ctx);
  liveRoutes(app, ctx);
  replaceRoutes(app, ctx);
  statsRoutes(app, ctx);
  outageRoutes(app, ctx);
  mapRoutes(app, ctx);
  networkRoutes(app, ctx);
  pointingRoutes(app, ctx);
  terrainRoutes(app, ctx);
  antennaRoutes(app, ctx);
  advisorRoutes(app, ctx);
  serverSettingsRoutes(app, ctx);
  infraRoutes(app, ctx);
  guideRoutes(app, ctx);
  workOrderRoutes(app, ctx);
  firmwareRoutes(app, ctx);
  privacyRoutes(app, ctx);
  crmRoutes(app, ctx);
  warehouseRoutes(app, ctx);
  adminRoutes(app, ctx);
  toolRoutes(app, ctx);
  uispRoutes(app, ctx);
  cpeAdminRoutes(app, ctx);
  connectorRoutes(app, ctx);
  victronRoutes(app, ctx);
  speedtestRoutes(app, ctx);
  coverageOpsRoutes(app, ctx);
  platformRoutes(app, ctx);
  nasRoutes(app, ctx);
  diagnosisRoutes(app, ctx);
  feasibilityRoutes(app, ctx);
  savedCheckRoutes(app, ctx);
  specialistRoutes(app, ctx);
  workGroupRoutes(app, ctx);
  mcpRoutes(app, ctx);
  banRoutes(app, ctx);

  const hasWeb = existsSync(join(cfg.staticDir, 'index.html'));
  // The console built by Vite (console/ → web/app): its pages (the console, /map-embed.html for the
  // Android app) and its files with a content hash in their name under /app/assets/, kept a year.
  // Without a build (a development checkout) every page is web/index.html, which says how to build.
  const built = existsSync(join(cfg.staticDir, 'app', 'index.html'));
  const pages = new Map<string, string>();
  const page = (file: string) => {
    if (!pages.has(file)) pages.set(file, readFileSync(built ? join(cfg.staticDir, 'app', file) : join(cfg.staticDir, 'index.html'), 'utf8'));
    return pages.get(file)!;
  };
  const sendPage = (reply: FastifyReply, file: string) => reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(page(file));
  if (hasWeb) {
    // Everything but the hashed files revalidates on every load (ETag/Last-Modified): vendor files,
    // icons, the wiki.
    await app.register(fastifyStatic, {
      root: cfg.staticDir,
      // the wiki and the other folders keep their index.html; the console's own pages (/, /index.html) are the routes below
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (reply) => {
        reply.header('Cache-Control', built && reply.request.url.startsWith('/app/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.get('/', (_req, reply) => sendPage(reply, 'index.html'));
    app.get('/index.html', (_req, reply) => sendPage(reply, 'index.html'));
    app.get('/map-embed.html', (_req, reply) => sendPage(reply, 'map-embed.html'));
  }
  app.setNotFoundHandler((req, reply) => {
    // a missing file (a script of an older build, an image) is a 404, never the console page: a
    // module answered with HTML breaks the page that asked for it
    const path = req.url.split('?')[0] ?? '';
    if (req.url.startsWith('/api/') || req.method !== 'GET' || !hasWeb || /\.[a-z0-9]{1,6}$/i.test(path)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return sendPage(reply, 'index.html');
  });

  return { app, ctx };
}

/**
 * v1.35.11: the CPE values of the server (LAN, DHCP, PPPoE MTU, ports, NTP, watchdog, SNMP, UISP)
 * become each template's own. Once per template saved before, only if the configuration it
 * produces stays the same byte for byte; each conversion goes in the activity log.
 */
function convertOldTemplates(db: Db, cfg: Config, templates: Templates, provisioning: Provisioning) {
  const n = cfg.network;
  const old: LegacyValues = {
    retired: {
      HTTP_PORT: String(MANAGEMENT_PORTS.http),
      HTTPS_PORT: String(MANAGEMENT_PORTS.https),
      SNMP_CONTACT: cfg.cpeSecrets.snmpContact,
      LAN_IP: n.lanIp,
      LAN_NETMASK: n.lanNetmask,
      DHCP_START: n.dhcpStart,
      DHCP_END: n.dhcpEnd,
      DHCP_LEASE: String(n.dhcpLease),
      PPPOE_MTU: String(n.pppoeMtu),
      PPPOE_MRU: String(n.pppoeMru),
      WATCHDOG_HOST: n.watchdogHost,
      NTP_SERVER: n.ntpServer,
      SSH_PORT: String(n.sshPort),
      DISCOVERY_PORT: String(n.discoveryPort),
    },
    watchdogHost: n.watchdogHost,
    snmpContact: cfg.cpeSecrets.snmpContact,
    snmpCommunity: cfg.cpeSecrets.snmpCommunity,
    uispKey: cfg.cpeSecrets.uispEnrollment,
  };
  const { done, failed } = templates.convertLegacy(old, provisioning.legacyCheck(old));
  for (const t of done) recordEvent(db, null, 'template.convert', `${t.model} · ${t.name}`, 'valori del server copiati nel template (configurazione generata identica)');
  for (const t of failed) recordEvent(db, null, 'template.convert_failed', `${t.model} · ${t.name}`, 'configurazione diversa dopo la conversione: template lasciato com’era');
}
