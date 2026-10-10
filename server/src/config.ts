import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const int = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[\r\n\0]/.test(v), 'must be a single line')
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v));

const ipv4 = z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/);

const envSchema = z.object({
  PORT: int(8787, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
  DB_PATH: z.string().default('./data/cdanet.sqlite'),
  // airOS firmware images for the field upgrade (default: 'firmware' next to the database).
  FIRMWARE_DIR: z.string().optional(),
  // Acceptance-test photos (default: 'photos' next to the database).
  PHOTOS_DIR: z.string().optional(),
  // Protomaps basemap (default: maps/basemap.pmtiles next to the database).
  MAP_FILE: z.string().optional(),
  // Requests to the updater agent (infrastructure settings), shared through the data volume.
  INFRA_DIR: z.string().optional(),
  // Terrain elevation tiles (SRTM/Skadi layout) for the pointing tilt; empty = off.
  DEM_URL: z.string().default('https://elevation-tiles-prod.s3.amazonaws.com/skadi'),
  STATIC_DIR: z.string().default('../web'),
  SECRETS_KEY_FILE: z.string().default('/run/secrets/cdanet_master_key'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_HOURS: int(8, 1, 72),
  ADMIN_USERNAME: z.string().regex(/^[A-Za-z0-9._-]{3,80}$/).default('admin'),
  ADMIN_PASSWORD: z.string().optional(),

  // CPE runtime secrets: never committed, supplied by the deployment.
  CPE_ADMIN_USERNAME: optionalText(80),
  CPE_ADMIN_PASSWORD: optionalText(200),
  UISP_ENROLLMENT: optionalText(4096),
  SNMP_COMMUNITY: optionalText(64),
  SNMP_CONTACT: optionalText(200),

  // CDA Net baseline, editable without code changes.
  CPE_FACTORY_IP: ipv4.default('192.168.172.1'),
  CPE_LAN_IP: ipv4.default('192.168.1.254'),
  CPE_LAN_NETMASK: ipv4.default('255.255.255.0'),
  CPE_DHCP_START: ipv4.default('192.168.1.10'),
  CPE_DHCP_END: ipv4.default('192.168.1.50'),
  CPE_DHCP_LEASE: int(600, 60, 86400),
  CPE_PPPOE_MTU: int(1450, 576, 1500),
  CPE_PPPOE_MRU: int(1450, 576, 1500),
  CPE_WATCHDOG_HOST: z.string().max(253).default('8.8.8.8'),
  CPE_NTP_SERVER: z.string().max(253).default('10.0.0.254'),
  CPE_SSH_PORT: int(22, 1, 65535),
  CPE_DISCOVERY_PORT: int(10001, 1, 65535),

  PROVISION_JOB_TTL_MINUTES: int(30, 5, 240),
  // thresholds of the acceptance test, the field diagnosis and Salute CPE (Impostazioni server)
  SIGNAL_GOOD_DBM: int(-65, -90, -40),
  SIGNAL_MIN_DBM: int(-75, -95, -45),
  CINR_MIN_DB: int(20, 0, 40),
  CHAIN_DELTA_DB: int(6, 1, 30),
  CAPACITY_MIN_MBPS: int(100, 1, 2000),
  ETH_MIN_MBPS: int(100, 10, 1000),
  SIGNAL_DROP_DB: int(6, 1, 30),
  // nearest APs an installer gets from a coverage check (web and app alike)
  INSTALLER_COVERAGE_APS: int(5, 1, 20),
  // theoretical estimate for APs without customers: EIRP of the AP and gain of the CPE antenna
  COVERAGE_AP_EIRP_DBM: int(30, 10, 60),
  COVERAGE_CPE_GAIN_DBI: int(23, 0, 40),
  MIN_ANDROID_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
  // the Android app must be on the latest published release (older ones cannot log in)
  APP_FORCE_LATEST: z.enum(['0', '1']).default('1'),
  GDPR_AUDIT_RETENTION_DAYS: int(365, 1, 3650),

  ANDROID_RELEASE_DIR: z.string().default('/opt/cdanet/releases'),
  ANDROID_RELEASE_GITHUB_REPO: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  ANDROID_RELEASE_GITHUB_TOKEN: optionalText(400),
  ANDROID_RELEASE_SYNC_MINUTES: int(30, 0, 1440),

  ROUTEROS_ALLOW_PUBLIC: z.enum(['0', '1']).default('0'),

  // UISP API v2.1 (optional): base URL like https://uisp.example.it, token from UISP Settings > Users > API tokens.
  UISP_API_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  UISP_API_TOKEN: optionalText(400),
  UISP_CACHE_SECONDS: int(60, 5, 3600),
  UISP_AUTO_BACKUP: z.enum(['0', '1']).default('1'),
  // 1 = accept self-signed/invalid certificates from UISP (use only on a trusted management network).
  UISP_IGNORE_TLS: z.enum(['0', '1']).default('0'),
  COVERAGE_MAX_KM: int(15, 1, 100),
  // Public console address (e.g. https://cpe.cda-net.it): used for links in Telegram messages.
  PUBLIC_URL: z.union([z.literal(''), z.string().url()]).optional(),
  GEOCODER_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  // Used while the local Nominatim is importing or down (e.g. the public service).
  GEOCODER_FALLBACK_URL: z.union([z.literal(''), z.string().url()]).optional(),
  GEOCODER_CONTACT: optionalText(200),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  port: number;
  host: string;
  logLevel: Env['LOG_LEVEL'];
  trustProxy: string;
  dbPath: string;
  photosDir: string;
  firmwareDir: string;
  /** IEEE OUI registries cache (MAC vendors). */
  ouiDir: string;
  /** Protomaps basemap (PMTiles) served to the console maps. */
  mapFile: string;
  /** Exchange directory with the updater agent: current.env, request.env, status.env. */
  infraDir: string;
  /** Terrain tiles: source and local cache. */
  dem: { url: string; dir: string };
  staticDir: string;
  masterKey: Buffer;
  jwtSecret: Uint8Array;
  jwtTtlHours: number;
  bootstrapAdmin: { username: string; password: string | undefined };
  cpeSecrets: {
    adminUsername: string;
    adminPassword: string | undefined;
    uispEnrollment: string | undefined;
    snmpCommunity: string;
    snmpContact: string;
  };
  network: {
    factoryIp: string;
    lanIp: string;
    lanNetmask: string;
    dhcpStart: string;
    dhcpEnd: string;
    dhcpLease: number;
    pppoeMtu: number;
    pppoeMru: number;
    watchdogHost: string;
    ntpServer: string;
    sshPort: number;
    discoveryPort: number;
  };
  jobTtlMinutes: number;
  /** Thresholds of the acceptance test, field diagnosis, Salute CPE and coverage ranking. */
  thresholds: { signalGood: number; signalMin: number; cinrMin: number; chainDelta: number; capacityMinMbps: number; ethMinMbps: number; signalDropDb: number };
  installerCoverageAps: number;
  coverageEirpDbm: number;
  coverageCpeGainDbi: number;
  minAndroidVersion: string;
  auditRetentionDays: number;
  releases: {
    dir: string;
    githubRepo: string | undefined;
    githubToken: string | undefined;
    syncMinutes: number;
  };
  routerOsAllowPublic: boolean;
  /** Android app always on the latest release: older apps get 426 on every call. */
  appForceLatest: boolean;
  uisp: { url: string; token: string; cacheSeconds: number } | null;
  uispAutoBackup: boolean;
  uispIgnoreTls: boolean;
  coverageMaxKm: number;
  publicUrl: string | undefined;
  geocoder: { url: string; fallbackUrl: string | undefined; contact: string | undefined };
  /** Variables actually set in the environment (.env), to tell them from defaults. */
  envProvided: string[];
}

export function loadMasterKey(path: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`Secrets master key unavailable at ${path}`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('Secrets master key must be base64 of exactly 32 bytes');
  return key;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, masterKey?: Buffer): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${lines.join('\n  ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    dbPath: e.DB_PATH,
    ouiDir: e.DB_PATH === ':memory:' ? join(tmpdir(), `cdanet-oui-${process.pid}`) : join(dirname(e.DB_PATH), 'oui'),
    dem: { url: e.DEM_URL, dir: e.DB_PATH === ':memory:' ? join(tmpdir(), `cdanet-dem-${process.pid}`) : join(dirname(e.DB_PATH), 'dem') },
    mapFile: e.MAP_FILE || (e.DB_PATH === ':memory:' ? join(tmpdir(), `cdanet-map-${process.pid}.pmtiles`) : join(dirname(e.DB_PATH), 'maps', 'basemap.pmtiles')),
    infraDir: e.INFRA_DIR || (e.DB_PATH === ':memory:' ? join(tmpdir(), `cdanet-infra-${process.pid}`) : join(dirname(e.DB_PATH), 'infra')),
    firmwareDir: e.FIRMWARE_DIR || (e.DB_PATH === ':memory:' ? join(tmpdir(), `cdanet-firmware-${process.pid}`) : join(dirname(e.DB_PATH), 'firmware')),
    photosDir: e.PHOTOS_DIR || (e.DB_PATH === ':memory:' ? join(tmpdir(), `cdanet-photos-${process.pid}`) : join(dirname(e.DB_PATH), 'photos')),
    staticDir: resolve(e.STATIC_DIR),
    masterKey: masterKey ?? loadMasterKey(e.SECRETS_KEY_FILE),
    jwtSecret: new TextEncoder().encode(e.JWT_SECRET),
    jwtTtlHours: e.JWT_TTL_HOURS,
    bootstrapAdmin: { username: e.ADMIN_USERNAME, password: e.ADMIN_PASSWORD },
    cpeSecrets: {
      adminUsername: e.CPE_ADMIN_USERNAME ?? 'ubnt',
      adminPassword: e.CPE_ADMIN_PASSWORD,
      uispEnrollment: e.UISP_ENROLLMENT,
      snmpCommunity: e.SNMP_COMMUNITY ?? 'public',
      snmpContact: e.SNMP_CONTACT ?? '172.31.0.7',
    },
    network: {
      factoryIp: e.CPE_FACTORY_IP,
      lanIp: e.CPE_LAN_IP,
      lanNetmask: e.CPE_LAN_NETMASK,
      dhcpStart: e.CPE_DHCP_START,
      dhcpEnd: e.CPE_DHCP_END,
      dhcpLease: e.CPE_DHCP_LEASE,
      pppoeMtu: e.CPE_PPPOE_MTU,
      pppoeMru: e.CPE_PPPOE_MRU,
      watchdogHost: e.CPE_WATCHDOG_HOST,
      ntpServer: e.CPE_NTP_SERVER,
      sshPort: e.CPE_SSH_PORT,
      discoveryPort: e.CPE_DISCOVERY_PORT,
    },
    jobTtlMinutes: e.PROVISION_JOB_TTL_MINUTES,
    thresholds: {
      signalGood: e.SIGNAL_GOOD_DBM,
      signalMin: e.SIGNAL_MIN_DBM,
      cinrMin: e.CINR_MIN_DB,
      chainDelta: e.CHAIN_DELTA_DB,
      capacityMinMbps: e.CAPACITY_MIN_MBPS,
      ethMinMbps: e.ETH_MIN_MBPS,
      signalDropDb: e.SIGNAL_DROP_DB,
    },
    installerCoverageAps: e.INSTALLER_COVERAGE_APS,
    coverageEirpDbm: e.COVERAGE_AP_EIRP_DBM,
    coverageCpeGainDbi: e.COVERAGE_CPE_GAIN_DBI,
    minAndroidVersion: e.MIN_ANDROID_VERSION,
    auditRetentionDays: e.GDPR_AUDIT_RETENTION_DAYS,
    releases: {
      dir: resolve(e.ANDROID_RELEASE_DIR),
      githubRepo: e.ANDROID_RELEASE_GITHUB_REPO,
      githubToken: e.ANDROID_RELEASE_GITHUB_TOKEN,
      syncMinutes: e.ANDROID_RELEASE_SYNC_MINUTES,
    },
    routerOsAllowPublic: e.ROUTEROS_ALLOW_PUBLIC === '1',
    appForceLatest: e.APP_FORCE_LATEST === '1',
    uisp:
      e.UISP_API_URL && e.UISP_API_TOKEN
        ? { url: e.UISP_API_URL, token: e.UISP_API_TOKEN, cacheSeconds: e.UISP_CACHE_SECONDS }
        : null,
    uispAutoBackup: e.UISP_AUTO_BACKUP === '1',
    uispIgnoreTls: e.UISP_IGNORE_TLS === '1',
    coverageMaxKm: e.COVERAGE_MAX_KM,
    publicUrl: e.PUBLIC_URL ? e.PUBLIC_URL.replace(/\/+$/, '') : undefined,
    geocoder: { url: e.GEOCODER_URL, fallbackUrl: e.GEOCODER_FALLBACK_URL || undefined, contact: e.GEOCODER_CONTACT },
    envProvided: Object.keys(envSchema.shape).filter((k) => source[k] !== undefined && source[k] !== ''),
  };
}
