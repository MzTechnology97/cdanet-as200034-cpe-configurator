import { HttpError } from '../auth.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * Work groups of specialists (titolare, 17/10/2026, issue #275): the specialists of a group share
 * their airOS templates, their installation history and their calendar; nothing else (their
 * connectors and secrets stay their own) and nothing of CDA Net's. The admins make the groups and
 * choose who is in them, and so does the «direttore tecnico»: a specialist with «visibilità piena»
 * (titolare, 17/10/2026), who sees the work of every specialist. His visibility is his own: the
 * members of his groups never inherit it. Every piece of work keeps its author: whoever leaves the
 * group stops seeing the others' work at once, and they stop seeing his.
 */

export interface WorkGroup {
  id: number;
  name: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  members: Array<{ id: number; username: string; active: boolean }>;
}

export function createWorkGroups(db: Db) {
  const membersOf = (groupId: number) =>
    (
      db
        .prepare('SELECT u.id, u.username, u.active FROM work_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.username COLLATE NOCASE')
        .all(groupId) as Array<{ id: number; username: string; active: number }>
    ).map((m) => ({ id: m.id, username: m.username, active: !!m.active }));
  const view = (r: { id: number; name: string; notes: string; createdAt: string; updatedAt: string }): WorkGroup => ({ ...r, members: membersOf(r.id) });
  const SELECT = 'SELECT id, name, notes, created_at createdAt, updated_at updatedAt FROM work_groups';
  const row = (id: number) => {
    const r = db.prepare(`${SELECT} WHERE id = ?`).get(id) as { id: number; name: string; notes: string; createdAt: string; updatedAt: string } | undefined;
    if (!r) throw new HttpError(404, 'work_group_not_found');
    return r;
  };
  const nameTaken = (name: string, exceptId = 0) => !!db.prepare('SELECT 1 FROM work_groups WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, exceptId);
  /** Only specialists are members of a group (a disabled one stays, his work keeps its author). */
  const checkMembers = (ids: number[]) => {
    for (const id of ids) {
      const u = db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | undefined;
      if (!u) throw new HttpError(400, 'user_not_found', { id });
      if (u.role !== 'specialist') throw new HttpError(400, 'work_group_specialists_only', { id });
    }
  };

  /** One change at a time, all or nothing; the same name written at once by two admins is a 409. */
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      if (/UNIQUE constraint failed: work_groups/.test((e as Error).message)) throw new HttpError(409, 'work_group_name_exists');
      throw e;
    }
  };

  const groups = {
    /** The specialists that may be put in a group (for the page of the groups). */
    specialists() {
      return (db.prepare("SELECT id, username, active, full_view fullView FROM users WHERE role = 'specialist' ORDER BY username COLLATE NOCASE").all() as Array<{ id: number; username: string; active: number; fullView: number }>).map(
        (u) => ({ id: u.id, username: u.username, active: !!u.active, fullView: !!u.fullView }),
      );
    },
    list(): WorkGroup[] {
      return (db.prepare(`${SELECT} ORDER BY name COLLATE NOCASE`).all() as Array<{ id: number; name: string; notes: string; createdAt: string; updatedAt: string }>).map(view);
    },
    get(id: number): WorkGroup {
      return view(row(id));
    },
    /** The groups of a user (none for whoever is not a specialist). */
    ofUser(userId: number): WorkGroup[] {
      return (
        db.prepare(`${SELECT} WHERE id IN (SELECT group_id FROM work_group_members WHERE user_id = ?) ORDER BY name COLLATE NOCASE`).all(userId) as Array<{
          id: number;
          name: string;
          notes: string;
          createdAt: string;
          updatedAt: string;
        }>
      ).map(view);
    },
    /**
     * Whose work a specialist sees: himself and the members of his groups (the one place where this is
     * decided). Only specialists are ever in a group, so CDA Net's installers and admins never appear.
     */
    visibleIds(userId: number): number[] {
      // the «direttore tecnico» (a specialist with «visibilità piena»): every specialist's work
      const me = db.prepare('SELECT role, full_view fullView FROM users WHERE id = ?').get(userId) as { role: string; fullView: number } | undefined;
      if (me?.role === 'specialist' && me.fullView) {
        const all = db.prepare("SELECT id FROM users WHERE role = 'specialist'").all() as Array<{ id: number }>;
        return [...new Set([userId, ...all.map((r) => r.id)])];
      }
      const ids = db
        .prepare(
          `SELECT DISTINCT m2.user_id id FROM work_group_members m1
             JOIN work_group_members m2 ON m2.group_id = m1.group_id
             JOIN users u ON u.id = m2.user_id AND u.role = 'specialist'
            WHERE m1.user_id = ?`,
        )
        .all(userId) as Array<{ id: number }>;
      return [...new Set([userId, ...ids.map((r) => r.id)])];
    },
    /**
     * Whose work orders a specialist sees in his calendar: his own and those of the members of his
     * groups, never those of a member with «visibilità piena» (the director's orders may be CDA
     * Net's, with its customers: they never reach whoever does not see CDA Net's data).
     */
    calendarIds(userId: number): number[] {
      const ids = groups.visibleIds(userId);
      const ok = db.prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND (id = ? OR full_view = 0)`).all(...ids, userId) as Array<{ id: number }>;
      return [...new Set([userId, ...ok.map((r) => r.id)])];
    },
    /** Whether [viewerId] sees the work of [authorId]. */
    sees(viewerId: number, authorId: number | null): boolean {
      return authorId !== null && (authorId === viewerId || groups.visibleIds(viewerId).includes(authorId));
    },
    create(input: { name: string; notes?: string | undefined; members?: number[] | undefined }, by: number): WorkGroup {
      if (nameTaken(input.name)) throw new HttpError(409, 'work_group_name_exists');
      const members = [...new Set(input.members ?? [])];
      checkMembers(members);
      const now = nowIso();
      const id = tx(() => {
        const r = db.prepare('INSERT INTO work_groups(name, notes, created_at, created_by, updated_at) VALUES(?,?,?,?,?)').run(input.name, input.notes ?? '', now, by, now);
        const gid = Number(r.lastInsertRowid);
        for (const u of members) db.prepare('INSERT INTO work_group_members(group_id, user_id, added_at) VALUES(?,?,?)').run(gid, u, now);
        return gid;
      });
      return groups.get(id);
    },
    /** Name, notes and, when given, the whole list of members. */
    update(id: number, input: { name?: string | undefined; notes?: string | undefined; members?: number[] | undefined }) {
      const cur = row(id);
      if (input.name !== undefined && nameTaken(input.name, id)) throw new HttpError(409, 'work_group_name_exists');
      const before = membersOf(id).map((m) => m.id);
      let added: number[] = [];
      let removed: number[] = [];
      if (input.members !== undefined) {
        const next = [...new Set(input.members)];
        checkMembers(next);
        added = next.filter((u) => !before.includes(u));
        removed = before.filter((u) => !next.includes(u));
      }
      tx(() => {
        const now = nowIso();
        for (const u of removed) db.prepare('DELETE FROM work_group_members WHERE group_id = ? AND user_id = ?').run(id, u);
        for (const u of added) db.prepare('INSERT INTO work_group_members(group_id, user_id, added_at) VALUES(?,?,?)').run(id, u, now);
        db.prepare('UPDATE work_groups SET name = ?, notes = ?, updated_at = ? WHERE id = ?').run(input.name ?? cur.name, input.notes ?? cur.notes, now, id);
      });
      return { group: groups.get(id), added, removed };
    },
    remove(id: number) {
      const cur = row(id);
      db.prepare('DELETE FROM work_groups WHERE id = ?').run(id);
      return cur;
    },
  };
  return groups;
}
export type WorkGroups = ReturnType<typeof createWorkGroups>;
