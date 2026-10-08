import { HttpError } from '../auth.ts';
import { sha256Hex, type Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';
import { TARGET_FIRMWARE, type CpeModel } from '../domain/policy.ts';
import { inspectTemplate, normalizeTemplate } from '../domain/systemcfg.ts';

/**
 * Named airOS templates, several per model.
 *
 * Visibility: audience 'all' (every installer) or 'users' (only the assigned users;
 * a template assigned to one installer is that installer's personal template).
 * Admins always see and may use every template.
 *
 * Defaults: one global default per model, always visible to everyone. A restricted
 * template can additionally be the default for its assigned users (default_for_assigned).
 */

export type Audience = 'all' | 'users';
export interface Viewer {
  id: number;
  role: string;
}

export interface TemplateMeta {
  id: number;
  model: CpeModel;
  firmware: string;
  name: string;
  boardMatch: string;
  sha256: string;
  isDefault: boolean;
  audience: Audience;
  users: Array<{ id: number; username: string }>;
  defaultForAssigned: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface Row {
  id: number;
  model: CpeModel;
  firmware: string;
  name: string;
  board_match: string;
  template_ciphertext: string;
  template_sha256: string;
  is_default: number;
  audience: Audience;
  default_for_assigned: number;
  created_at: string;
  updated_at: string;
  updated_by_name: string | null;
}

export interface TemplateInput {
  name?: string | undefined;
  template?: string | undefined;
  boardMatch?: string | undefined;
  isDefault?: boolean | undefined;
  audience?: Audience | undefined;
  userIds?: number[] | undefined;
  defaultForAssigned?: boolean | undefined;
}

const SELECT = `SELECT t.*, u.username updated_by_name FROM profile_templates t LEFT JOIN users u ON u.id = t.updated_by`;

export function validateBoardMatch(rx: string): void {
  try {
    new RegExp(rx, 'is');
  } catch {
    throw new HttpError(400, 'board_match_invalid_regex');
  }
}

function checkedTemplate(raw: string) {
  const report = inspectTemplate(raw);
  if (!report.ok) throw new HttpError(400, report.errors[0] as string, { report });
  const text = normalizeTemplate(raw);
  return { text, sha: sha256Hex(text), report };
}

export function createTemplates(db: Db, sealer: Sealer) {
  const assigned = (id: number) =>
    db.prepare('SELECT u.id, u.username FROM template_users tu JOIN users u ON u.id = tu.user_id WHERE tu.template_id = ? ORDER BY u.username').all(id) as Array<{
      id: number;
      username: string;
    }>;
  const meta = (r: Row): TemplateMeta => ({
    id: r.id,
    model: r.model,
    firmware: r.firmware,
    name: r.name,
    boardMatch: r.board_match,
    sha256: r.template_sha256,
    isDefault: !!r.is_default,
    audience: r.audience,
    users: r.audience === 'users' ? assigned(r.id) : [],
    defaultForAssigned: r.audience === 'users' && !!r.default_for_assigned,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by_name,
  });
  const byId = (id: number) => db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
  const mustGet = (id: number) => {
    const r = byId(id);
    if (!r) throw new HttpError(404, 'template_not_found');
    return r;
  };
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  /** Keeps exactly one public global default per model when a public template exists. */
  const ensureDefault = (model: string) => {
    db.prepare("UPDATE profile_templates SET is_default = 0 WHERE model = ? AND firmware = ? AND audience <> 'all'").run(model, TARGET_FIRMWARE);
    const has = db.prepare('SELECT 1 FROM profile_templates WHERE model = ? AND firmware = ? AND is_default = 1').get(model, TARGET_FIRMWARE);
    if (!has) {
      db.prepare(
        `UPDATE profile_templates SET is_default = 1 WHERE id = (
           SELECT id FROM profile_templates WHERE model = ? AND firmware = ? AND audience = 'all' ORDER BY updated_at DESC LIMIT 1)`,
      ).run(model, TARGET_FIRMWARE);
    }
  };
  const makeDefault = (r: Row) => {
    db.prepare('UPDATE profile_templates SET is_default = 0 WHERE model = ? AND firmware = ?').run(r.model, r.firmware);
    db.prepare('UPDATE profile_templates SET is_default = 1 WHERE id = ?').run(r.id);
  };
  const nameTaken = (model: string, name: string, exceptId = 0) =>
    !!db.prepare('SELECT 1 FROM profile_templates WHERE model = ? AND firmware = ? AND name = ? COLLATE NOCASE AND id <> ?').get(model, TARGET_FIRMWARE, name, exceptId);
  const setUsers = (id: number, userIds: number[]) => {
    db.prepare('DELETE FROM template_users WHERE template_id = ?').run(id);
    const ins = db.prepare('INSERT INTO template_users(template_id, user_id) VALUES(?,?)');
    for (const u of new Set(userIds)) ins.run(id, u);
  };
  const checkUsers = (userIds: number[]) => {
    for (const u of new Set(userIds)) {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(u)) throw new HttpError(400, 'template_user_not_found', { userId: u });
    }
  };
  /** Normalises the visibility part of an input against the current state. */
  const visibility = (input: TemplateInput, cur?: Row) => {
    const audience: Audience = input.audience ?? cur?.audience ?? 'all';
    const userIds = audience === 'users' ? (input.userIds ?? (cur ? assigned(cur.id).map((u) => u.id) : [])) : [];
    if (audience === 'users' && userIds.length === 0) throw new HttpError(400, 'template_audience_empty');
    checkUsers(userIds);
    const wantsDefault = input.isDefault ?? false;
    if (audience === 'users' && (wantsDefault || (cur && cur.is_default))) throw new HttpError(409, 'default_must_be_public');
    const defaultForAssigned = audience === 'users' && (input.defaultForAssigned ?? !!cur?.default_for_assigned);
    return { audience, userIds, defaultForAssigned };
  };
  const canUse = (r: Row, viewer: Viewer) =>
    viewer.role === 'admin' || r.audience === 'all' || !!db.prepare('SELECT 1 FROM template_users WHERE template_id = ? AND user_id = ?').get(r.id, viewer.id);
  const personalDefault = (model: string, viewer: Viewer) =>
    db
      .prepare(
        `${SELECT} JOIN template_users tu ON tu.template_id = t.id AND tu.user_id = ?
         WHERE t.model = ? AND t.firmware = ? AND t.audience = 'users' AND t.default_for_assigned = 1
         ORDER BY t.updated_at DESC LIMIT 1`,
      )
      .get(viewer.id, model, TARGET_FIRMWARE) as Row | undefined;
  const globalDefault = (model: string) =>
    db.prepare(`${SELECT} WHERE t.model = ? AND t.firmware = ? AND t.is_default = 1`).get(model, TARGET_FIRMWARE) as Row | undefined;
  /** Template used when the client does not choose one. */
  const effectiveDefault = (model: string, viewer: Viewer) => personalDefault(model, viewer) ?? globalDefault(model);

  return {
    list(model?: CpeModel): TemplateMeta[] {
      const rows = (
        model
          ? db.prepare(`${SELECT} WHERE t.model = ? AND t.firmware = ? ORDER BY t.is_default DESC, t.audience, t.name COLLATE NOCASE`).all(model, TARGET_FIRMWARE)
          : db.prepare(`${SELECT} WHERE t.firmware = ? ORDER BY t.model, t.is_default DESC, t.audience, t.name COLLATE NOCASE`).all(TARGET_FIRMWARE)
      ) as unknown as Row[];
      return rows.map(meta);
    },

    /** Templates a user may use, with the default that applies to that user. Names only. */
    visibleTo(viewer: Viewer) {
      const rows = db.prepare(`${SELECT} WHERE t.firmware = ? ORDER BY t.model, t.name COLLATE NOCASE`).all(TARGET_FIRMWARE) as unknown as Row[];
      const defaults = new Map<string, number | undefined>();
      return rows
        .filter((r) => canUse(r, viewer))
        .map((r) => {
          if (!defaults.has(r.model)) defaults.set(r.model, effectiveDefault(r.model, viewer)?.id);
          return {
            id: r.id,
            model: r.model,
            name: r.name,
            isDefault: defaults.get(r.model) === r.id,
            personal: r.audience === 'users',
          };
        });
    },

    /** Full template text, for the admin editor. */
    get(id: number) {
      const r = mustGet(id);
      return { ...meta(r), template: sealer.open(r.template_ciphertext) };
    },

    create(model: CpeModel, input: TemplateInput & { name: string; template: string; boardMatch: string }, userId: number | null) {
      validateBoardMatch(input.boardMatch);
      if (nameTaken(model, input.name)) throw new HttpError(409, 'template_name_exists');
      const v = visibility(input);
      const { text, sha, report } = checkedTemplate(input.template);
      const now = nowIso();
      const id = tx(() => {
        const r = db
          .prepare(
            `INSERT INTO profile_templates(model, firmware, name, board_match, template_ciphertext, template_sha256, is_default, audience, default_for_assigned, created_at, updated_at, updated_by)
             VALUES(?,?,?,?,?,?,0,?,?,?,?,?)`,
          )
          .run(model, TARGET_FIRMWARE, input.name, input.boardMatch, sealer.seal(text), sha, v.audience, v.defaultForAssigned ? 1 : 0, now, now, userId);
        const id = Number(r.lastInsertRowid);
        setUsers(id, v.userIds);
        if (input.isDefault) makeDefault(mustGet(id));
        ensureDefault(model);
        return id;
      });
      return { ...meta(mustGet(id)), report };
    },

    update(id: number, input: TemplateInput, userId: number | null) {
      const cur = mustGet(id);
      if (input.boardMatch !== undefined) validateBoardMatch(input.boardMatch);
      if (input.name !== undefined && nameTaken(cur.model, input.name, id)) throw new HttpError(409, 'template_name_exists');
      const v = visibility(input, cur);
      const checked = input.template !== undefined ? checkedTemplate(input.template) : null;
      tx(() => {
        db.prepare(
          `UPDATE profile_templates SET name = ?, board_match = ?, template_ciphertext = ?, template_sha256 = ?, audience = ?, default_for_assigned = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        ).run(
          input.name ?? cur.name,
          input.boardMatch ?? cur.board_match,
          checked ? sealer.seal(checked.text) : cur.template_ciphertext,
          checked ? checked.sha : cur.template_sha256,
          v.audience,
          v.defaultForAssigned ? 1 : 0,
          nowIso(),
          userId,
          id,
        );
        setUsers(id, v.userIds);
        if (input.isDefault) makeDefault(cur);
        ensureDefault(cur.model);
      });
      return { ...meta(mustGet(id)), report: checked?.report ?? null };
    },

    remove(id: number) {
      const cur = mustGet(id);
      tx(() => {
        db.prepare('DELETE FROM profile_templates WHERE id = ?').run(id);
        ensureDefault(cur.model);
      });
      return meta(cur);
    },

    /**
     * Template used by a provisioning job: the requested one (same model, visible to
     * the user) or the user's effective default (personal default, else global default).
     */
    resolve(model: CpeModel, templateId: number | undefined, viewer: Viewer) {
      let r: Row | undefined;
      if (templateId) {
        r = db.prepare(`${SELECT} WHERE t.id = ? AND t.model = ? AND t.firmware = ?`).get(templateId, model, TARGET_FIRMWARE) as Row | undefined;
        if (r && !canUse(r, viewer)) throw new HttpError(403, 'template_not_allowed');
      } else {
        r = effectiveDefault(model, viewer);
      }
      if (!r) return null;
      return { id: r.id, name: r.name, boardMatch: r.board_match, sha256: r.template_sha256, ciphertext: r.template_ciphertext };
    },
  };
}
export type Templates = ReturnType<typeof createTemplates>;
