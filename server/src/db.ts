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
  // 9: per-user module overrides (on/off regardless of the global setting)
  `
  CREATE TABLE user_modules(
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, module)
  );
  `,
  // 10: power outages (e-distribuzione) in the areas of interest
  `
  CREATE TABLE outage_zones(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    radius_km REAL NOT NULL,
    created_at TEXT NOT NULL,
    created_by INTEGER
  );
  CREATE TABLE power_outages(
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    zones TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    ended_at TEXT,
    notified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX power_outages_active ON power_outages(ended_at);
  `,
  // 11: POPs/APs imported from UISP to monitor, and their assignment to installers
  `
  CREATE TABLE outage_selection(
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    added_at TEXT NOT NULL
  );
  CREATE TABLE outage_assignments(
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY(user_id, key)
  );
  `,
  // 12: personal areas of interest of installers (owner_id NULL = shared zone of the admins)
  `
  ALTER TABLE outage_zones ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  CREATE INDEX outage_zones_owner ON outage_zones(owner_id);
  ALTER TABLE users ADD COLUMN telegram_chat_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN telegram_planned INTEGER NOT NULL DEFAULT 1;
  `,
  // 13: customer CPEs (from UISP, e.g. installed before the app) assigned to an installer
  `
  CREATE TABLE cpe_assignments(
    mac TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    assigned_at TEXT NOT NULL,
    assigned_by INTEGER
  );
  CREATE INDEX cpe_assignments_user ON cpe_assignments(user_id);
  `,
  // 14: phones enabled for quick (biometric) login. Only the hash of the device key is stored;
  // the key is valid while the account's token_version is unchanged (logout-all, password change).
  `
  CREATE TABLE auth_devices(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    token_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX auth_devices_user ON auth_devices(user_id);
  `,
  // 15: installations reported postponed or KO by the technician (one row per attempt, never
  // blocking a retry), and the number of write attempts of a package (a failed write can be retried)
  `
  CREATE TABLE install_ko(
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    job_id TEXT REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN('postponed','definitive')),
    mode TEXT NOT NULL CHECK(mode IN('new','repoint')),
    step TEXT NOT NULL,
    reason TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    mac TEXT NOT NULL DEFAULT '',
    ssid TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    resolved_at TEXT,
    resolved_by INTEGER REFERENCES users(id),
    resolution TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX install_ko_job ON install_ko(job_id);
  CREATE INDEX install_ko_mac ON install_ko(mac);
  CREATE INDEX install_ko_created ON install_ko(created_at);
  ALTER TABLE provisioning_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
  -- acceptance tests with a poor signal wait for the NOC's approval
  ALTER TABLE job_acceptance ADD COLUMN review TEXT CHECK(review IN('pending','approved','rejected'));
  ALTER TABLE job_acceptance ADD COLUMN review_reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE job_acceptance ADD COLUMN review_at TEXT;
  ALTER TABLE job_acceptance ADD COLUMN review_by INTEGER REFERENCES users(id);
  ALTER TABLE job_acceptance ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
  -- notifications of each user (the NOC: every admin), also sent on Telegram if the user wants
  CREATE TABLE notifications(
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    job_id TEXT,
    mac TEXT NOT NULL DEFAULT '',
    read_at TEXT
  );
  CREATE INDEX notifications_user ON notifications(user_id, read_at);
  `,
  // 16: rules of each area of interest: paused (no notifications) and which outages it notifies.
  // Personal zones keep the owner's previous "planned works" choice.
  `
  ALTER TABLE outage_zones ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE outage_zones ADD COLUMN notify_mt INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE outage_zones ADD COLUMN notify_bt INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE outage_zones ADD COLUMN notify_planned INTEGER NOT NULL DEFAULT 0;
  UPDATE outage_zones SET notify_planned = COALESCE((SELECT telegram_planned FROM users WHERE users.id = outage_zones.owner_id), 0) WHERE owner_id IS NOT NULL;
  `,
  // 17: work orders assigned by the office (agenda of the day). The PPPoE password is sealed with
  // the master key like the Wi-Fi keys: the installer never types or sees it.
  `
  CREATE TABLE work_orders(
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    day TEXT NOT NULL,
    slot TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK(kind IN('new','repoint','repair','survey')),
    customer TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    lat REAL,
    lon REAL,
    contact TEXT NOT NULL DEFAULT '',
    pppoe_user TEXT NOT NULL DEFAULT '',
    pppoe_ciphertext TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','started','done','cancelled','postponed')),
    status_note TEXT NOT NULL DEFAULT '',
    job_id TEXT REFERENCES provisioning_jobs(id) ON DELETE SET NULL,
    done_at TEXT
  );
  CREATE INDEX work_orders_day ON work_orders(day);
  CREATE INDEX work_orders_assigned ON work_orders(assigned_to, day);
  ALTER TABLE provisioning_jobs ADD COLUMN work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL;
  `,
  // 18: airOS firmware images uploaded by the admin, flashed from the app in the field
  `
  CREATE TABLE firmware_images(
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    platform TEXT NOT NULL,
    version TEXT NOT NULL,
    build TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    md5 TEXT NOT NULL
  );
  `,
  // 19: phone keys of the persistent login expire (sliding, with a hard cap); NULL = older
  // biometric keys, valid until revoked as before
  `
  ALTER TABLE auth_devices ADD COLUMN expires_at TEXT;
  ALTER TABLE auth_devices ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
  `,
  // 20: alerts already sent for a work order (reminders before the start, late, missed)
  `
  ALTER TABLE work_orders ADD COLUMN reminders TEXT NOT NULL DEFAULT '';
  ALTER TABLE work_orders ADD COLUMN late_at TEXT;
  ALTER TABLE work_orders ADD COLUMN missed_at TEXT;
  -- where the order's position comes from ('office' typed it, 'address' geocoded) and the last
  -- check of the installer's GPS against it (JSON: distanceM, ok, at, notified)
  ALTER TABLE work_orders ADD COLUMN location_from TEXT NOT NULL DEFAULT '';
  ALTER TABLE work_orders ADD COLUMN position_check TEXT NOT NULL DEFAULT '';
  `,
  // 21: acceptances of the privacy notice, each with its printable attestation (kept as accepted)
  `
  CREATE TABLE privacy_acceptances(
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    version TEXT NOT NULL,
    text_sha256 TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    document TEXT NOT NULL
  );
  CREATE INDEX privacy_acceptances_user ON privacy_acceptances(user_id, text_sha256);
  `,
  // 22: RADIUS state copied from the CRM (ISP Billing) for the NOC, replaced at every sync
  `
  CREATE TABLE crm_radius(
    account_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL,
    account_status TEXT NOT NULL DEFAULT '',
    profile TEXT NOT NULL DEFAULT '',
    static_ip TEXT NOT NULL DEFAULT '',
    cpe_type TEXT NOT NULL DEFAULT '',
    customer_name TEXT NOT NULL DEFAULT '',
    customer_status TEXT NOT NULL DEFAULT '',
    customer_group TEXT NOT NULL DEFAULT '',
    services_suspended INTEGER NOT NULL DEFAULT 0,
    online INTEGER,
    mac TEXT,
    client_ip TEXT,
    session_seconds INTEGER,
    checked_at TEXT
  );
  CREATE INDEX crm_radius_mac ON crm_radius(mac);
  CREATE INDEX crm_radius_username ON crm_radius(username COLLATE NOCASE);
  `,
  // 23: CRM customers and their addresses (installation sites) for the console "Clienti" page
  `
  ALTER TABLE crm_radius ADD COLUMN address_id TEXT NOT NULL DEFAULT '';
  CREATE TABLE crm_customers(
    customer_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    internal_code TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    phone2 TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    address_line1 TEXT NOT NULL DEFAULT '',
    address_line2 TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',
    state_code TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE crm_addresses(
    address_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    address_line1 TEXT NOT NULL DEFAULT '',
    address_line2 TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',
    state_code TEXT NOT NULL DEFAULT '',
    lat REAL,
    lng REAL,
    is_main INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX crm_addresses_customer ON crm_addresses(customer_id);
  `,
  // 24: Home shortcuts of the app chosen by each account (JSON list of ids; NULL = the defaults)
  `
  ALTER TABLE users ADD COLUMN home_shortcuts TEXT;
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
