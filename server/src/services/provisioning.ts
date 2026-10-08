import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { Config } from '../config.ts';
import { md5Crypt, sha256Hex, type Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';
import {
  MANAGEMENT_PORTS,
  PPPOE_USER_RX,
  SSID_RX,
  SUPPORTED_MODELS,
  TARGET_FIRMWARE,
  customerNameFromRadius,
  parseMac,
} from '../domain/policy.ts';
import { renderSystemCfg, type PlaceholderName } from '../domain/systemcfg.ts';
import type { Templates, Viewer } from './templates.ts';
import { sweepPhotos } from './photos.ts';

export const provisionRequestSchema = z
  .object({
    model: z.enum(SUPPORTED_MODELS),
    mac: z
      .string()
      .max(40)
      .transform((v, ctx) => {
        const mac = parseMac(v);
        if (!mac) ctx.addIssue({ code: 'custom', message: 'MAC non valido' });
        return mac ?? z.NEVER;
      }),
    serial: z.string().trim().min(1).max(128).regex(/^[\x20-\x7e]+$/),
    ssid: z.string().regex(SSID_RX),
    pppoeUser: z.string().trim().min(3).max(128).regex(PPPOE_USER_RX),
    pppoePassword: z.string().min(1).max(200),
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
  .strict();
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
  function plan(x: ProvisionRequest, viewer: Viewer) {
    const name = customerNameFromRadius(x.pppoeUser);
    const n = cfg.network;
    const tpl = templates.resolve(x.model, x.templateId, viewer);
    return {
      targetFirmware: TARGET_FIRMWARE,
      template: tpl ? { id: tpl.id, name: tpl.name } : null,
      factoryIp: n.factoryIp,
      readiness: readiness(x, viewer),
      steps: [
        `Primo avvio CPE su ${n.factoryIp}: Country Licensed e credenziali CDA Net`,
        `Template ${x.model} "${tpl?.name ?? '—'}" · verifica firmware ${TARGET_FIRMWARE}, board e MAC ${x.mac}`,
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

  function createJob(x: ProvisionRequest, viewer: Viewer, client: string) {
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
    const name = customerNameFromRadius(x.pppoeUser);
    const values: Partial<Record<PlaceholderName, string>> = {
      SSID: x.ssid,
      WPA2_PSK: wpa2,
      PPPOE_USER: x.pppoeUser,
      PPPOE_PASSWORD: x.pppoePassword,
      HTTP_PORT: String(MANAGEMENT_PORTS.http),
      HTTPS_PORT: String(MANAGEMENT_PORTS.https),
      SNMP_COMMUNITY: s.snmpCommunity,
      SNMP_CONTACT: s.snmpContact,
      SNMP_LOCATION: name,
      DEVICE_NAME: name,
      CPE_USERNAME: s.adminUsername,
      CPE_PASSWORD: s.adminPassword as string,
      CPE_PASSWORD_HASH: md5Crypt(s.adminPassword as string),
      EXPECTED_MAC: x.mac,
      EXPECTED_SERIAL: x.serial,
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

    let text: string;
    try {
      text = renderSystemCfg(template, {
        values,
        enforced: [
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
          ...(x.location
            ? ([
                ['system.latitude', x.location.latitude.toFixed(6)],
                ['system.longitude', x.location.longitude.toFixed(6)],
              ] as Array<[string, string]>)
            : []),
        ],
      });
    } catch (e) {
      const code = (e as Error).message;
      if (code === 'missing_value_UISP_ENROLLMENT') throw new HttpError(503, 'runtime_secret_missing', { placeholder: 'UISP_ENROLLMENT' });
      throw new HttpError(409, code.startsWith('missing_value_') || code.startsWith('profile_') ? code : 'profile_render_failed');
    }

    const id = randomUUID();
    const created = new Date();
    const expiresAt = new Date(created.getTime() + cfg.jobTtlMinutes * 60_000).toISOString();
    const configSha256 = sha256Hex(text);
    db.prepare(
      `INSERT INTO provisioning_jobs(id, created_at, expires_at, user_id, client, model, mac, serial, ssid, pppoe_user, device_name, profile_sha256, config_sha256, template_name, latitude, longitude, location_accuracy, location_source, status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'prepared')`,
    ).run(id, created.toISOString(), expiresAt, userId, client, x.model, x.mac, x.serial, x.ssid, x.pppoeUser, name, profile.sha256, configSha256, profile.name,
      x.location?.latitude ?? null, x.location?.longitude ?? null, x.location?.accuracy ?? null, x.location?.source ?? '');

    return {
      jobId: id,
      expiresAt,
      target: { host: n.factoryIp, sshPort: 22 },
      credentials: { username: s.adminUsername, password: s.adminPassword as string },
      checks: { firmware: TARGET_FIRMWARE, boardMatch: profile.boardMatch, mac: x.mac },
      config: { path: '/tmp/system.cfg', text, sha256: configSha256 },
      summary: { model: x.model, template: profile.name, ssid: x.ssid, pppoeUser: x.pppoeUser, deviceName: name, mac: x.mac, serial: x.serial },
      afterApply: { lanIp: n.lanIp, httpPort: MANAGEMENT_PORTS.http, httpsPort: MANAGEMENT_PORTS.https },
    };
  }

  function recordResult(jobId: string, user: { id: number; role: string }, input: z.infer<typeof provisionResultSchema>) {
    const job = db.prepare('SELECT id, user_id, status FROM provisioning_jobs WHERE id = ?').get(jobId) as
      | { id: string; user_id: number; status: string }
      | undefined;
    if (!job) throw new HttpError(404, 'job_not_found');
    if (job.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'forbidden');
    if (job.status === 'success' || job.status === 'failed') {
      if (job.status === input.result) return { ok: true, duplicate: true };
      throw new HttpError(409, 'job_already_completed');
    }
    db.prepare(
      'UPDATE provisioning_jobs SET status = ?, completed_at = ?, stages = ?, detected = ?, error = ? WHERE id = ?',
    ).run(
      input.result,
      input.completedAt ?? nowIso(),
      JSON.stringify(input.stages.map((x) => x.slice(0, 200))),
      JSON.stringify(input.detected),
      sanitizeError(input.error),
      jobId,
    );
    return { ok: true, duplicate: false };
  }

  function listJobs(user: { id: number; role: string }, filter: { limit: number; q?: string | undefined; status?: string | undefined }) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (user.role !== 'admin') {
      where.push('j.user_id = ?');
      params.push(user.id);
    }
    if (filter.status) {
      where.push('j.status = ?');
      params.push(filter.status);
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
                j.model, j.template_name template, j.mac, j.serial, j.ssid, j.pppoe_user pppoeUser, j.device_name deviceName,
                j.latitude, j.longitude, j.location_accuracy locationAccuracy, j.location_source locationSource,
                j.uisp_device_id uispDeviceId, j.uisp_site uispSite, j.uisp_authorized_at uispAuthorizedAt,
                j.stages, j.detected, j.error, u.username installer, j.replaces_job_id replacesJobId,
                (SELECT a.verdict FROM job_acceptance a WHERE a.job_id = j.id) acceptance,
                (SELECT count(*) FROM job_photos p WHERE p.job_id = j.id) photos
         FROM provisioning_jobs j JOIN users u ON u.id = j.user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY j.created_at DESC LIMIT ?`,
      )
      .all(...params, filter.limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ...r,
      stages: JSON.parse(String(r.stages || '[]')),
      detected: JSON.parse(String(r.detected || '{}')),
    }));
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
    sweepPhotos(db, cfg.photosDir);
    return now;
  }

  return { readiness, plan, createJob, recordResult, listJobs, housekeeping };
}
export type Provisioning = ReturnType<typeof createProvisioning>;
