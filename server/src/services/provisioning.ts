import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { Config } from '../config.ts';
import { md5Crypt, sha256Hex, type Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';
import { isDeviceMac,
  MANAGEMENT_PORTS,
  PPPOE_USER_RX,
  SSID_RX,
  SUPPORTED_MODELS,
  TARGET_FIRMWARE,
  customerNameFromRadius,
  deviceNameFromCustomer,
  parseMac,
} from '../domain/policy.ts';
import { renderSystemCfg, type PlaceholderName } from '../domain/systemcfg.ts';
import type { Templates, Viewer } from './templates.ts';
import { photoDir, sweepPhotos } from './photos.ts';
import { rmSync } from 'node:fs';

/** MAC of the CPE, as AA:BB:CC:DD:EE:FF. */
export const cpeMacSchema = z
  .string()
  .max(40)
  .transform((v, ctx) => {
    const mac = parseMac(v);
    if (!mac) ctx.addIssue({ code: 'custom', message: 'MAC non valido' });
    // a device MAC is unicast (first byte even) and not all zeros: anything else is another code of the label
    else if (!isDeviceMac(mac)) ctx.addIssue({ code: 'custom', message: 'Non è il MAC di un apparato' });
    return mac && isDeviceMac(mac) ? mac : z.NEVER;
  });
export const cpeSerialSchema = z.string().trim().min(1).max(128).regex(/^[\x20-\x7e]+$/);

export const provisionRequestSchema = z
  .object({
    model: z.enum(SUPPORTED_MODELS),
    /**
     * Omitted, with the serial, for a work order prepared before the visit: the installer scans
     * them on site (even without Internet) and they come back with the result.
     */
    mac: cpeMacSchema.optional(),
    serial: cpeSerialSchema.optional(),
    ssid: z.string().regex(SSID_RX),
    /**
     * Other APs the CPE may point to (prepared before the visit): a configuration for each is in the
     * package, the installer picks the AP on site without Internet. APs without a Wi-Fi key are skipped.
     */
    alternativeSsids: z.array(z.string().regex(SSID_RX)).max(4).optional(),
    pppoeUser: z.string().trim().min(3).max(128).regex(PPPOE_USER_RX),
    /** Omitted when the job starts from a work order: the server uses the order's sealed password. */
    pppoePassword: z.string().min(1).max(200).optional(),
    /** Work order of the office this installation comes from. */
    workOrderId: z.number().int().positive().optional(),
    /** A failed or never written installation of the same user that this one redoes ("Modifica e riprova"). */
    supersedes: z.string().uuid().optional(),
    /** Named template of the model; omitted = the model's default template. */
    templateId: z.number().int().positive().optional(),
    /** CPE position: phone GPS, geocoded address or manual entry. */
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(100_000).optional(),
        source: z.enum(['gps', 'address', 'manual']),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((x) => x.pppoePassword !== undefined || x.workOrderId !== undefined, { message: 'Password PPPoE obbligatoria', path: ['pppoePassword'] })
  .refine((x) => x.mac !== undefined || x.workOrderId !== undefined, { message: 'MAC obbligatorio', path: ['mac'] })
  .refine((x) => (x.mac === undefined) === (x.serial === undefined), { message: 'MAC e seriale vanno insieme', path: ['serial'] });
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;

export const provisionResultSchema = z
  .object({
    result: z.enum(['success', 'failed']),
    stages: z.array(z.string().max(200)).max(40).default([]),
    error: z.string().max(1000).optional().default(''),
    detected: z
      .object({
        firmware: z.string().max(80).optional(),
        board: z.string().max(120).optional(),
        mac: z.string().max(40).optional(),
      })
      .strict()
      .optional()
      .default({}),
    /** The AP chosen on site among the ones the job was prepared for (omitted: the job's own). */
    ssid: z.string().regex(SSID_RX).optional(),
    /** MAC and serial scanned on site, for a job prepared without them (they must come with its result). */
    cpe: z.object({ mac: cpeMacSchema, serial: cpeSerialSchema }).strict().optional(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

/** Strips anything that looks like a credential from client-supplied error text. */
export function sanitizeError(text: string): string {
  return text
    .replace(/((?:password|passwd|secret|psk|token|community)\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

export interface Readiness {
  wpa2Configured: boolean;
  profileConfigured: boolean;
  cpeAdminSecret: boolean;
  missing: string[];
}

export function createProvisioning(db: Db, cfg: Config, sealer: Sealer, templates: Templates) {
  const getWpa = db.prepare('SELECT wpa2_ciphertext FROM wireless_secrets WHERE ssid = ?');

  function readiness(x: Pick<ProvisionRequest, 'ssid' | 'model' | 'templateId'>, viewer: Viewer): Readiness {
    const wpa2Configured = !!getWpa.get(x.ssid);
    const profileConfigured = !!templates.resolve(x.model, x.templateId, viewer);
    const cpeAdminSecret = !!cfg.cpeSecrets.adminPassword;
    const missing: string[] = [];
    if (!wpa2Configured) missing.push('ssid_secret_not_configured');
    if (!profileConfigured) missing.push('provision_profile_missing');
    if (!cpeAdminSecret) missing.push('cpe_admin_secret_missing');
    return { wpa2Configured, profileConfigured, cpeAdminSecret, missing };
  }

  /** Non-secret description of what will be written, for the dry-run/plan screen. */
  /**
   * The CPE's device name: the customer of the work order as the office wrote it, else the CRM's
   * customer of the PPPoE account, else the PPPoE user (which has no spaces between the words).
   */
  function deviceNameFor(x: { pppoeUser: string; workOrderId?: number | undefined }): string {
    const order = x.workOrderId ? (db.prepare('SELECT customer FROM work_orders WHERE id = ?').get(x.workOrderId) as { customer: string } | undefined) : undefined;
    const fromOrder = order?.customer ? deviceNameFromCustomer(order.customer) : '';
    if (fromOrder) return fromOrder;
    const crm = db.prepare("SELECT customer_name FROM crm_radius WHERE username = ? COLLATE NOCASE AND customer_name <> ''").get(x.pppoeUser) as { customer_name: string } | undefined;
    const fromCrm = crm ? deviceNameFromCustomer(crm.customer_name) : '';
    return fromCrm || customerNameFromRadius(x.pppoeUser);
  }

  function plan(x: ProvisionRequest, viewer: Viewer) {
    const name = deviceNameFor(x);
    const n = cfg.network;
    const tpl = templates.resolve(x.model, x.templateId, viewer);
    return {
      targetFirmware: TARGET_FIRMWARE,
      template: tpl ? { id: tpl.id, name: tpl.name } : null,
      factoryIp: n.factoryIp,
      readiness: readiness(x, viewer),
      steps: [
        `Primo avvio CPE su ${n.factoryIp}: Country Licensed e credenziali CDA Net`,
        `Template ${x.model} "${tpl?.name ?? '—'}" · verifica firmware ${TARGET_FIRMWARE}, board e MAC ${x.mac ?? 'letto sul posto'}`,
        `Station WPA2 su ${x.ssid} (chiave dal backend)`,
        'Router Mode, WAN wireless diretta in PPPoE, nessuna VLAN',
        `PPPoE ${x.pppoeUser} · MTU/MRU ${n.pppoeMtu}/${n.pppoeMru}`,
        `LAN ${n.lanIp}/${n.lanNetmask} · DHCP ${n.dhcpStart}-${n.dhcpEnd}`,
        `Watchdog ${n.watchdogHost} · NTP ${n.ntpServer}`,
        `SNMP v2c · contact ${cfg.cpeSecrets.snmpContact} · location ${name}`,
        'Calculate EIRP Limit OFF · Automatic Power Control (Station) ON',
        `Device Name ${name}`,
        `Management HTTP ${MANAGEMENT_PORTS.http} / HTTPS ${MANAGEMENT_PORTS.https} · UISP`,
        'Persistenza cfgmtd, reboot e verifica associazione/PPPoE',
      ],
    };
  }

  /** Placeholder values of a job (same for the rendered config and the drift check). */
  function jobValues(x: Pick<ProvisionRequest, 'ssid' | 'pppoeUser' | 'mac' | 'serial' | 'workOrderId'> & { pppoePassword?: string }, wpa2: string) {
    const s = cfg.cpeSecrets;
    const n = cfg.network;
    const name = deviceNameFor(x);
    const values: Partial<Record<PlaceholderName, string>> = {
      SSID: x.ssid,
      WPA2_PSK: wpa2,
      PPPOE_USER: x.pppoeUser,
      ...(x.pppoePassword !== undefined ? { PPPOE_PASSWORD: x.pppoePassword } : {}),
      HTTP_PORT: String(MANAGEMENT_PORTS.http),
      HTTPS_PORT: String(MANAGEMENT_PORTS.https),
      SNMP_COMMUNITY: s.snmpCommunity,
      SNMP_CONTACT: s.snmpContact,
      SNMP_LOCATION: name,
      DEVICE_NAME: name,
      CPE_USERNAME: s.adminUsername,
      CPE_PASSWORD: s.adminPassword as string,
      CPE_PASSWORD_HASH: md5Crypt(s.adminPassword as string),
      // a job prepared before the visit has neither: a template that needs them cannot be prepared that way
      ...(x.mac !== undefined ? { EXPECTED_MAC: x.mac } : {}),
      ...(x.serial !== undefined ? { EXPECTED_SERIAL: x.serial } : {}),
      LAN_IP: n.lanIp,
      LAN_NETMASK: n.lanNetmask,
      DHCP_START: n.dhcpStart,
      DHCP_END: n.dhcpEnd,
      DHCP_LEASE: String(n.dhcpLease),
      PPPOE_MTU: String(n.pppoeMtu),
      PPPOE_MRU: String(n.pppoeMru),
      WATCHDOG_HOST: n.watchdogHost,
      NTP_SERVER: n.ntpServer,
      SSH_PORT: String(n.sshPort),
      DISCOVERY_PORT: String(n.discoveryPort),
    };
    if (s.uispEnrollment) values.UISP_ENROLLMENT = s.uispEnrollment;
    return { values, name };
  }

  /** Keys forced on every CPE regardless of the template (CDA Net policy). */
  function enforcedKeys(name: string, location?: { latitude: number; longitude: number } | null): Array<[string, string]> {
    const s = cfg.cpeSecrets;
    const n = cfg.network;
    return [
      ['pwdog.status', 'enabled'],
      ['pwdog.host', n.watchdogHost],
      ['snmp.status', 'enabled'],
      ['snmp.community', s.snmpCommunity],
      ['snmp.contact', s.snmpContact],
      ['snmp.location', name],
      ['system.eirp.status', 'disabled'],
      ['radio.1.obey', 'disabled'],
      ['radio.1.atpc.sta.status', 'enabled'],
      ['resolv.host.1.name', name],
      ['resolv.host.1.status', 'enabled'],
      // airOS System > Location: UISP shows the CPE where it was installed.
      ...(location
        ? ([
            ['system.latitude', location.latitude.toFixed(6)],
            ['system.longitude', location.longitude.toFixed(6)],
          ] as Array<[string, string]>)
        : []),
    ];
  }

  /** The work order a job starts from: assigned to this installer (admins: any), still to do. */
  function workOrderFor(id: number, viewer: Viewer) {
    const o = db.prepare('SELECT id, assigned_to assignedTo, status, pppoe_ciphertext ciphertext FROM work_orders WHERE id = ?').get(id) as
      | { id: number; assignedTo: number | null; status: string; ciphertext: string }
      | undefined;
    if (!o || (o.assignedTo !== viewer.id && viewer.role !== 'admin')) throw new HttpError(404, 'work_order_not_found');
    if (o.status === 'done' || o.status === 'cancelled') throw new HttpError(409, 'work_order_closed');
    return o;
  }

  function createJob(x0: ProvisionRequest, viewer: Viewer, client: string) {
    const order = x0.workOrderId ? workOrderFor(x0.workOrderId, viewer) : null;
    let password = x0.pppoePassword;
    if (password === undefined && order) {
      if (!order.ciphertext) throw new HttpError(409, 'work_order_password_missing');
      try {
        password = sealer.open(order.ciphertext);
      } catch {
        throw new HttpError(500, 'secret_decrypt_failed');
      }
    }
    const x = { ...x0, pppoePassword: password };
    const userId = viewer.id;
    const r = readiness(x, viewer);
    if (r.missing.length) throw new HttpError(409, r.missing[0] as string, { missing: r.missing });

    const profile = templates.resolve(x.model, x.templateId, viewer);
    const wpa = getWpa.get(x.ssid) as { wpa2_ciphertext: string } | undefined;
    if (!profile || !wpa) throw new HttpError(409, 'provision_profile_missing');
    if (!profile.boardMatch) throw new HttpError(409, 'profile_board_match_missing');

    let template: string;
    let wpa2: string;
    try {
      template = sealer.open(profile.ciphertext);
      wpa2 = sealer.open(wpa.wpa2_ciphertext);
    } catch {
      throw new HttpError(500, 'secret_decrypt_failed');
    }

    const s = cfg.cpeSecrets;
    const n = cfg.network;
    const render = (ssid: string, key: string) => {
      const { values, name } = jobValues({ ...x, ssid }, key);
      try {
        return { name, text: renderSystemCfg(template, { values, enforced: enforcedKeys(name, x.location) }) };
      } catch (e) {
        const code = (e as Error).message;
        if (code === 'missing_value_UISP_ENROLLMENT') throw new HttpError(503, 'runtime_secret_missing', { placeholder: 'UISP_ENROLLMENT' });
        if ((code === 'missing_value_EXPECTED_MAC' || code === 'missing_value_EXPECTED_SERIAL') && x.mac === undefined) throw new HttpError(409, 'template_needs_mac');
        throw new HttpError(409, code.startsWith('missing_value_') || code.startsWith('profile_') ? code : 'profile_render_failed');
      }
    };
    const { name, text } = render(x.ssid, wpa2);
    // the same configuration for the other APs it may point to (only those with their Wi-Fi key)
    const alternatives = [...new Set(x.alternativeSsids ?? [])]
      .filter((ssid) => ssid !== x.ssid)
      .flatMap((ssid) => {
        const w = getWpa.get(ssid) as { wpa2_ciphertext: string } | undefined;
        if (!w) return [];
        let key: string;
        try {
          key = sealer.open(w.wpa2_ciphertext);
        } catch {
          return [];
        }
        const t = render(ssid, key).text;
        return [{ ssid, config: { path: '/tmp/system.cfg', text: t, sha256: sha256Hex(t) } }];
      });

    const id = randomUUID();
    const created = new Date();
    const expiresAt = new Date(created.getTime() + cfg.jobTtlMinutes * 60_000).toISOString();
    const configSha256 = sha256Hex(text);
    const options = alternatives.length ? JSON.stringify(Object.fromEntries([[x.ssid, configSha256], ...alternatives.map((a) => [a.ssid, a.config.sha256])])) : null;
    db.prepare(
      `INSERT INTO provisioning_jobs(id, created_at, expires_at, user_id, client, model, mac, serial, ssid, pppoe_user, device_name, profile_sha256, config_sha256, template_name, latitude, longitude, location_accuracy, location_source, ssid_options, status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'prepared')`,
    ).run(id, created.toISOString(), expiresAt, userId, client, x.model, x.mac ?? '', x.serial ?? '', x.ssid, x.pppoeUser, name, profile.sha256, configSha256, profile.name,
      x.location?.latitude ?? null, x.location?.longitude ?? null, x.location?.accuracy ?? null, x.location?.source ?? '', options);
    // "Modifica e riprova": the old attempt leaves the installer's open work (only theirs, only if not installed)
    if (x0.supersedes) {
      db.prepare("UPDATE provisioning_jobs SET superseded_by = ? WHERE id = ? AND user_id = ? AND status IN ('prepared', 'failed', 'expired') AND superseded_by IS NULL").run(id, x0.supersedes, userId);
    }
    if (order) {
      db.prepare('UPDATE provisioning_jobs SET work_order_id = ? WHERE id = ?').run(order.id, id);
      // prepared before the visit (no MAC yet): the order is not started until the installer is there
      if (x.mac !== undefined) db.prepare("UPDATE work_orders SET status = 'started', updated_at = ? WHERE id = ? AND status IN ('open','postponed')").run(nowIso(), order.id);
    }

    return {
      jobId: id,
      expiresAt,
      target: { host: n.factoryIp, sshPort: 22 },
      credentials: { username: s.adminUsername, password: s.adminPassword as string },
      // mac "" = scanned on site: the app checks the CPE against what the installer scans there
      checks: { firmware: TARGET_FIRMWARE, boardMatch: profile.boardMatch, mac: x.mac ?? '', firmwareBypass: cfg.firmwareBypass },
      config: { path: '/tmp/system.cfg', text, sha256: configSha256 },
      summary: { model: x.model, template: profile.name, ssid: x.ssid, pppoeUser: x.pppoeUser, deviceName: name, mac: x.mac ?? '', serial: x.serial ?? '' },
      afterApply: { lanIp: n.lanIp, httpPort: MANAGEMENT_PORTS.http, httpsPort: MANAGEMENT_PORTS.https },
      alternatives,
    };
  }

  function recordResult(jobId: string, user: { id: number; role: string }, input: z.infer<typeof provisionResultSchema>) {
    const job = db.prepare('SELECT id, user_id, status, mac, ssid, ssid_options FROM provisioning_jobs WHERE id = ?').get(jobId) as
      | { id: string; user_id: number; status: string; mac: string; ssid: string; ssid_options: string | null }
      | undefined;
    if (!job) throw new HttpError(404, 'job_not_found');
    if (job.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'forbidden');
    // the AP chosen on site: only one the job was prepared for, and only before it is written
    if (input.ssid && input.ssid !== job.ssid && job.status !== 'success') {
      const options = JSON.parse(job.ssid_options ?? '{}') as Record<string, string>;
      const sha = options[input.ssid];
      if (!sha) throw new HttpError(400, 'ssid_not_prepared');
      db.prepare('UPDATE provisioning_jobs SET ssid = ?, config_sha256 = ? WHERE id = ?').run(input.ssid, sha, jobId);
    }
    // prepared before the visit: the CPE scanned on site becomes the job's (once; then it is the job's own)
    if (!job.mac) {
      if (!input.cpe) throw new HttpError(400, 'cpe_mac_required');
      db.prepare("UPDATE provisioning_jobs SET mac = ?, serial = ? WHERE id = ? AND mac = ''").run(input.cpe.mac, input.cpe.serial, jobId);
    }
    // A failed write can be retried with the same package (new attempt); a success is final.
    const retry = job.status === 'failed';
    if (job.status === 'success') {
      if (input.result === 'success') return { ok: true, duplicate: true };
      throw new HttpError(409, 'job_already_completed');
    }
    if (retry && input.completedAt && sameAttempt(jobId, input.completedAt)) return { ok: true, duplicate: true };
    db.prepare(
      `UPDATE provisioning_jobs SET status = ?, completed_at = ?, stages = ?, detected = ?, error = ?, attempts = attempts + ${retry ? 1 : 0} WHERE id = ?`,
    ).run(
      input.result,
      input.completedAt ?? nowIso(),
      JSON.stringify(input.stages.map((x) => x.slice(0, 200))),
      JSON.stringify(input.detected),
      sanitizeError(input.error),
      jobId,
    );
    // a work order closes with the successful installation that came from it
    if (input.result === 'success') {
      db.prepare(
        "UPDATE work_orders SET status = 'done', done_at = ?, job_id = ?, updated_at = ? WHERE id = (SELECT work_order_id FROM provisioning_jobs WHERE id = ?) AND status <> 'cancelled'",
      ).run(nowIso(), jobId, nowIso(), jobId);
    }
    return { ok: true, duplicate: false, ...(retry ? { retry: true } : {}) };
  }

  /** The offline queue may send the same result twice: same completion time, same attempt. */
  function sameAttempt(jobId: string, completedAt: string) {
    return !!db.prepare('SELECT 1 FROM provisioning_jobs WHERE id = ? AND completed_at = ?').get(jobId, completedAt);
  }

  function listJobs(
    user: { id: number; role: string },
    filter: { limit: number; q?: string | undefined; status?: string | undefined; from?: string | undefined; to?: string | undefined },
  ) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (user.role !== 'admin') {
      where.push('j.user_id = ?');
      params.push(user.id);
    }
    if (filter.status === 'ko') {
      where.push("EXISTS (SELECT 1 FROM install_ko k WHERE k.job_id = j.id AND k.resolved_at IS NULL)");
    } else if (filter.status === 'review') {
      where.push("EXISTS (SELECT 1 FROM job_acceptance a WHERE a.job_id = j.id AND a.review = 'pending')");
    } else if (filter.status) {
      where.push('j.status = ?');
      params.push(filter.status);
    }
    if (filter.from) {
      where.push('j.created_at >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      where.push('j.created_at < ?');
      params.push(filter.to);
    }
    if (filter.q) {
      // MACs are stored as AA:BB:..: also match a search typed without separators.
      where.push("(j.mac LIKE ? OR REPLACE(j.mac, ':', '') LIKE ? OR j.pppoe_user LIKE ? OR j.serial LIKE ? OR j.ssid LIKE ? OR j.device_name LIKE ?)");
      const like = `%${filter.q}%`;
      const compact = `%${filter.q.replace(/[\s:.-]/g, '')}%`;
      params.push(like, compact, like, like, like, like);
    }
    const rows = db
      .prepare(
        `SELECT j.id, j.created_at createdAt, j.expires_at expiresAt, j.completed_at completedAt, j.status, j.client,
                j.model, j.template_name template, j.mac, j.serial, j.ssid, j.pppoe_user pppoeUser, j.device_name deviceName, j.superseded_by supersededBy,
                j.latitude, j.longitude, j.location_accuracy locationAccuracy, j.location_source locationSource,
                j.uisp_device_id uispDeviceId, j.uisp_site uispSite, j.uisp_authorized_at uispAuthorizedAt,
                j.stages, j.detected, j.error, u.username installer, j.replaces_job_id replacesJobId,
                (SELECT a.verdict FROM job_acceptance a WHERE a.job_id = j.id) acceptance,
                (SELECT a.review FROM job_acceptance a WHERE a.job_id = j.id) review,
                (SELECT count(*) FROM job_photos p WHERE p.job_id = j.id) photos, j.attempts,
                (SELECT count(*) FROM install_ko k WHERE k.job_id = j.id) koCount,
                (SELECT k.kind || ':' || k.reason FROM install_ko k WHERE k.job_id = j.id AND k.resolved_at IS NULL ORDER BY k.id DESC LIMIT 1) koOpen
         FROM provisioning_jobs j JOIN users u ON u.id = j.user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY j.created_at DESC LIMIT ?`,
      )
      .all(...params, filter.limit) as Array<Record<string, unknown>>;
    return rows.map(({ koOpen, ...r }) => {
      const [kind, reason] = koOpen ? String(koOpen).split(':') : [];
      return {
        ...r,
        stages: JSON.parse(String(r.stages || '[]')),
        detected: JSON.parse(String(r.detected || '{}')),
        ko: kind ? { kind, reason } : null,
      };
    });
  }

  /** Marks stale prepared jobs as expired and applies GDPR retention. */
  function housekeeping() {
    const now = nowIso();
    // Results may arrive after expiry (offline field work), so keep a grace period before marking.
    const grace = new Date(Date.now() - 7 * 86400_000).toISOString();
    db.prepare("UPDATE provisioning_jobs SET status = 'expired' WHERE status = 'prepared' AND expires_at < ?").run(grace);
    const cutoff = new Date(Date.now() - cfg.auditRetentionDays * 86400_000).toISOString();
    db.prepare('DELETE FROM provisioning_jobs WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM audits WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM install_ko WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM speed_tests WHERE created_at < ?').run(cutoff);
    sweepPhotos(db, cfg.photosDir);
    return now;
  }

  /**
   * Removes an installation attempt that never installed a CPE (prepared, failed or expired): the NOC
   * cleans up tests and mistakes. A written installation (success) is the record of a customer's CPE
   * and is never deleted. Its acceptance test, photos, KOs and notifications go with it.
   */
  function deleteAttempt(jobId: string) {
    const job = db.prepare('SELECT id, status, mac, pppoe_user pppoeUser, device_name deviceName FROM provisioning_jobs WHERE id = ?').get(jobId) as
      | { id: string; status: string; mac: string; pppoeUser: string; deviceName: string }
      | undefined;
    if (!job) throw new HttpError(404, 'job_not_found');
    if (job.status === 'success') throw new HttpError(409, 'job_installed');
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE provisioning_jobs SET superseded_by = NULL WHERE superseded_by = ?').run(jobId);
      db.prepare('UPDATE provisioning_jobs SET replaces_job_id = NULL WHERE replaces_job_id = ?').run(jobId);
      db.prepare('DELETE FROM speed_tests WHERE job_id = ?').run(jobId);
      db.prepare('DELETE FROM notifications WHERE job_id = ?').run(jobId);
      db.prepare('DELETE FROM provisioning_jobs WHERE id = ?').run(jobId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    rmSync(photoDir(cfg.photosDir, jobId), { recursive: true, force: true });
    return job;
  }

  return { readiness, plan, createJob, recordResult, listJobs, housekeeping, jobValues, enforcedKeys, deleteAttempt };
}
export type Provisioning = ReturnType<typeof createProvisioning>;
