import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db.ts';

/** The schema version before the Specialist role (migration 43 rebuilds users). */
const BEFORE_SPECIALIST = 42;
const now = new Date().toISOString();

const usersSql = (db: DatabaseSync) => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { sql: string }).sql;
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

describe('Specialist role migration', () => {
  it('a new database admits the three roles and nothing else', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    assert.match(usersSql(db), /'specialist'/);
    for (const role of ['admin', 'installer', 'specialist']) {
      db.prepare('INSERT INTO users(username, password_hash, role, created_at) VALUES(?,?,?,?)').run(`u-${role}`, 'x', role, now);
    }
    assert.throws(() => db.prepare('INSERT INTO users(username, password_hash, role, created_at) VALUES(?,?,?,?)').run('u-other', 'x', 'partner', now), /CHECK/);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  });

  it('an existing database keeps its accounts and everything that points to them', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, BEFORE_SPECIALIST);
    assert.doesNotMatch(usersSql(db), /specialist/);
    const add = db.prepare('INSERT INTO users(username, password_hash, role, created_at, token_version, totp_enabled, telegram_chat_id, warehouse_site) VALUES(?,?,?,?,?,?,?,?)');
    const admin = Number(add.run('noc', 'hash-a', 'admin', now, 3, 1, '12345', '').lastInsertRowid);
    const installer = Number(add.run('alfio', 'hash-i', 'installer', now, 7, 0, '', 'Magazzino Alfio').lastInsertRowid);
    // ON DELETE CASCADE and SET NULL children: a DROP TABLE with the keys on would empty them
    db.prepare('INSERT INTO user_modules(user_id, module, enabled, updated_at) VALUES(?,?,?,?)').run(installer, 'coverage', 1, now);
    db.prepare("INSERT INTO auth_devices(id, user_id, secret_hash, name, token_version, created_at) VALUES('dev-1', ?, 'h', 'Pixel', 7, ?)").run(installer, now);
    db.prepare("INSERT INTO saved_checks(kind, user_id, username, name, lat, lon, created_at, updated_at) VALUES('coverage', ?, 'alfio', 'Rossi', 37.5, 14.1, ?, ?)").run(installer, now, now);
    db.prepare("INSERT INTO events(created_at, user_id, action, target, detail) VALUES(?, ?, 'user.create', 'alfio', '')").run(now, admin);

    migrate(db);

    assert.match(usersSql(db), /CHECK\(role IN\('admin','installer','specialist'\)\)/);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(installer) as Record<string, unknown>;
    assert.equal(u.username, 'alfio');
    assert.equal(u.token_version, 7);
    assert.equal(u.warehouse_site, 'Magazzino Alfio');
    assert.equal((db.prepare('SELECT telegram_chat_id t FROM users WHERE id = ?').get(admin) as { t: string }).t, '12345');
    assert.equal(count(db, 'user_modules'), 1);
    assert.equal(count(db, 'auth_devices'), 1);
    assert.equal((db.prepare('SELECT user_id FROM saved_checks').get() as { user_id: number }).user_id, installer);
    assert.equal(count(db, 'events'), 1);
    // the children still point to users (not to a renamed copy), and the keys are on again
    const parents = (db.prepare('PRAGMA foreign_key_list(user_modules)').all() as Array<{ table: string }>).map((f) => f.table);
    assert.deepEqual(parents, ['users']);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    // UNIQUE username still enforced, a specialist can be added, a cascade still works
    assert.throws(() => add.run('alfio', 'x', 'installer', now, 0, 0, '', ''), /UNIQUE/);
    const spec = Number(add.run('carmelo', 'hash-s', 'specialist', now, 0, 0, '', '').lastInsertRowid);
    db.prepare('INSERT INTO user_modules(user_id, module, enabled, updated_at) VALUES(?,?,?,?)').run(spec, 'coverage', 1, now);
    db.prepare('DELETE FROM users WHERE id = ?').run(spec);
    assert.equal(count(db, 'user_modules'), 1);
    assert.throws(() => db.prepare('INSERT INTO user_modules(user_id, module, enabled, updated_at) VALUES(?,?,?,?)').run(9999, 'coverage', 1, now), /FOREIGN KEY/);

    migrate(db); // nothing left to do
    assert.equal(count(db, 'users'), 2);
  });

  it('a v0.5.x database (users without the later columns) is widened too', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ( 'admin' , 'installer' )), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);`);
    db.prepare("INSERT INTO users(username, password_hash, role, created_at) VALUES('old', 'h', 'admin', ?)").run(now);
    migrate(db);
    assert.match(usersSql(db), /'specialist'/);
    assert.equal((db.prepare("SELECT role FROM users WHERE username = 'old'").get() as { role: string }).role, 'admin');
  });

  it('the Specialist archive: his templates, connectors and installations', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    const spec = Number(db.prepare("INSERT INTO users(username, password_hash, role, created_at) VALUES('carmelo', 'h', 'specialist', ?)").run(now).lastInsertRowid);
    const t = Number(
      db.prepare("INSERT INTO specialist_templates(user_id, model, name, template_ciphertext, template_sha256, created_at, updated_at) VALUES(?, 'LiteBeam 5AC', 'Azienda X', 'c', 's', ?, ?)").run(spec, now, now).lastInsertRowid,
    );
    assert.throws(
      () => db.prepare("INSERT INTO specialist_templates(user_id, model, name, template_ciphertext, template_sha256, created_at, updated_at) VALUES(?, 'LiteBeam 5AC', 'azienda x', 'c', 's', ?, ?)").run(spec, now, now),
      /UNIQUE/,
    );
    const c = Number(db.prepare("INSERT INTO specialist_connectors(user_id, kind, name, url, created_at, updated_at) VALUES(?, 'uisp', 'Azienda X', 'https://uisp.x.it', ?, ?)").run(spec, now, now).lastInsertRowid);
    db.prepare("INSERT INTO specialist_jobs(id, user_id, username, created_at, expires_at, connector_id, template_id, model, mac) VALUES('j1', ?, 'carmelo', ?, ?, ?, ?, 'LiteBeam 5AC', 'AA:BB:CC:00:00:01')").run(spec, now, now, c, t);
    // a template or a connector removed: the installation stays, without the link
    db.prepare('DELETE FROM specialist_templates WHERE id = ?').run(t);
    db.prepare('DELETE FROM specialist_connectors WHERE id = ?').run(c);
    const j = db.prepare("SELECT template_id, connector_id, status FROM specialist_jobs WHERE id = 'j1'").get() as { template_id: number | null; connector_id: number | null; status: string };
    assert.deepEqual({ ...j }, { template_id: null, connector_id: null, status: 'prepared' });
  });
});
