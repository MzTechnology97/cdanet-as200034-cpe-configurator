import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROLES } from './domain/roles.ts';

export type Db = DatabaseSync;

/**
 * A migration that is code, not SQL text. [foreignKeysOff]: it rebuilds a table other tables point
 * to, so foreign keys stay off while it runs (a DROP TABLE would otherwise run their ON DELETE
 * actions); their check runs before the commit and must find nothing new.
 */
interface CodeMigration {
  foreignKeysOff?: boolean;
  run: (db: Db) => void;
}

/**
 * The roles of the accounts: the CHECK of users.role written by migration 1 (and by v0.5.x)
 * admitted only admin and installer; the table is rebuilt with the specialist too (SQLite cannot
 * change a CHECK in place). Everything else of the table stays as it is, read from its own SQL.
 */
const ROLE_CHECK = /CHECK\s*\(\s*role\s+IN\s*\(([^)]*)\)\s*\)/i;

function widenRoles(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { sql: string } | undefined;
  if (!row) throw new Error('users table missing');
  const m = ROLE_CHECK.exec(row.sql);
  // no constraint on the role, or already with every role: nothing to rebuild
  if (!m) return;
  const listed = new Set([...(m[1] as string).matchAll(/['"]([a-z_]+)['"]/gi)].map((x) => (x[1] as string).toLowerCase()));
  if (ROLES.every((r) => listed.has(r))) return;
  const sql = row.sql
    .replace(ROLE_CHECK, `CHECK(role IN(${ROLES.map((r) => `'${r}'`).join(',')}))`)
    .replace(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"users"|`users`|\[users\]|users)/i, 'CREATE TABLE users_new');
  if (!/^CREATE TABLE users_new\b/.test(sql)) throw new Error('users table definition not recognised');
  const columns = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => `"${c.name.replace(/"/g, '""')}"`).join(', ');
  const extras = db
    .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'users' AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  db.exec('DROP TABLE IF EXISTS users_new');
  db.exec(sql);
  db.exec(`INSERT INTO users_new(${columns}) SELECT ${columns} FROM users`);
  db.exec('DROP TABLE users');
  db.exec('ALTER TABLE users_new RENAME TO users');
  for (const x of extras) db.exec(x.sql);
}

/**
 * Ordered schema migrations tracked with PRAGMA user_version.
 * Migration 1 recreates the v0.5.x schema with IF NOT EXISTS, so an existing
 * production database is adopted in place without data loss.
 */
const MIGRATIONS: Array<string | CodeMigration> = [
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
  // 25: phones registered for push notifications (Firebase Cloud Messaging tokens)
  `
  CREATE TABLE push_tokens(
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX push_tokens_user ON push_tokens(user_id);
  `,
  // 26: "Modifica e riprova": the new installation that redoes a failed or never written one
  `
  ALTER TABLE provisioning_jobs ADD COLUMN superseded_by TEXT;
  `,
  // 27: the UISP CRM service made for the job's subscriber (a retry reuses it, never a second subscriber)
  `
  ALTER TABLE provisioning_jobs ADD COLUMN uisp_crm_service_id INTEGER;
  `,
  // 28: the other APs a job was prepared for ({ssid: sha256 of its config}): chosen on site, offline
  `
  ALTER TABLE provisioning_jobs ADD COLUMN ssid_options TEXT;
  `,
  // 29: the warehouse of ISP Billing (stock copied every hour) and the one of each installer/partner account
  `
  CREATE TABLE crm_stock(
    stock_id INTEGER PRIMARY KEY,
    site_id INTEGER,
    site TEXT NOT NULL DEFAULT '',
    article TEXT NOT NULL DEFAULT '',
    code TEXT NOT NULL DEFAULT '',
    serial TEXT NOT NULL DEFAULT '',
    mac TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    intended TEXT NOT NULL DEFAULT '',
    since TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX crm_stock_mac ON crm_stock(mac);
  CREATE INDEX crm_stock_site ON crm_stock(site_id);
  ALTER TABLE users ADD COLUMN warehouse_site_id INTEGER;
  ALTER TABLE users ADD COLUMN warehouse_site TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN stock_bypass INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE cpe_movements(
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    mac TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK(kind IN('entrata','uscita','trasferimento','installata','collaudo')),
    from_site TEXT NOT NULL DEFAULT '',
    to_site TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    job_id TEXT
  );
  CREATE INDEX cpe_movements_mac ON cpe_movements(mac, at);
  CREATE INDEX cpe_movements_at ON cpe_movements(at);
  `,
  // 30: every speedtest of the app (acceptance, interventions, network tools) with the Wi-Fi it ran on
  `
  CREATE TABLE speed_tests(
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    measured_at TEXT NOT NULL,
    client_id TEXT UNIQUE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    context TEXT NOT NULL CHECK(context IN('acceptance','work_order','cpe','tool')),
    job_id TEXT,
    work_order_id INTEGER,
    mac TEXT NOT NULL DEFAULT '',
    pppoe_user TEXT NOT NULL DEFAULT '',
    down_mbps REAL,
    up_mbps REAL,
    ping_ms REAL,
    jitter_ms REAL,
    server TEXT NOT NULL DEFAULT '',
    wifi TEXT NOT NULL DEFAULT '{}',
    target TEXT,
    passed INTEGER,
    attempt INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX speed_tests_job ON speed_tests(job_id);
  CREATE INDEX speed_tests_mac ON speed_tests(mac, created_at);
  CREATE INDEX speed_tests_at ON speed_tests(created_at);
  `,
  // Victron VRM: the POPs' solar and battery systems read at every sync, and the POP each one powers
  // (chosen by an admin, kept when an installation is missing from a sync)
  `
  CREATE TABLE victron_sites(
    id_site INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL,
    lon REAL,
    last_ts INTEGER,
    alarms INTEGER NOT NULL DEFAULT 0,
    soc REAL,
    voltage REAL,
    current REAL,
    battery_state TEXT,
    low_soc TEXT,
    pv_w REAL,
    ac_input TEXT,
    seen_at TEXT NOT NULL
  );
  CREATE TABLE victron_links(
    id_site INTEGER PRIMARY KEY,
    pop_id TEXT NOT NULL,
    off_grid INTEGER NOT NULL DEFAULT 0,
    linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    linked_at TEXT NOT NULL
  );
  CREATE INDEX victron_links_pop ON victron_links(pop_id);
  `,
  // the customer's formal name from the CRM («Cognome Nome» or the company name): the CPE's device name
  `
  ALTER TABLE crm_radius ADD COLUMN customer_formal TEXT NOT NULL DEFAULT '';
  `,
  // the UISP CRM client made by a «Nuovo subscriber» whose service failed: the retry reuses it
  `
  ALTER TABLE provisioning_jobs ADD COLUMN uisp_crm_client_id INTEGER;
  `,
  // the coverage of the other operators read for a point or an address (reused for some days):
  // key «ll:lat,lon» (5 decimals) or «geo:<GeoID>»; payload = the address found and the normalised rows
  `
  CREATE TABLE coverage_ops_cache(
    key TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX coverage_ops_cache_at ON coverage_ops_cache(at);
  `,
  // re-pointings: every test of an installation is kept (the current one in job_acceptance, the
  // earlier ones here with their photos); a technician may re-point a CPE installed by someone else
  `
  CREATE TABLE acceptance_history(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'install',
    created_at TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    verdict TEXT NOT NULL,
    data TEXT NOT NULL,
    review TEXT,
    review_reason TEXT NOT NULL DEFAULT '',
    review_at TEXT,
    review_by INTEGER,
    review_note TEXT NOT NULL DEFAULT '',
    work_order_id INTEGER
  );
  CREATE INDEX acceptance_history_job ON acceptance_history(job_id, created_at);
  ALTER TABLE job_acceptance ADD COLUMN kind TEXT NOT NULL DEFAULT 'install';
  ALTER TABLE job_acceptance ADD COLUMN work_order_id INTEGER;
  ALTER TABLE job_photos ADD COLUMN history_id INTEGER;
  CREATE TABLE repoint_grants(
    job_id TEXT NOT NULL REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_at TEXT NOT NULL,
    PRIMARY KEY(job_id, user_id)
  );
  `,
  // the kind of each acceptance photo (antenna, bracket, cabling, router, other): the required ones per test
  `
  ALTER TABLE job_photos ADD COLUMN type TEXT NOT NULL DEFAULT 'other';
  `,
  // the CPEs taken off in a replacement (RMA: to bring back, back, in repair, scrapped, used again)
  // and the minimum of CPEs each account should keep (null: the one of Impostazioni server)
  `
  CREATE TABLE cpe_rma(
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    removed_job_id TEXT NOT NULL UNIQUE,
    replaced_by_job_id TEXT NOT NULL,
    mac TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    customer TEXT NOT NULL DEFAULT '',
    removed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    condition TEXT NOT NULL DEFAULT 'unknown' CHECK(condition IN('unknown','working','broken')),
    state TEXT NOT NULL DEFAULT 'to_return' CHECK(state IN('to_return','returned','repair','scrapped','reused')),
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX cpe_rma_state ON cpe_rma(state);
  ALTER TABLE users ADD COLUMN warehouse_min_stock INTEGER;
  `,
  // the admins' own Claude (MCP connector, read-only monitoring): OAuth clients registered by the
  // Claude apps, one-time codes and the connections (tokens kept as SHA-256 only, revocable)
  `
  CREATE TABLE mcp_clients(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    redirect_uris TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_ip TEXT NOT NULL DEFAULT '',
    last_used_at TEXT
  );
  CREATE TABLE mcp_codes(
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE mcp_tokens(
    id INTEGER PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_version INTEGER NOT NULL,
    access_hash TEXT NOT NULL UNIQUE,
    access_expires TEXT NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE,
    refresh_prev_hash TEXT,
    refresh_expires TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_ip TEXT NOT NULL DEFAULT '',
    last_used_at TEXT,
    calls INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    revoked_by INTEGER
  );
  CREATE INDEX mcp_tokens_user ON mcp_tokens(user_id);
  `,
  // every login attempt (web, app, Claude) and the bans of IPs and devices (fail2ban-like)
  `
  CREATE TABLE login_attempts(
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    ip TEXT NOT NULL,
    device TEXT,
    username TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'web',
    kind TEXT NOT NULL,
    ok INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX login_attempts_ip ON login_attempts(ip, created_at);
  CREATE INDEX login_attempts_device ON login_attempts(device, created_at);
  CREATE TABLE login_bans(
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN('ip','device')),
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    until TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    lifted_at TEXT,
    lifted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX login_bans_value ON login_bans(kind, value);
  `,
  // a Claude connection with «lettura e scrittura» (chosen at the consent): the write tools too
  `
  ALTER TABLE mcp_codes ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mcp_tokens ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0;
  `,
  // every airOS template has its own values (no more server-wide CPE settings): the two forced at
  // every provisioning in params_json, the SNMP community and the UISP key sealed apart.
  // params_version 0 = saved before: converted once at start with the old server values.
  `
  ALTER TABLE profile_templates ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE profile_templates ADD COLUMN secrets_ciphertext TEXT NOT NULL DEFAULT '';
  ALTER TABLE profile_templates ADD COLUMN params_version INTEGER NOT NULL DEFAULT 0;
  `,
  // saved coverage and feasibility checks: a name (written, or the customer's of ISP Billing), the
  // point, how it was checked and the answer as it was when saved (summary for the lists)
  `
  CREATE TABLE saved_checks(
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN('coverage','feasibility')),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_code TEXT NOT NULL DEFAULT '',
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    params TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX saved_checks_kind ON saved_checks(kind, updated_at);
  CREATE INDEX saved_checks_user ON saved_checks(user_id, kind);
  CREATE INDEX saved_checks_customer ON saved_checks(customer_id);
  `,
  // the Specialist role (owner, 17/10/2026): an account that works on its own for other companies
  { foreignKeysOff: true, run: widenRoles },
  // the Specialist's own archive, apart from CDA Net's: his airOS templates (the text sealed like
  // CDA Net's, the SNMP community sealed apart), the connectors of the companies he works for (UISP
  // to begin with, others later: kind checked by the server; token and device key sealed) and his
  // installations. What he types for each CPE (Wi-Fi key, PPPoE and CPE passwords) is never
  // stored: only the SHA-256 of the file written.
  `
  CREATE TABLE specialist_templates(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    name TEXT NOT NULL,
    board_match TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    template_ciphertext TEXT NOT NULL,
    template_sha256 TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    secrets_ciphertext TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX specialist_templates_name ON specialist_templates(user_id, model, name COLLATE NOCASE);
  CREATE TABLE specialist_connectors(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secrets_ciphertext TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_test_at TEXT,
    last_test_ok INTEGER,
    last_test_detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX specialist_connectors_name ON specialist_connectors(user_id, name COLLATE NOCASE);
  CREATE TABLE specialist_jobs(
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','success','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    client TEXT NOT NULL DEFAULT '',
    connector_id INTEGER REFERENCES specialist_connectors(id) ON DELETE SET NULL,
    company TEXT NOT NULL DEFAULT '',
    template_id INTEGER REFERENCES specialist_templates(id) ON DELETE SET NULL,
    template_name TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    mac TEXT NOT NULL,
    serial TEXT NOT NULL DEFAULT '',
    firmware TEXT NOT NULL DEFAULT '',
    device_name TEXT NOT NULL DEFAULT '',
    ssid TEXT NOT NULL DEFAULT '',
    pppoe_user TEXT NOT NULL DEFAULT '',
    customer TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    location_source TEXT NOT NULL DEFAULT '',
    config_sha256 TEXT NOT NULL DEFAULT '',
    stages TEXT NOT NULL DEFAULT '[]',
    detected TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    acceptance_json TEXT,
    acceptance_at TEXT,
    uisp_device_id TEXT,
    uisp_site_id TEXT,
    uisp_site TEXT NOT NULL DEFAULT '',
    uisp_authorized_at TEXT,
    uisp_error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX specialist_jobs_user ON specialist_jobs(user_id, created_at);
  CREATE INDEX specialist_jobs_mac ON specialist_jobs(mac);
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
    const m = MIGRATIONS[v] as string | CodeMigration;
    const keysOff = typeof m !== 'string' && !!m.foreignKeysOff;
    // PRAGMA foreign_keys does nothing inside a transaction: switched before it, back after it
    const keysWereOn = keysOff && (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
    if (keysWereOn) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const broken = () => (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
      const before = keysOff ? broken() : 0;
      if (typeof m === 'string') db.exec(m);
      else m.run(db);
      if (keysOff && broken() > before) throw new Error('foreign_key_check');
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration ${v + 1} failed: ${(err as Error).message}`);
    } finally {
      if (keysWereOn) db.exec('PRAGMA foreign_keys = ON');
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
