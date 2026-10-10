import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db.ts';

export const ADMIN = { username: 'admintest', password: 'Admin-Test-Password-123' };

export const SAMPLE_TEMPLATE = [
  'system.cfg.version=65547',
  'aaa.1.status=enabled',
  'wireless.1.ssid=${SSID}',
  'wpasupplicant.profile.1.network.1.psk=${WPA2_PSK}',
  'ppp.1.name=${PPPOE_USER}',
  'ppp.1.password=${PPPOE_PASSWORD}',
  'ppp.1.mtu=${PPPOE_MTU}',
  'users.1.name=${CPE_USERNAME}',
  'users.1.password=${CPE_PASSWORD_HASH}',
  'httpd.port=${HTTP_PORT}',
  'httpd.https.port=${HTTPS_PORT}',
  'netconf.3.ip=${LAN_IP}',
  'snmp.location=old-location',
  'pwdog.host=1.1.1.1',
  '',
].join('\n');

export function testConfig(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdanet-test-'));
  const cfg = loadConfig(
    {
      JWT_SECRET: 'test-jwt-secret-0123456789abcdefghijklmnopqrstuvwxyz',
      ADMIN_USERNAME: ADMIN.username,
      ADMIN_PASSWORD: ADMIN.password,
      DB_PATH: ':memory:',
      STATIC_DIR: join(dir, 'web-missing'),
      ANDROID_RELEASE_DIR: join(dir, 'releases'),
      PHOTOS_DIR: join(dir, 'photos'),
      INFRA_DIR: join(dir, 'infra'),
      FIRMWARE_DIR: join(dir, 'firmware'),
      MAP_FILE: join(dir, 'basemap.pmtiles'),
      CPE_ADMIN_PASSWORD: 'Cpe-Admin-Secret-1',
      // every AP listed unless a test sets the threshold (Impostazioni server: −70 dBm by default)
      COVERAGE_HIDE_BELOW_DBM: '-100',
      UISP_ENROLLMENT: 'wss://uisp.example:443+token+allowUntrustedCertificate',
      LOG_LEVEL: 'silent',
      ...overrides,
    },
    randomBytes(32),
  );
  // Disk caches of every test app in a directory of its own: with DB_PATH=':memory:' they default to
  // tmpdir()/cdanet-*-<pid>, never removed, and a reused pid (Windows) would hand one test the
  // terrain tiles downloaded by another (e.g. the 1500 m ridge of coverage-sim in pointing).
  cfg.ouiDir = join(dir, 'oui');
  cfg.dem.dir = join(dir, 'dem');
  cfg.terrainDir = join(dir, 'terrain');
  return cfg;
}

export async function testApp(overrides: Record<string, string> = {}) {
  const cfg = testConfig(overrides);
  const db = openDatabase(':memory:');
  const { app, ctx } = await buildApp(cfg, '1.0.0-test', { db, logger: false });
  await app.ready();

  async function login(username = ADMIN.username, password = ADMIN.password): Promise<string> {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    if (r.statusCode !== 200) throw new Error(`login failed ${r.statusCode} ${r.body}`);
    return r.json().token as string;
  }
  const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
  return { app, ctx, cfg, db, login, auth };
}
