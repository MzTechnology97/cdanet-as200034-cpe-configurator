import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Consistent online SQLite backup (VACUUM INTO). Used by the auto-updater before
 * every image change. Usage: node src/cli/backup.ts [label]. Keeps the newest 20.
 */
const dbPath = process.env.DB_PATH ?? './data/cdanet.sqlite';
const dir = process.env.BACKUP_DIR ?? join(dirname(dbPath), 'backups');
const label = (process.argv[2] ?? 'manual').replace(/[^A-Za-z0-9_-]/g, '');
mkdirSync(dir, { recursive: true });
const file = join(dir, `cdanet-${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.sqlite`);
const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
const old = readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort().reverse().slice(20);
for (const f of old) rmSync(join(dir, f), { force: true });
console.log(file);
