import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/**
 * Ordered schema migrations tracked with PRAGMA user_version.
 * Migration 1 recreates the v0.5.x schema with IF NOT EXISTS, so an existing
 * production database is adopted in place without data loss.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN('admin','installer')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audits(
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    ssid TEXT NOT NULL,
    pppoe_user TEXT NOT NULL,
    model TEXT NOT NULL,
    mac TEXT NOT NULL,
    serial TEXT NOT NULL,
    result TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS wireless_secrets(
    ssid TEXT PRIMARY KEY,
    wpa2_ciphertext TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provision_profiles(
    model TEXT NOT NULL,
    firmware TEXT NOT NULL,
    board_match TEXT NOT NULL DEFAULT '',
    template_ciphertext TEXT NOT NULL,
    template_sha256 TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(model, firmware)
  );
  `,
  `
  ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN last_login_at TEXT;
  ALTER TABLE provision_profiles ADD COLUMN updated_by INTEGER;

  CREATE TABLE provisioning_jobs(
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    client TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    mac TEXT NOT NULL,
    serial TEXT NOT NULL,
    ssid TEXT NOT NULL,
    pppoe_user TEXT NOT NULL,
    device_name TEXT NOT NULL DEFAULT '',
    profile_sha256 TEXT NOT NULL DEFAULT '',
    config_sha256 TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN('prepared','success','failed','expired')),
    stages TEXT NOT NULL DEFAULT '[]',
    detected TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX provisioning_jobs_user ON provisioning_jobs(user_id, created_at);
  CREATE INDEX provisioning_jobs_created ON provisioning_jobs(created_at);
  CREATE INDEX provisioning_jobs_mac ON provisioning_jobs(mac);

  INSERT INTO provisioning_jobs(id, created_at, expires_at, completed_at, user_id, client, model, mac, serial, ssid, pppoe_user, status)
    SELECT 'legacy-' || id, created_at, created_at, created_at, user_id, 'legacy-v0.5', model, mac, serial, ssid, pppoe_user,
           CASE WHEN result = 'success' THEN 'success' ELSE 'failed' END
    FROM audits;

  CREATE TABLE events(
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    user_id INTEGER,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX events_created ON events(created_at);
  `,
  // 3: several named templates per model (one default). Existing profiles become "Standard".
  `
  CREATE TABLE profile_templates(
    id INTEGER PRIMARY KEY,
    model TEXT NOT NULL,
    firmware TEXT NOT NULL,
    name TEXT NOT NULL,
    board_match TEXT NOT NULL,
    template_ciphertext TEXT NOT NULL,
    template_sha256 TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER,
    UNIQUE(model, firmware, name COLLATE NOCASE)
  );
  INSERT INTO profile_templates(model, firmware, name, board_match, template_ciphertext, template_sha256, is_default, created_at, updated_at, updated_by)
    SELECT model, firmware, 'Standard', board_match, template_ciphertext, template_sha256, 1, updated_at, updated_at, updated_by
    FROM provision_profiles;
  ALTER TABLE provisioning_jobs ADD COLUMN template_name TEXT NOT NULL DEFAULT '';
  `,
  // 4: template visibility. audience 'all' = every installer; 'users' = only the listed ones
  // (a template assigned to a single installer is that installer's personal template).
  `
  ALTER TABLE profile_templates ADD COLUMN audience TEXT NOT NULL DEFAULT 'all' CHECK(audience IN('all','users'));
  ALTER TABLE profile_templates ADD COLUMN default_for_assigned INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE template_users(
    template_id INTEGER NOT NULL REFERENCES profile_templates(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(template_id, user_id)
  );
  CREATE INDEX template_users_user ON template_users(user_id);
  `,
  // 5: CPE position (phone GPS or geocoded address) and UISP lifecycle of the provisioned device.
  `
  ALTER TABLE provisioning_jobs ADD COLUMN latitude REAL;
  ALTER TABLE provisioning_jobs ADD COLUMN longitude REAL;
  ALTER TABLE provisioning_jobs ADD COLUMN location_accuracy REAL;
  ALTER TABLE provisioning_jobs ADD COLUMN location_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE provisioning_jobs ADD COLUMN uisp_device_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE provisioning_jobs ADD COLUMN uisp_site TEXT NOT NULL DEFAULT '';
  ALTER TABLE provisioning_jobs ADD COLUMN uisp_authorized_at TEXT;
  ALTER TABLE provisioning_jobs ADD COLUMN uisp_authorized_by INTEGER;
  `,
  // 6: settings edited from the console (connectors). Secrets inside values are sealed.
  `
  CREATE TABLE settings(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER
  );
  `,
  // 7: acceptance test (collaudo) with photos, CPE replacement link
  `
  CREATE TABLE job_acceptance(
    job_id TEXT PRIMARY KEY REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    verdict TEXT NOT NULL CHECK(verdict IN('ok','warn','bad')),
    data TEXT NOT NULL
  );
  CREATE TABLE job_photos(
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    caption TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL
  );
  CREATE INDEX job_photos_job ON job_photos(job_id);
  ALTER TABLE provisioning_jobs ADD COLUMN replaces_job_id TEXT;
  `,
  // 8: two-step verification (TOTP) and recovery codes
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN totp_pending TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT NOT NULL DEFAULT '[]';
  `,
];

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** Applies pending migrations (up to `target`, default: latest). */
export function migrate(db: Db, target = MIGRATIONS.length): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < Math.min(target, MIGRATIONS.length); v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration ${v + 1} failed: ${(err as Error).message}`);
    }
  }
}

export const nowIso = () => new Date().toISOString();

export function recordEvent(db: Db, userId: number | null, action: string, target = '', detail = ''): void {
  db.prepare('INSERT INTO events(created_at, user_id, action, target, detail) VALUES(?,?,?,?,?)').run(
    nowIso(),
    userId,
    action,
    target.slice(0, 200),
    detail.slice(0, 500),
  );
}
