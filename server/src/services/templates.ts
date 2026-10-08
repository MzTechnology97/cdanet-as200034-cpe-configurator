import { HttpError } from '../auth.ts';
import { sha256Hex, type Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';
import { TARGET_FIRMWARE, type CpeModel } from '../domain/policy.ts';
import { inspectTemplate, normalizeTemplate } from '../domain/systemcfg.ts';

/** Named airOS templates: several per model, exactly one default when any exists. */

export interface TemplateMeta {
  id: number;
  model: CpeModel;
  firmware: string;
  name: string;
  boardMatch: string;
  sha256: string;
  isDefault: boolean;
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
  created_at: string;
  updated_at: string;
  updated_by_name: string | null;
}

const SELECT = `SELECT t.*, u.username updated_by_name FROM profile_templates t LEFT JOIN users u ON u.id = t.updated_by`;

const meta = (r: Row): TemplateMeta => ({
  id: r.id,
  model: r.model,
  firmware: r.firmware,
  name: r.name,
  boardMatch: r.board_match,
  sha256: r.template_sha256,
  isDefault: !!r.is_default,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by_name,
});

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
  const ensureDefault = (model: string) => {
    const has = db.prepare('SELECT 1 FROM profile_templates WHERE model = ? AND firmware = ? AND is_default = 1').get(model, TARGET_FIRMWARE);
    if (!has) {
      db.prepare(
        `UPDATE profile_templates SET is_default = 1 WHERE id = (
           SELECT id FROM profile_templates WHERE model = ? AND firmware = ? ORDER BY updated_at DESC LIMIT 1)`,
      ).run(model, TARGET_FIRMWARE);
    }
  };
  const makeDefault = (r: Row) => {
    db.prepare('UPDATE profile_templates SET is_default = 0 WHERE model = ? AND firmware = ?').run(r.model, r.firmware);
    db.prepare('UPDATE profile_templates SET is_default = 1 WHERE id = ?').run(r.id);
  };
  const nameTaken = (model: string, name: string, exceptId = 0) =>
    !!db.prepare('SELECT 1 FROM profile_templates WHERE model = ? AND firmware = ? AND name = ? COLLATE NOCASE AND id <> ?').get(model, TARGET_FIRMWARE, name, exceptId);

  return {
    list(model?: CpeModel): TemplateMeta[] {
      const rows = (
        model
          ? db.prepare(`${SELECT} WHERE t.model = ? AND t.firmware = ? ORDER BY t.is_default DESC, t.name COLLATE NOCASE`).all(model, TARGET_FIRMWARE)
          : db.prepare(`${SELECT} WHERE t.firmware = ? ORDER BY t.model, t.is_default DESC, t.name COLLATE NOCASE`).all(TARGET_FIRMWARE)
      ) as unknown as Row[];
      return rows.map(meta);
    },

    /** Full template text, for the admin editor. */
    get(id: number) {
      const r = mustGet(id);
      return { ...meta(r), template: sealer.open(r.template_ciphertext) };
    },

    create(model: CpeModel, input: { name: string; template: string; boardMatch: string; isDefault?: boolean | undefined }, userId: number | null) {
      validateBoardMatch(input.boardMatch);
      if (nameTaken(model, input.name)) throw new HttpError(409, 'template_name_exists');
      const { text, sha, report } = checkedTemplate(input.template);
      const now = nowIso();
      const id = tx(() => {
        const r = db
          .prepare(
            `INSERT INTO profile_templates(model, firmware, name, board_match, template_ciphertext, template_sha256, is_default, created_at, updated_at, updated_by)
             VALUES(?,?,?,?,?,?,0,?,?,?)`,
          )
          .run(model, TARGET_FIRMWARE, input.name, input.boardMatch, sealer.seal(text), sha, now, now, userId);
        const id = Number(r.lastInsertRowid);
        if (input.isDefault) makeDefault(mustGet(id));
        ensureDefault(model);
        return id;
      });
      return { ...meta(mustGet(id)), report };
    },

    update(id: number, input: { name?: string | undefined; template?: string | undefined; boardMatch?: string | undefined; isDefault?: boolean | undefined }, userId: number | null) {
      const cur = mustGet(id);
      if (input.boardMatch !== undefined) validateBoardMatch(input.boardMatch);
      if (input.name !== undefined && nameTaken(cur.model, input.name, id)) throw new HttpError(409, 'template_name_exists');
      const checked = input.template !== undefined ? checkedTemplate(input.template) : null;
      tx(() => {
        db.prepare(
          `UPDATE profile_templates SET name = ?, board_match = ?, template_ciphertext = ?, template_sha256 = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        ).run(
          input.name ?? cur.name,
          input.boardMatch ?? cur.board_match,
          checked ? sealer.seal(checked.text) : cur.template_ciphertext,
          checked ? checked.sha : cur.template_sha256,
          nowIso(),
          userId,
          id,
        );
        if (input.isDefault) makeDefault(cur);
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

    /** Template used by a provisioning job: the requested one (same model) or the model default. */
    resolve(model: CpeModel, templateId?: number) {
      const r = templateId
        ? (db.prepare(`${SELECT} WHERE t.id = ? AND t.model = ? AND t.firmware = ?`).get(templateId, model, TARGET_FIRMWARE) as Row | undefined)
        : (db.prepare(`${SELECT} WHERE t.model = ? AND t.firmware = ? AND t.is_default = 1`).get(model, TARGET_FIRMWARE) as Row | undefined);
      if (!r) return null;
      return { id: r.id, name: r.name, boardMatch: r.board_match, sha256: r.template_sha256, ciphertext: r.template_ciphertext };
    },
  };
}
export type Templates = ReturnType<typeof createTemplates>;
