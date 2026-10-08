import { readFileSync } from 'node:fs';
import { hashPassword } from '../crypto.ts';
import { nowIso, openDatabase } from '../db.ts';

/**
 * Resets (or creates) an admin account without touching other data.
 * Reads two lines from stdin: username, password. Used by deploy/reset-admin-password.sh.
 */
const [username = '', password = ''] = readFileSync(0, 'utf8').split(/\r?\n/);
if (!/^[A-Za-z0-9._-]{3,80}$/.test(username.trim())) throw new Error('Username admin non valido');
if (password.length < 14 || password.length > 200) throw new Error('Password admin: 14-200 caratteri');

const db = openDatabase(process.env.DB_PATH ?? './data/cdanet.sqlite');
const user = username.trim();
const found = db.prepare('SELECT id FROM users WHERE username = ?').get(user);
if (found) {
  db.prepare("UPDATE users SET password_hash = ?, role = 'admin', active = 1, token_version = token_version + 1 WHERE username = ?").run(
    hashPassword(password),
    user,
  );
} else {
  db.prepare("INSERT INTO users(username, password_hash, role, active, created_at) VALUES(?, ?, 'admin', 1, ?)").run(user, hashPassword(password), nowIso());
}
db.close();
console.log(`Admin aggiornato: ${user}`);
