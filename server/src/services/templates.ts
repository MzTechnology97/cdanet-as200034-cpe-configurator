import { HttpError } from '../auth.ts';
import { sha256Hex, type Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';
import { templateFacts, type TemplateParams } from '../domain/airos-form.ts';
import { TARGET_FIRMWARE, type CpeModel } from '../domain/policy.ts';
import { inspectTemplate, normalizeTemplate, RETIRED_PLACEHOLDERS, type RetiredPlaceholder } from '../domain/systemcfg.ts';

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

/** Sealed apart from the text, never returned to the console. */
export interface TemplateSecrets {
  snmpCommunity?: string;
  uispKey?: string;
}
export const DEFAULT_PARAMS: TemplateParams = { watchdogHost: '8.8.8.8', snmpContact: '172.31.0.7' };

/** The server-wide values of before v1.35.11, copied once into every template saved until then. */
export interface LegacyValues {
  retired: Record<RetiredPlaceholder, string>;
  watchdogHost: string;
  snmpContact: string;
  snmpCommunity: string;
  uispKey?: string | undefined;
}
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
  /** What the list shows: Station/AP, Router/Bridge, PtP, the CPE's address. */
  facts: ReturnType<typeof templateFacts>;
  secretsSet: { snmpCommunity: boolean; uispKey: boolean };
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
  params_json: string;
  secrets_ciphertext: string;
  params_version: number;
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
  params?: Partial<TemplateParams> | undefined;
  /** A value replaces the secret, null removes it, absent keeps it. */
  secrets?: { snmpCommunity?: string | null | undefined; uispKey?: string | null | undefined } | undefined;
  /** A copy: the secrets of this template (never sent to the console) go with it. */
  secretsFrom?: number | undefined;
}

const SELECT = `SELECT t.*, u.username updated_by_name FROM profile_templates t LEFT JOIN users u ON u.id = t.updated_by`;

export function validateBoardMatch(rx: string): void {
  try {
    new RegExp(rx, 'is');
  } catch {
    throw new HttpError(400, 'board_match_invalid_regex');
  }
}

function checkedParams(p: Partial<TemplateParams>, base: TemplateParams): TemplateParams {
  const out = { ...base, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as TemplateParams;
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(out.watchdogHost)) throw new HttpError(400, 'form_invalid_watchdogHost');
  if (out.snmpContact.length > 200 || /[\r\n\0]/.test(out.snmpContact) || out.snmpContact.includes('${')) throw new HttpError(400, 'form_invalid_snmpContact');
  return out;
}
function checkedSecret(name: string, v: string) {
  if (v.length > 4096 || /[\r\n\0]/.test(v) || v.includes('${')) throw new HttpError(400, `template_secret_invalid_${name}`);
  return v;
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
  const paramsOf = (r: Row): TemplateParams => ({ ...DEFAULT_PARAMS, ...(JSON.parse(r.params_json || '{}') as Partial<TemplateParams>) });
  const secretsOf = (r: Row): TemplateSecrets => (r.secrets_ciphertext ? (JSON.parse(sealer.open(r.secrets_ciphertext)) as TemplateSecrets) : {});
  const sealSecrets = (x: TemplateSecrets) => (x.snmpCommunity || x.uispKey ? sealer.seal(JSON.stringify(x)) : '');
  const nextSecrets = (cur: TemplateSecrets, input: TemplateInput['secrets']): TemplateSecrets => {
    const out = { ...cur };
    for (const k of ['snmpCommunity', 'uispKey'] as const) {
      const v = input?.[k];
      if (v === null) delete out[k];
      else if (typeof v === 'string' && v !== '') out[k] = checkedSecret(k, v);
    }
    return out;
  };
  // the facts of a text never change: read once per SHA-256
  const factsCache = new Map<string, ReturnType<typeof templateFacts>>();
  const factsOf = (r: Row) => {
    let f = factsCache.get(r.template_sha256);
    if (!f) {
      f = templateFacts(sealer.open(r.template_ciphertext));
      factsCache.set(r.template_sha256, f);
    }
    return f;
  };
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
    facts: factsOf(r),
    secretsSet: (() => {
      const x = secretsOf(r);
      return { snmpCommunity: !!x.snmpCommunity, uispKey: !!x.uispKey };
    })(),
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
      return { ...meta(r), template: sealer.open(r.template_ciphertext), params: paramsOf(r) };
    },

    create(model: CpeModel, input: TemplateInput & { name: string; template: string; boardMatch: string }, userId: number | null) {
      validateBoardMatch(input.boardMatch);
      if (nameTaken(model, input.name)) throw new HttpError(409, 'template_name_exists');
      const v = visibility(input);
      const { text, sha, report } = checkedTemplate(input.template);
      const params = checkedParams(input.params ?? {}, DEFAULT_PARAMS);
      const secrets = nextSecrets(input.secretsFrom ? secretsOf(mustGet(input.secretsFrom)) : {}, input.secrets);
      // as the server did when SNMP_COMMUNITY was not set: the console asks to change it
      if (!secrets.snmpCommunity) secrets.snmpCommunity = 'public';
      const now = nowIso();
      const id = tx(() => {
        const r = db
          .prepare(
            `INSERT INTO profile_templates(model, firmware, name, board_match, template_ciphertext, template_sha256, is_default, audience, default_for_assigned, created_at, updated_at, updated_by, params_json, secrets_ciphertext, params_version)
             VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?,?,1)`,
          )
          .run(model, TARGET_FIRMWARE, input.name, input.boardMatch, sealer.seal(text), sha, v.audience, v.defaultForAssigned ? 1 : 0, now, now, userId, JSON.stringify(params), sealSecrets(secrets));
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
      const params = input.params ? checkedParams(input.params, paramsOf(cur)) : paramsOf(cur);
      const secrets = input.secrets ? nextSecrets(secretsOf(cur), input.secrets) : secretsOf(cur);
      if (input.secrets && !secrets.snmpCommunity) throw new HttpError(400, 'template_snmp_community_required');
      tx(() => {
        db.prepare(
          `UPDATE profile_templates SET name = ?, board_match = ?, template_ciphertext = ?, template_sha256 = ?, audience = ?, default_for_assigned = ?, updated_at = ?, updated_by = ?, params_json = ?, secrets_ciphertext = ? WHERE id = ?`,
        ).run(
          input.name ?? cur.name,
          input.boardMatch ?? cur.board_match,
          checked ? sealer.seal(checked.text) : cur.template_ciphertext,
          checked ? checked.sha : cur.template_sha256,
          v.audience,
          v.defaultForAssigned ? 1 : 0,
          nowIso(),
          userId,
          JSON.stringify(params),
          input.secrets ? sealSecrets(secrets) : cur.secrets_ciphertext,
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
      return { id: r.id, name: r.name, boardMatch: r.board_match, sha256: r.template_sha256, ciphertext: r.template_ciphertext, params: paramsOf(r), secrets: secretsOf(r) };
    },

    /** The template a finished job used (by name: the job keeps the name), for the drift check. */
    byName(model: string, name: string) {
      const r = db.prepare(`${SELECT} WHERE t.model = ? AND t.name = ? AND t.firmware = ?`).get(model, name, TARGET_FIRMWARE) as Row | undefined;
      return r ? { text: sealer.open(r.template_ciphertext), params: paramsOf(r), secrets: secretsOf(r) } : null;
    },

    /** Where the CPEs answer after their template (the field tools try these addresses), default first. */
    addresses() {
      const rows = db.prepare(`${SELECT} WHERE t.firmware = ? ORDER BY t.is_default DESC, t.updated_at DESC`).all(TARGET_FIRMWARE) as unknown as Row[];
      return rows.map((r) => factsOf(r));
    },

    /**
     * Templates saved before v1.35.11 used the server's values (LAN, DHCP, ports, watchdog, SNMP,
     * UISP): they get them as their own, once. [check] renders before and after and must find the
     * same bytes; a template that does not stays as it was (and is reported).
     */
    convertLegacy(old: LegacyValues, check: (before: string, after: { text: string; params: TemplateParams; secrets: TemplateSecrets }) => boolean) {
      const rows = db.prepare(`${SELECT} WHERE t.params_version = 0`).all() as unknown as Row[];
      const done: Array<{ id: number; model: string; name: string }> = [];
      const failed: Array<{ id: number; model: string; name: string }> = [];
      const retired = new Set<string>(RETIRED_PLACEHOLDERS);
      for (const r of rows) {
        const before = sealer.open(r.template_ciphertext);
        // one pass, like the rendering: a value is never expanded again
        const text = before.replace(/\$\{([A-Z0-9_]+)\}/g, (m, name: string) => (retired.has(name) ? old.retired[name as RetiredPlaceholder] : m));
        const params: TemplateParams = { watchdogHost: old.watchdogHost, snmpContact: old.snmpContact };
        const secrets: TemplateSecrets = { snmpCommunity: old.snmpCommunity, ...(old.uispKey ? { uispKey: old.uispKey } : {}) };
        if (!check(before, { text, params, secrets })) {
          failed.push({ id: r.id, model: r.model, name: r.name });
          continue;
        }
        db.prepare('UPDATE profile_templates SET template_ciphertext = ?, template_sha256 = ?, params_json = ?, secrets_ciphertext = ?, params_version = 1 WHERE id = ?').run(
          sealer.seal(text),
          sha256Hex(text),
          JSON.stringify(params),
          sealSecrets(secrets),
          r.id,
        );
        done.push({ id: r.id, model: r.model, name: r.name });
      }
      return { done, failed };
    },
  };
}
export type Templates = ReturnType<typeof createTemplates>;
