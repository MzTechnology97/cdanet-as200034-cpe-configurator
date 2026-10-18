import { randomUUID } from 'node:crypto';
import { HttpError } from '../auth.ts';
import type { Config } from '../config.ts';
import { md5Crypt, sha256Hex, type Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';
import { templateFacts, templateSsid } from '../domain/airos-form.ts';
import { BOARD_MATCH_SUGGESTIONS, TARGET_FIRMWARE, macSiblings, type CpeModel } from '../domain/policy.ts';
import { askedFor, inspectFreeTemplate, isSsid, isUispKey, isWpa2Key, OPTIONAL_PLACEHOLDERS, renderFreeCfg, unusedPlaceholders } from '../domain/specialist-cfg.ts';
import { normalizeTemplate } from '../domain/systemcfg.ts';
import { isPrivateIPv4, isPrivateIPv6 } from '../net/ip.ts';
import { insecureFetch } from './connectors.ts';
import { validateBoardMatch } from './templates.ts';
import { createUisp, type Uisp, type UispDevice } from './uisp.ts';

/**
 * The Specialist's section (owner, 17/10/2026): he works on his own for other companies, with CPEs
 * that are not CDA Net's. Everything here belongs to the specialist who made it and is apart from
 * CDA Net's history, statistics, NOC, warehouse and Salute CPE:
 *
 * - his airOS templates (the text sealed like CDA Net's, the SNMP community sealed apart);
 * - the connectors of the companies he works for (UISP to begin with, one per company: token and
 *   device key sealed, never returned);
 * - his installations: what was written into which CPE, the optional acceptance test and the
 *   authorization in the company's UISP. The Wi-Fi key, the PPPoE and CPE passwords he types for
 *   each CPE go into the file written and are never stored: only its SHA-256 is.
 */

export interface SpecialistTemplateInput {
  model?: CpeModel;
  name?: string;
  template?: string;
  boardMatch?: string;
  notes?: string;
  /** A value replaces the community, null removes it, absent keeps it. */
  snmpCommunity?: string | null;
  /** The Wi-Fi key of the company's AP (titolare, 17/10/2026): sealed like the community, never returned. */
  wpa2Psk?: string | null;
}

export interface ConnectorInput {
  name?: string;
  url?: string;
  /** Empty or absent: the saved one stays. */
  token?: string;
  /** The UISP key of the company's devices (wss://…): empty keeps it, null removes it. */
  uispKey?: string | null;
  ignoreTls?: boolean;
  enabled?: boolean;
}

export interface JobInput {
  templateId: number;
  connectorId?: number | null | undefined;
  company?: string | undefined;
  model: CpeModel;
  /**
   * Absent (with serial, firmware and host): prepared before connecting to the CPE (titolare,
   * 17/10/2026); the app reads them from the CPE at the write and they come with the outcome.
   */
  mac?: string | undefined;
  serial?: string | undefined;
  firmware?: string | undefined;
  host?: string | undefined;
  sshPort?: number | undefined;
  /** The CPE's credentials after the configuration (they also fill the template's placeholders). */
  cpe: { username: string; password: string };
  values: Record<string, string>;
  customer?: string | undefined;
  notes?: string | undefined;
  location?: { latitude: number; longitude: number; accuracy?: number | undefined; source: 'gps' | 'address' | 'manual' } | undefined;
}

export interface JobResultInput {
  result: 'success' | 'failed';
  stages: string[];
  error: string;
  detected: { firmware?: string | undefined; board?: string | undefined; mac?: string | undefined };
  completedAt?: string | undefined;
  /** The CPE written, read by the app, for a configuration prepared before connecting to it. */
  cpe?: { mac: string; serial?: string | undefined } | undefined;
}

interface TemplateRow {
  id: number;
  user_id: number;
  model: CpeModel;
  name: string;
  board_match: string;
  notes: string;
  template_ciphertext: string;
  template_sha256: string;
  secrets_ciphertext: string;
  created_at: string;
  updated_at: string;
  jobs?: number;
  author?: string | null;
  cda_source_id?: number | null;
}

interface ConnectorRow {
  id: number;
  user_id: number;
  kind: string;
  name: string;
  url: string;
  secrets_ciphertext: string;
  options_json: string;
  enabled: number;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_detail: string;
  created_at: string;
  updated_at: string;
  jobs?: number;
}

interface JobRow {
  id: string;
  user_id: number | null;
  username: string;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  status: 'prepared' | 'success' | 'failed';
  attempts: number;
  client: string;
  connector_id: number | null;
  company: string;
  template_id: number | null;
  template_name: string;
  model: string;
  mac: string;
  serial: string;
  firmware: string;
  device_name: string;
  ssid: string;
  pppoe_user: string;
  customer: string;
  notes: string;
  latitude: number | null;
  longitude: number | null;
  location_source: string;
  config_sha256: string;
  stages: string;
  detected: string;
  error: string;
  acceptance_json: string | null;
  acceptance_at: string | null;
  uisp_device_id: string | null;
  uisp_site_id: string | null;
  uisp_site: string;
  uisp_authorized_at: string | null;
  uisp_error: string;
  /** Prepared before connecting to the CPE: MAC and serial come with the outcome. */
  cpe_at_write: number;
  /** Written with UISP off (no key of the company): nothing to authorize. */
  uisp_off: number;
  connector_name?: string | null;
}

/** Kinds of connector of the specialist: UISP now, the next ones to be decided. */
export const CONNECTOR_KINDS = ['uisp'] as const;

const json = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** Strips anything that looks like a credential from text sent by the app. */
const clean = (text: string) =>
  text
    .replace(/((?:password|passwd|secret|psk|token|community|key)\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);

/**
 * The specialists of a work group may change each other's templates (true) or only see and use
 * them (false). Carmelo, 18/10/2026: only their author changes them, because whoever changes the
 * text decides where the server writes the author's secrets (community, UISP key, CPE password) at
 * his installations. Deleting a template is always for its author only.
 */
export const GROUP_EDITS_TEMPLATES = false;

export function createSpecialist(
  db: Db,
  cfg: Config,
  sealer: Sealer,
  opts: {
    fetchImpl?: typeof fetch | undefined;
    /** Whose work a specialist sees: himself and the members of his work groups (issue #275). */
    visibleIds?: ((userId: number) => number[]) | undefined;
    /** Whether a specialist may use a CDA Net template himself (his own visibility, never a member's). */
    canUseCda?: ((userId: number, templateId: number) => boolean) | undefined;
  } = {},
) {
  const visible = (userId: number) => opts.visibleIds?.(userId) ?? [userId];
  /**
   * A copy of a CDA Net template is CDA Net's work: only for whoever may use that original himself,
   * its author too (a copy made before the full view was needed waits for it). «Visibilità piena» is
   * personal, never passed on through a group.
   */
  const sharedOk = (userId: number, r: TemplateRow) => r.cda_source_id == null || (opts.canUseCda?.(userId, r.cda_source_id) ?? false);
  const inList = (ids: number[]) => ids.map(() => '?').join(',');
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

  // ---- templates -------------------------------------------------------------------------------
  /** The secrets of a template, sealed apart from its text and never returned: its author's (issue #275). */
  type TemplateSecrets = { snmpCommunity?: string; wpa2Psk?: string };
  const templateSecrets = (r: TemplateRow): TemplateSecrets => (r.secrets_ciphertext ? json(sealer.open(r.secrets_ciphertext), {}) : {});
  const sealSecrets = (x: TemplateSecrets) => (x.snmpCommunity || x.wpa2Psk ? sealer.seal(JSON.stringify(x)) : '');
  /**
   * A template as [viewerId] sees it. Its secrets (the SNMP community) belong to its author: only he
   * sets them and only his installations use them; another member of the group types them in his
   * own flow (titolare, 17/10/2026). Never returned to anyone.
   */
  const templateMeta = (r: TemplateRow, viewerId: number) => {
    const text = sealer.open(r.template_ciphertext);
    const report = inspectFreeTemplate(text);
    const secrets = templateSecrets(r);
    return {
      id: r.id,
      model: r.model,
      name: r.name,
      boardMatch: r.board_match,
      notes: r.notes,
      sha256: r.template_sha256,
      facts: templateFacts(text),
      placeholders: report.placeholders,
      own: report.own,
      secretsSet: { snmpCommunity: !!secrets.snmpCommunity, wpa2Psk: !!secrets.wpa2Psk },
      jobs: r.jobs ?? 0,
      /** Who made it: another member of a work group, or the specialist himself. */
      authorId: r.user_id,
      author: r.author ?? '',
      /** His own: he deletes it and sets its secrets, his installations use them. */
      mine: r.user_id === viewerId,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  };
  const TEMPLATE_SELECT =
    'SELECT t.*, (SELECT count(*) FROM specialist_jobs j WHERE j.template_id = t.id) jobs, (SELECT username FROM users u WHERE u.id = t.user_id) author FROM specialist_templates t';
  /** A template of the specialist, or ([shared]) of a member of his work groups too. */
  const templateRow = (userId: number, id: number, shared = true) => {
    const ids = shared ? visible(userId) : [userId];
    const r = db.prepare(`${TEMPLATE_SELECT} WHERE t.id = ? AND t.user_id IN (${inList(ids)})`).get(id, ...ids) as TemplateRow | undefined;
    if (!r || !sharedOk(userId, r)) throw new HttpError(404, 'template_not_found');
    return r;
  };
  const checkedText = (raw: string) => {
    const report = inspectFreeTemplate(raw);
    if (!report.ok) throw new HttpError(400, report.errors[0] as string, { report });
    const text = normalizeTemplate(raw);
    return { text, sha: sha256Hex(text), report };
  };
  const checkedCommunity = (v: string) => {
    if (v.length > 200 || /[\r\n\0]/.test(v) || v.includes('${')) throw new HttpError(400, 'template_secret_invalid_snmpCommunity');
    return v;
  };
  /** A value replaces a secret, null removes it, absent (or empty) keeps it. */
  const changesSecrets = (input: SpecialistTemplateInput) => [input.snmpCommunity, input.wpa2Psk].some((v) => v === null || (typeof v === 'string' && v !== ''));
  const nextSecrets = (cur: TemplateSecrets, input: SpecialistTemplateInput): TemplateSecrets => {
    const out: TemplateSecrets = { ...cur };
    if (input.snmpCommunity === null) delete out.snmpCommunity;
    else if (typeof input.snmpCommunity === 'string' && input.snmpCommunity !== '') out.snmpCommunity = checkedCommunity(input.snmpCommunity);
    if (input.wpa2Psk === null) delete out.wpa2Psk;
    else if (typeof input.wpa2Psk === 'string' && input.wpa2Psk !== '') {
      if (!isWpa2Key(input.wpa2Psk)) throw new HttpError(400, 'template_secret_invalid_wpa2Psk');
      out.wpa2Psk = input.wpa2Psk;
    }
    return out;
  };
  const nameTaken = (userId: number, model: string, name: string, exceptId = 0) =>
    !!db.prepare('SELECT 1 FROM specialist_templates WHERE user_id = ? AND model = ? AND name = ? COLLATE NOCASE AND id <> ?').get(userId, model, name, exceptId);

  const templates = {
    /** His templates and those of the members of his work groups. */
    list(userId: number) {
      const ids = visible(userId);
      return (db.prepare(`${TEMPLATE_SELECT} WHERE t.user_id IN (${inList(ids)}) ORDER BY t.model, t.name COLLATE NOCASE`).all(...ids) as unknown as TemplateRow[])
        .filter((r) => sharedOk(userId, r))
        .map((r) => templateMeta(r, userId));
    },

    get(userId: number, id: number) {
      const r = templateRow(userId, id);
      return { ...templateMeta(r, userId), template: sealer.open(r.template_ciphertext) };
    },

    create(userId: number, input: SpecialistTemplateInput & { model: CpeModel; name: string; template: string; cdaSourceId?: number | undefined }) {
      if (nameTaken(userId, input.model, input.name)) throw new HttpError(409, 'template_name_exists');
      const boardMatch = input.boardMatch ?? BOARD_MATCH_SUGGESTIONS[input.model];
      validateBoardMatch(boardMatch);
      const { text, sha, report } = checkedText(input.template);
      const secrets = nextSecrets({}, input);
      const now = nowIso();
      const r = db
        .prepare(
          `INSERT INTO specialist_templates(user_id, model, name, board_match, notes, template_ciphertext, template_sha256, secrets_ciphertext, created_at, updated_at, cda_source_id)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(userId, input.model, input.name, boardMatch, input.notes ?? '', sealer.seal(text), sha, sealSecrets(secrets), now, now, input.cdaSourceId ?? null);
      return { ...templates.get(userId, Number(r.lastInsertRowid)), report };
    },

    update(userId: number, id: number, input: SpecialistTemplateInput) {
      const cur = templateRow(userId, id);
      // only its author changes a template (Carmelo, 18/10/2026): whoever changes the text decides
      // where the server writes the author's secrets at his installations
      if (cur.user_id !== userId && !GROUP_EDITS_TEMPLATES) throw new HttpError(403, 'template_author_only');
      // names are unique for each author: a member renaming a shared template checks the author's
      if (input.name !== undefined && nameTaken(cur.user_id, cur.model, input.name, id)) throw new HttpError(409, 'template_name_exists');
      if (input.boardMatch !== undefined) validateBoardMatch(input.boardMatch);
      // the secrets are the author's: another member neither sets nor clears them
      if (changesSecrets(input) && cur.user_id !== userId) throw new HttpError(403, 'template_secrets_author_only');
      const checked = input.template !== undefined ? checkedText(input.template) : null;
      const secretsCipher = changesSecrets(input) ? sealSecrets(nextSecrets(templateSecrets(cur), input)) : cur.secrets_ciphertext;
      db.prepare(
        'UPDATE specialist_templates SET name = ?, board_match = ?, notes = ?, template_ciphertext = ?, template_sha256 = ?, secrets_ciphertext = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ).run(
        input.name ?? cur.name,
        input.boardMatch ?? cur.board_match,
        input.notes ?? cur.notes,
        checked ? sealer.seal(checked.text) : cur.template_ciphertext,
        checked ? checked.sha : cur.template_sha256,
        secretsCipher,
        nowIso(),
        id,
        cur.user_id,
      );
      return { ...templates.get(userId, id), report: checked?.report ?? null };
    },

    /** Only its author deletes a template, also when it is shared in a work group. */
    remove(userId: number, id: number) {
      const cur = templateRow(userId, id, false);
      db.prepare('DELETE FROM specialist_templates WHERE id = ? AND user_id = ?').run(id, userId);
      return templateMeta(cur, userId);
    },
  };

  // ---- connectors ------------------------------------------------------------------------------
  const connectorSecrets = (r: ConnectorRow): { token?: string; uispKey?: string } => (r.secrets_ciphertext ? json(sealer.open(r.secrets_ciphertext), {}) : {});
  const connectorView = (r: ConnectorRow) => {
    const s = connectorSecrets(r);
    const o = json<{ ignoreTls?: boolean }>(r.options_json, {});
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      url: r.url,
      enabled: !!r.enabled,
      ignoreTls: !!o.ignoreTls,
      tokenSet: !!s.token,
      tokenHint: s.token ? `…${s.token.slice(-4)}` : '',
      uispKeySet: !!s.uispKey,
      lastTest: r.last_test_at ? { at: r.last_test_at, ok: !!r.last_test_ok, detail: r.last_test_detail } : null,
      jobs: r.jobs ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  };
  const CONNECTOR_SELECT = 'SELECT c.*, (SELECT count(*) FROM specialist_jobs j WHERE j.connector_id = c.id) jobs FROM specialist_connectors c';
  const connectorRow = (userId: number, id: number) => {
    const r = db.prepare(`${CONNECTOR_SELECT} WHERE c.id = ? AND c.user_id = ?`).get(id, userId) as ConnectorRow | undefined;
    if (!r) throw new HttpError(404, 'connector_not_found');
    return r;
  };
  const checkedUispKey = (v: string) => {
    if (v.length > 2000 || /[\r\n\0\s]/.test(v) || !/^wss:\/\//i.test(v)) throw new HttpError(400, 'uisp_key_invalid');
    return v;
  };
  // one client per connector and version of it (a saved change makes a new one)
  const clients = new Map<number, { at: string; client: Uisp }>();
  const build = (url: string, token: string, ignoreTls: boolean): Uisp =>
    createUisp({ url, token, cacheSeconds: 20, fetchImpl: ignoreTls ? insecureFetch() : opts.fetchImpl });

  const connectors = {
    list(userId: number) {
      return (db.prepare(`${CONNECTOR_SELECT} WHERE c.user_id = ? ORDER BY c.name COLLATE NOCASE`).all(userId) as unknown as ConnectorRow[]).map(connectorView);
    },

    get(userId: number, id: number) {
      return connectorView(connectorRow(userId, id));
    },

    create(userId: number, input: ConnectorInput & { name: string; url: string; token: string }) {
      if (db.prepare('SELECT 1 FROM specialist_connectors WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, input.name)) throw new HttpError(409, 'connector_name_exists');
      const secrets = { token: input.token, ...(input.uispKey ? { uispKey: checkedUispKey(input.uispKey) } : {}) };
      const now = nowIso();
      const r = db
        .prepare('INSERT INTO specialist_connectors(user_id, kind, name, url, secrets_ciphertext, options_json, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(userId, 'uisp', input.name, input.url, sealer.seal(JSON.stringify(secrets)), JSON.stringify({ ignoreTls: !!input.ignoreTls }), input.enabled === false ? 0 : 1, now, now);
      return connectors.get(userId, Number(r.lastInsertRowid));
    },

    update(userId: number, id: number, input: ConnectorInput) {
      const cur = connectorRow(userId, id);
      if (input.name !== undefined && db.prepare('SELECT 1 FROM specialist_connectors WHERE user_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(userId, input.name, id)) {
        throw new HttpError(409, 'connector_name_exists');
      }
      const s = connectorSecrets(cur);
      if (input.token) s.token = input.token;
      if (input.uispKey === null) delete s.uispKey;
      else if (input.uispKey) s.uispKey = checkedUispKey(input.uispKey);
      const o = json<{ ignoreTls?: boolean }>(cur.options_json, {});
      if (input.ignoreTls !== undefined) o.ignoreTls = input.ignoreTls;
      db.prepare('UPDATE specialist_connectors SET name = ?, url = ?, secrets_ciphertext = ?, options_json = ?, enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
        input.name ?? cur.name,
        input.url ?? cur.url,
        sealer.seal(JSON.stringify(s)),
        JSON.stringify(o),
        input.enabled === undefined ? cur.enabled : input.enabled ? 1 : 0,
        nowIso(),
        id,
        userId,
      );
      clients.delete(id);
      return connectors.get(userId, id);
    },

    remove(userId: number, id: number) {
      const cur = connectorRow(userId, id);
      db.prepare('DELETE FROM specialist_connectors WHERE id = ? AND user_id = ?').run(id, userId);
      clients.delete(id);
      return connectorView(cur);
    },

    /** The UISP of a connector (enabled, with its token). */
    client(userId: number, id: number): { client: Uisp; name: string; uispKey: string | null } {
      const r = connectorRow(userId, id);
      if (!r.enabled) throw new HttpError(409, 'connector_disabled');
      const s = connectorSecrets(r);
      if (!s.token) throw new HttpError(409, 'connector_incomplete');
      let c = clients.get(id);
      if (!c || c.at !== r.updated_at) {
        c = { at: r.updated_at, client: build(r.url, s.token, !!json<{ ignoreTls?: boolean }>(r.options_json, {}).ignoreTls) };
        clients.set(id, c);
      }
      return { client: c.client, name: r.name, uispKey: s.uispKey ?? null };
    },

    /**
     * Tests the values of the form (token empty: the saved one of [id]) without saving them; a test
     * of a saved connector is remembered with it.
     */
    async test(userId: number, input: { id?: number | undefined; url?: string | undefined; token?: string | undefined; ignoreTls?: boolean | undefined }) {
      const saved = input.id ? connectorRow(userId, input.id) : null;
      const url = input.url ?? saved?.url;
      const token = input.token || (saved ? connectorSecrets(saved).token : undefined);
      const ignoreTls = input.ignoreTls ?? (saved ? !!json<{ ignoreTls?: boolean }>(saved.options_json, {}).ignoreTls : false);
      if (!url || !token) throw new HttpError(400, 'connector_incomplete');
      let out: Record<string, unknown>;
      try {
        out = { ...(await build(url, token, ignoreTls).test()) };
      } catch (e) {
        const err = e as HttpError;
        const detail = String(err.extra?.detail ?? (e as Error).message ?? '');
        const tls = /certificate|self[- ]signed|unable to verify|CERT_|SSL/i.test(detail);
        out = { ok: false, error: tls ? 'uisp_tls_error' : (err.code ?? 'uisp_error'), status: err.extra?.status ?? null, detail: detail.slice(0, 200) };
      }
      if (saved && input.url === undefined && !input.token && input.ignoreTls === undefined) {
        const detail = out.ok ? `UISP ${String(out.version ?? '')} · ${String(out.devices ?? 0)} dispositivi`.trim() : String(out.error ?? 'errore');
        db.prepare('UPDATE specialist_connectors SET last_test_at = ?, last_test_ok = ?, last_test_detail = ? WHERE id = ?').run(nowIso(), out.ok ? 1 : 0, detail.slice(0, 200), saved.id);
      }
      return out;
    },

    async sites(userId: number, id: number) {
      const { client } = connectors.client(userId, id);
      return (await client.sites()).filter((s) => s.type !== 'endpoint').map((s) => ({ id: s.id, name: s.name }));
    },
  };

  // ---- installations ---------------------------------------------------------------------------
  const JOB_SELECT = 'SELECT j.*, c.name connector_name FROM specialist_jobs j LEFT JOIN specialist_connectors c ON c.id = j.connector_id';
  /**
   * An installation of the specialist, or ([shared]) of a member of his work groups too: those are
   * read only (the outcome, the test and UISP stay with their author and his connectors).
   */
  const jobRow = (userId: number, id: string, shared = false) => {
    const ids = shared ? visible(userId) : [userId];
    const r = db.prepare(`${JOB_SELECT} WHERE j.id = ? AND j.user_id IN (${inList(ids)})`).get(id, ...ids) as JobRow | undefined;
    if (!r) throw new HttpError(404, 'job_not_found');
    return r;
  };
  const jobView = (r: JobRow) => ({
    id: r.id,
    /** Who installed it: the specialist or another member of his work groups. */
    authorId: r.user_id,
    author: r.username,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    status: r.status,
    attempts: r.attempts,
    model: r.model,
    template: r.template_name,
    templateId: r.template_id,
    mac: r.mac,
    serial: r.serial,
    /** Prepared before connecting to the CPE: MAC and serial are the ones read at the write. */
    cpeAtWrite: !!r.cpe_at_write,
    firmware: r.firmware,
    deviceName: r.device_name,
    ssid: r.ssid,
    pppoeUser: r.pppoe_user,
    customer: r.customer,
    notes: r.notes,
    company: r.connector_name ?? r.company,
    connector: r.connector_id ? { id: r.connector_id, name: r.connector_name ?? r.company } : null,
    location: r.latitude !== null && r.longitude !== null ? { lat: r.latitude, lon: r.longitude, source: r.location_source } : null,
    stages: json<string[]>(r.stages, []),
    detected: json<Record<string, string>>(r.detected, {}),
    error: r.error,
    acceptance: r.acceptance_json ? { ...json<Record<string, unknown>>(r.acceptance_json, {}), at: r.acceptance_at } : null,
    uisp: { deviceId: r.uisp_device_id, siteId: r.uisp_site_id, site: r.uisp_site, authorizedAt: r.uisp_authorized_at, error: r.uisp_error, off: !!r.uisp_off },
  });

  const isPrivateHost = (h: string) => isPrivateIPv4(h) || isPrivateIPv6(h);

  /**
   * The values of the placeholders of a job: typed ones, then those the server fills in. The
   * template's secrets only for its author ([mine]): the others type them.
   */
  function jobValues(input: JobInput, tpl: TemplateRow, uispKey: string | null, mine: boolean) {
    const typed = Object.fromEntries(Object.entries(input.values).map(([k, v]) => [k, v.trim() === '' ? '' : v]));
    for (const [k, v] of Object.entries(typed)) {
      if (v.length > 4096 || /[\r\n\0]/.test(v)) throw new HttpError(400, `invalid_value_${k}`);
    }
    if (typed.WPA2_PSK && !isWpa2Key(typed.WPA2_PSK)) throw new HttpError(400, 'invalid_value_WPA2_PSK');
    if (typed.SSID && !isSsid(typed.SSID)) throw new HttpError(400, 'invalid_value_SSID');
    if (typed.UISP_ENROLLMENT && !isUispKey(typed.UISP_ENROLLMENT)) throw new HttpError(400, 'invalid_value_UISP_ENROLLMENT');
    const secrets = mine ? templateSecrets(tpl) : {};
    const name = (typed.DEVICE_NAME ?? '').trim();
    return {
      ...typed,
      // from the CPE and from the flow: never typed here
      CPE_USERNAME: input.cpe.username,
      CPE_PASSWORD: input.cpe.password,
      CPE_PASSWORD_HASH: md5Crypt(input.cpe.password),
      // prepared before connecting to the CPE: not known yet (a template using them needs the CPE first)
      ...(input.mac ? { EXPECTED_MAC: input.mac, EXPECTED_SERIAL: input.serial || input.mac.replace(/:/g, '') } : {}),
      SNMP_LOCATION: typed.SNMP_LOCATION || name,
      SNMP_COMMUNITY: typed.SNMP_COMMUNITY || secrets.snmpCommunity || '',
      // the key of the company's AP kept in the template (its author's), else typed for this CPE
      WPA2_PSK: typed.WPA2_PSK || secrets.wpa2Psk || '',
      UISP_ENROLLMENT: typed.UISP_ENROLLMENT || uispKey || '',
    } as Record<string, string>;
  }

  const jobs = {
    /** What the specialist is asked for a template (and what the server fills in). */
    form(userId: number, templateId: number, connectorId: number | null) {
      const tpl = templateRow(userId, templateId);
      const text = sealer.open(tpl.template_ciphertext);
      const report = inspectFreeTemplate(text);
      const uispKey = connectorId ? !!connectorSecrets(connectorRow(userId, connectorId)).uispKey : false;
      // a template of another member: its secrets are his author's, typed here
      const mine = tpl.user_id === userId;
      const secrets = mine ? templateSecrets(tpl) : {};
      // in bridge the CPE has no PPPoE: its user and password are not asked
      return { placeholders: report.placeholders, asked: askedFor(report.placeholders, { snmpCommunity: !!secrets.snmpCommunity, wpa2Psk: !!secrets.wpa2Psk, uispKey }, unusedPlaceholders(text)) };
    },

    /**
     * Prepares an installation: the template's file with the values typed for this CPE. The
     * answer has the same shape as CDA Net's package (the app writes it the same way); the row
     * keeps no secret.
     */
    create(user: { id: number; username: string }, input: JobInput, client: string) {
      const tpl = templateRow(user.id, input.templateId);
      if (tpl.model !== input.model) throw new HttpError(409, 'template_model_mismatch', { template: tpl.model, cpe: input.model });
      const conn = input.connectorId ? connectorRow(user.id, input.connectorId) : null;
      const uispKey = conn ? (connectorSecrets(conn).uispKey ?? null) : null;
      const host = input.host?.trim() || cfg.network.factoryIp;
      if (!isPrivateHost(host)) throw new HttpError(400, 'target_not_private');
      const text0 = sealer.open(tpl.template_ciphertext);
      const values = jobValues(input, tpl, uispKey, tpl.user_id === user.id);
      // in bridge the CPE has no PPPoE (titolare, 18/10/2026): its lines stay empty, whatever was typed
      const unused = unusedPlaceholders(text0);
      for (const p of unused) values[p] = '';
      const extra: Array<[string, string]> = input.location
        ? [
            ['system.latitude', input.location.latitude.toFixed(6)],
            ['system.longitude', input.location.longitude.toFixed(6)],
          ]
        : [];
      // the company's UISP key is optional (titolare, 18/10/2026): without it the CPE has UISP off
      if (!values.UISP_ENROLLMENT && inspectFreeTemplate(text0).placeholders.includes('UISP_ENROLLMENT')) extra.push(['unms.status', 'disabled']);
      let text: string;
      try {
        text = renderFreeCfg(text0, values, extra, new Set([...unused, ...OPTIONAL_PLACEHOLDERS]));
      } catch (e) {
        const code = (e as Error).message;
        if ((code === 'missing_value_EXPECTED_MAC' || code === 'missing_value_EXPECTED_SERIAL') && !input.mac) throw new HttpError(409, 'template_needs_cpe');
        if (code.startsWith('missing_value_')) throw new HttpError(400, code, { placeholder: code.slice('missing_value_'.length) });
        throw new HttpError(409, code.startsWith('invalid_value_') || code.startsWith('profile_') || code.startsWith('template_') ? code : 'profile_render_failed');
      }
      const id = randomUUID();
      const created = new Date();
      // prepared before going to the CPE and written later (titolare, 17/10/2026): the hours of
      // Impostazioni server, 24 by default; at least one (firmware updates included)
      const expiresAt = new Date(created.getTime() + Math.max(cfg.specialistJobTtlHours, 1) * 3600_000).toISOString();
      const sha = sha256Hex(text);
      const facts = templateFacts(text);
      const deviceName = values.DEVICE_NAME ?? '';
      // the SSID written: the one of the template (fixed for the company's AP) or typed for this CPE
      const ssid = templateSsid(text) ?? values.SSID ?? '';
      const pppoeUser = values.PPPOE_USER ?? '';
      const mac = input.mac ?? '';
      // UISP off in the file written (the key left empty, or the template's choice): nothing to authorize
      const uispOff = /^unms\.status=disabled$/m.test(text);
      db.prepare(
        `INSERT INTO specialist_jobs(id, user_id, username, created_at, expires_at, client, connector_id, company, template_id, template_name, model, mac, serial, firmware,
           device_name, ssid, pppoe_user, customer, notes, latitude, longitude, location_source, config_sha256, cpe_at_write, uisp_off)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        user.id,
        user.username,
        created.toISOString(),
        expiresAt,
        client.slice(0, 60),
        conn?.id ?? null,
        conn?.name ?? (input.company ?? '').slice(0, 80),
        tpl.id,
        tpl.name,
        input.model,
        mac,
        values.EXPECTED_SERIAL ?? '',
        (input.firmware ?? '').slice(0, 80),
        deviceName.slice(0, 120),
        ssid.slice(0, 64),
        pppoeUser.slice(0, 128),
        (input.customer ?? '').slice(0, 120),
        (input.notes ?? '').slice(0, 1000),
        input.location?.latitude ?? null,
        input.location?.longitude ?? null,
        input.location?.source ?? '',
        sha,
        mac ? 0 : 1,
        uispOff ? 1 : 0,
      );
      return {
        jobId: id,
        expiresAt,
        // the port of the CPE as it is now (factory: 22, else what the discovery read), not the template's
        target: { host, sshPort: input.sshPort ?? 22 },
        credentials: { username: input.cpe.username, password: input.cpe.password },
        // an expert: after failed updates he may write on the firmware the CPE has;
        // MAC empty: prepared before connecting to the CPE, the app checks the one it reads
        checks: { firmware: TARGET_FIRMWARE, boardMatch: tpl.board_match, mac, firmwareBypass: true },
        config: { path: '/tmp/system.cfg', text, sha256: sha },
        summary: { model: input.model, template: tpl.name, ssid, pppoeUser, deviceName, mac, serial: values.EXPECTED_SERIAL ?? '' },
        afterApply: { lanIp: facts.lanIp ?? host, httpPort: facts.httpPort, httpsPort: facts.httpsPort },
        alternatives: [],
      };
    },

    /** The outcome of the write: a success is final, a failed write may be tried again. */
    result(userId: number, id: string, input: JobResultInput) {
      const job = jobRow(userId, id);
      if (job.status === 'success') {
        if (input.result === 'success') return { ok: true, duplicate: true };
        throw new HttpError(409, 'job_already_completed');
      }
      const retry = job.status === 'failed';
      if (retry && input.completedAt && job.completed_at === input.completedAt) return { ok: true, duplicate: true };
      // prepared before connecting to the CPE: the one the app read at the write is the job's (a
      // failed write may be tried again on another one, until a success)
      const site = job.cpe_at_write ? input.cpe : undefined;
      if (job.cpe_at_write && input.result === 'success' && !site) throw new HttpError(400, 'cpe_mac_required');
      db.prepare(
        `UPDATE specialist_jobs SET status = ?, completed_at = ?, stages = ?, detected = ?, error = ?, firmware = COALESCE(NULLIF(?, ''), firmware),
           mac = COALESCE(?, mac), serial = COALESCE(?, serial), attempts = attempts + 1 WHERE id = ?`,
      ).run(
        input.result,
        input.completedAt ?? nowIso(),
        JSON.stringify(input.stages.map((s) => clean(s).slice(0, 200)).slice(0, 40)),
        JSON.stringify(input.detected),
        clean(input.error),
        (input.detected.firmware ?? '').slice(0, 80),
        site?.mac ?? null,
        site ? (site.serial || site.mac.replace(/:/g, '')).slice(0, 128) : null,
        id,
      );
      return { ok: true, duplicate: false, ...(retry ? { retry: true } : {}) };
    },

    /** The optional acceptance test of the specialist (no NOC: his own judgment). */
    acceptance(userId: number, id: string, data: Record<string, unknown>) {
      const job = jobRow(userId, id);
      if (job.status !== 'success') throw new HttpError(409, 'job_not_completed');
      const at = nowIso();
      db.prepare('UPDATE specialist_jobs SET acceptance_json = ?, acceptance_at = ? WHERE id = ?').run(JSON.stringify(data), at, id);
      return jobView(jobRow(userId, id));
    },

    clearAcceptance(userId: number, id: string) {
      jobRow(userId, id);
      db.prepare('UPDATE specialist_jobs SET acceptance_json = NULL, acceptance_at = NULL WHERE id = ?').run(id);
      return jobView(jobRow(userId, id));
    },

    get(userId: number, id: string) {
      return jobView(jobRow(userId, id, true));
    },

    list(
      userId: number,
      f: { q?: string | undefined; status?: string | undefined; connectorId?: number | undefined; from?: string | undefined; to?: string | undefined; limit: number },
    ) {
      // his installations and those of the members of his work groups
      const ids = visible(userId);
      const where = [`j.user_id IN (${inList(ids)})`];
      const params: Array<string | number> = [...ids];
      if (f.status === 'to_authorize') where.push("j.status = 'success' AND j.connector_id IS NOT NULL AND j.uisp_authorized_at IS NULL AND j.uisp_off = 0");
      else if (f.status === 'no_acceptance') where.push("j.status = 'success' AND j.acceptance_json IS NULL");
      else if (f.status) {
        where.push('j.status = ?');
        params.push(f.status);
      }
      if (f.connectorId) {
        where.push('j.connector_id = ?');
        params.push(f.connectorId);
      }
      if (f.from) {
        where.push('j.created_at >= ?');
        params.push(f.from);
      }
      if (f.to) {
        where.push('j.created_at < ?');
        params.push(f.to);
      }
      if (f.q) {
        const like = `%${f.q.replace(/[!%_]/g, (m) => `!${m}`)}%`;
        const compact = `%${f.q.replace(/[\s:.-]/g, '').replace(/[!%_]/g, (m) => `!${m}`)}%`;
        where.push(
          `(j.mac LIKE ? ESCAPE '!' OR REPLACE(j.mac, ':', '') LIKE ? ESCAPE '!' OR j.serial LIKE ? ESCAPE '!' OR j.device_name LIKE ? ESCAPE '!' OR j.customer LIKE ? ESCAPE '!'
            OR j.ssid LIKE ? ESCAPE '!' OR j.pppoe_user LIKE ? ESCAPE '!' OR j.company LIKE ? ESCAPE '!' OR j.template_name LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!')`,
        );
        params.push(like, compact, like, like, like, like, like, like, like, like);
      }
      const total = (db.prepare(`SELECT count(*) n FROM specialist_jobs j LEFT JOIN specialist_connectors c ON c.id = j.connector_id WHERE ${where.join(' AND ')}`).get(...params) as { n: number }).n;
      const rows = db.prepare(`${JOB_SELECT} WHERE ${where.join(' AND ')} ORDER BY j.created_at DESC LIMIT ?`).all(...params, f.limit) as unknown as JobRow[];
      return { total, items: rows.map(jobView) };
    },

    remove(userId: number, id: string) {
      const job = jobRow(userId, id);
      db.prepare('DELETE FROM specialist_jobs WHERE id = ? AND user_id = ?').run(id, userId);
      return jobView(job);
    },

    summary(userId: number) {
      const n = (sql: string, ...p: Array<string | number>) => (db.prepare(sql).get(userId, ...p) as { n: number }).n;
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      return {
        templates: n('SELECT count(*) n FROM specialist_templates WHERE user_id = ?'),
        connectors: n('SELECT count(*) n FROM specialist_connectors WHERE user_id = ?'),
        jobs30d: n('SELECT count(*) n FROM specialist_jobs WHERE user_id = ? AND created_at > ?', since),
        success30d: n("SELECT count(*) n FROM specialist_jobs WHERE user_id = ? AND status = 'success' AND created_at > ?", since),
        toAuthorize: n("SELECT count(*) n FROM specialist_jobs WHERE user_id = ? AND status = 'success' AND connector_id IS NOT NULL AND uisp_authorized_at IS NULL AND uisp_off = 0"),
        failed30d: n("SELECT count(*) n FROM specialist_jobs WHERE user_id = ? AND status = 'failed' AND created_at > ?", since),
      };
    },

    /** The UISP device of an installation in its company's UISP: by MAC (the job's, the one read, their siblings). */
    async uispDevice(userId: number, id: string): Promise<{ job: JobRow; uisp: Uisp; connector: string; device: UispDevice | null }> {
      const job = jobRow(userId, id);
      if (!job.connector_id) throw new HttpError(409, 'job_without_connector');
      // prepared before connecting to the CPE and not written yet: its MAC comes with the outcome
      if (!job.mac) throw new HttpError(409, 'job_not_completed');
      const { client, name } = connectors.client(userId, job.connector_id);
      if (job.uisp_device_id) {
        const d = await client.device(job.uisp_device_id);
        if (d) return { job, uisp: client, connector: name, device: d };
      }
      const detected = json<{ mac?: string }>(job.detected, {}).mac;
      const device = await client.findByMac(job.mac, detected, ...macSiblings(job.mac));
      if (device && device.id !== job.uisp_device_id) db.prepare('UPDATE specialist_jobs SET uisp_device_id = ? WHERE id = ?').run(device.id, job.id);
      return { job, uisp: client, connector: name, device };
    },

    async uispState(userId: number, id: string) {
      const { job, uisp, connector, device } = await jobs.uispDevice(userId, id);
      const near = job.latitude !== null && job.longitude !== null ? { lat: job.latitude, lon: job.longitude } : null;
      const proposed = device && !device.authorized ? await uisp.siteForStation(device, job.ssid, near).catch(() => null) : null;
      return {
        connector,
        device: device ? { id: device.id, name: device.name, mac: device.mac, model: device.model, authorized: device.authorized, site: device.siteName, status: device.status, signal: device.signal } : null,
        proposedSite: proposed ? { id: proposed.id, name: proposed.name } : null,
        authorizedAt: job.uisp_authorized_at,
        site: job.uisp_site || null,
      };
    },

    /** Authorizes the installed CPE in the company's UISP, in the site chosen (or the one of its AP). */
    async authorize(userId: number, id: string, siteId: string | undefined) {
      const { job, uisp, device } = await jobs.uispDevice(userId, id);
      if (job.status !== 'success') throw new HttpError(409, 'job_not_completed');
      if (!device) throw new HttpError(409, 'uisp_device_not_found');
      if (device.authorized) {
        db.prepare("UPDATE specialist_jobs SET uisp_device_id = ?, uisp_site = COALESCE(NULLIF(?, ''), uisp_site), uisp_authorized_at = COALESCE(uisp_authorized_at, ?), uisp_error = '' WHERE id = ?").run(
          device.id,
          device.siteName ?? '',
          nowIso(),
          id,
        );
        throw new HttpError(409, 'uisp_already_authorized', { site: device.siteName });
      }
      const near = job.latitude !== null && job.longitude !== null ? { lat: job.latitude, lon: job.longitude } : null;
      const proposed = siteId ? null : await uisp.siteForStation(device, job.ssid, near);
      const site = siteId ?? proposed?.id;
      if (!site) throw new HttpError(409, 'uisp_site_unknown');
      const siteName = siteId ? ((await uisp.sites()).find((s) => s.id === siteId)?.name ?? siteId) : (proposed?.name ?? site);
      try {
        await uisp.authorize(device.id, site);
      } catch (e) {
        db.prepare('UPDATE specialist_jobs SET uisp_error = ? WHERE id = ?').run(String((e as HttpError).code ?? (e as Error).message).slice(0, 200), id);
        throw e;
      }
      db.prepare("UPDATE specialist_jobs SET uisp_device_id = ?, uisp_site_id = ?, uisp_site = ?, uisp_authorized_at = ?, uisp_error = '' WHERE id = ?").run(device.id, site, siteName, nowIso(), id);
      return { ok: true, deviceId: device.id, site: siteName, job: jobView(jobRow(userId, id)) };
    },
  };

  return { templates, connectors, jobs };
}
export type Specialist = ReturnType<typeof createSpecialist>;
