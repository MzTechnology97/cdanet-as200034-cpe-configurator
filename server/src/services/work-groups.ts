import { HttpError } from '../auth.ts';
import { nowIso, type Db } from '../db.ts';

export interface WorkGroupMember {
  id: number;
  username: string;
}

export interface WorkGroup {
  id: number;
  name: string;
  createdAt: string;
  createdBy: string | null;
  members: WorkGroupMember[];
}

/**
 * Work groups of the specialists (#275, titolare 17/10/2026): specialists sharing their templates,
 * their installations and the calendar of their interventions. Only the admins make them and decide
 * who is in them. The data stay their author's (user_id never changes): who leaves a group stops
 * seeing the others' at once, and they stop seeing his. Connectors stay personal. A member is a
 * specialist: an account that changes role drops out of the shared data by itself.
 */
export function createWorkGroups(db: Db) {
  const membersStmt = db.prepare(
    "SELECT u.id, u.username FROM work_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.role = 'specialist' ORDER BY u.username COLLATE NOCASE",
  );
  const groupStmt = db.prepare('SELECT g.id, g.name, g.created_at createdAt, u.username createdBy FROM work_groups g LEFT JOIN users u ON u.id = g.created_by WHERE g.id = ?');
  const visibleStmt = db.prepare(
    `SELECT DISTINCT m2.user_id id FROM work_group_members m1
       JOIN work_group_members m2 ON m2.group_id = m1.group_id
       JOIN users u ON u.id = m2.user_id AND u.role = 'specialist'
     WHERE m1.user_id = ?`,
  );

  const withMembers = (g: Omit<WorkGroup, 'members'>): WorkGroup => ({ ...g, members: membersStmt.all(g.id) as unknown as WorkGroupMember[] });

  const groups = {
    list(): WorkGroup[] {
      const rows = db
        .prepare('SELECT g.id, g.name, g.created_at createdAt, u.username createdBy FROM work_groups g LEFT JOIN users u ON u.id = g.created_by ORDER BY g.name COLLATE NOCASE')
        .all() as unknown as Array<Omit<WorkGroup, 'members'>>;
      return rows.map(withMembers);
    },

    get(id: number): WorkGroup {
      const g = groupStmt.get(id) as Omit<WorkGroup, 'members'> | undefined;
      if (!g) throw new HttpError(404, 'work_group_not_found');
      return withMembers(g);
    },

    create(name: string, by: number): WorkGroup {
      if (db.prepare('SELECT 1 FROM work_groups WHERE name = ? COLLATE NOCASE').get(name)) throw new HttpError(409, 'work_group_exists');
      const r = db.prepare('INSERT INTO work_groups(name, created_at, created_by) VALUES(?, ?, ?)').run(name, nowIso(), by);
      return groups.get(Number(r.lastInsertRowid));
    },

    rename(id: number, name: string): WorkGroup {
      groups.get(id);
      if (db.prepare('SELECT 1 FROM work_groups WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, id)) throw new HttpError(409, 'work_group_exists');
      db.prepare('UPDATE work_groups SET name = ? WHERE id = ?').run(name, id);
      return groups.get(id);
    },

    remove(id: number): WorkGroup {
      const g = groups.get(id);
      db.prepare('DELETE FROM work_groups WHERE id = ?').run(id);
      return g;
    },

    /** The members of [id] become [userIds] (specialists only): who is added and who left. */
    setMembers(id: number, userIds: number[]): { group: WorkGroup; added: WorkGroupMember[]; removed: WorkGroupMember[] } {
      const before = groups.get(id).members;
      const wanted = [...new Set(userIds)];
      for (const uid of wanted) {
        const u = db.prepare('SELECT role FROM users WHERE id = ?').get(uid) as { role: string } | undefined;
        if (!u) throw new HttpError(404, 'user_not_found');
        if (u.role !== 'specialist') throw new HttpError(400, 'work_group_member_not_specialist');
      }
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM work_group_members WHERE group_id = ?').run(id);
        const add = db.prepare('INSERT INTO work_group_members(group_id, user_id, added_at) VALUES(?, ?, ?)');
        const now = nowIso();
        for (const uid of wanted) add.run(id, uid, now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      const group = groups.get(id);
      const had = new Set(before.map((m) => m.id));
      const has = new Set(group.members.map((m) => m.id));
      return { group, added: group.members.filter((m) => !had.has(m.id)), removed: before.filter((m) => !has.has(m.id)) };
    },

    /** The groups of a specialist, with their members (what his pages show). */
    groupsOf(userId: number): WorkGroup[] {
      const ids = db.prepare('SELECT group_id id FROM work_group_members WHERE user_id = ?').all(userId) as Array<{ id: number }>;
      return ids.map((r) => groups.get(r.id)).sort((a, b) => a.name.localeCompare(b.name, 'it'));
    },

    /**
     * The specialists whose templates, installations and calendar [userId] sees: himself and the
     * members of his groups. The one place this is computed (#275).
     */
    visibleSpecialistIds(userId: number): number[] {
      const others = (visibleStmt.all(userId) as Array<{ id: number }>).map((r) => r.id);
      return [...new Set([userId, ...others])];
    },

    /** The names of the groups [userId] is in, for the activity log («gruppo …»). */
    groupNames(userId: number): string[] {
      return (db.prepare('SELECT g.name FROM work_group_members m JOIN work_groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE').all(userId) as Array<{ name: string }>).map((r) => r.name);
    },
  };
  return groups;
}
export type WorkGroups = ReturnType<typeof createWorkGroups>;
