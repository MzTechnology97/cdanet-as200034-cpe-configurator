import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { SSID_RX, TARGET_FIRMWARE, parseClientHeader, parseMac, versionAtLeast, macSiblings, REPOINT_GRANT_HOURS, REPOINT_CLAIM_MAX_M } from '../domain/policy.ts';
import { distanceM, isValidLatLon } from '../domain/geo.ts';

/**
 * Field tools (alignment, diagnosis, acceptance test) of the Android app: they talk to
 * an already provisioned CPE, so they need the CDA Net CPE credentials. Same trust model
 * as the provisioning package: Android client only, short-lived, audited, never stored.
 */
/** Defaults of the thresholds (the live ones are in Impostazioni server: ctx.cfg.thresholds). */
export const FIELD_THRESHOLDS = {
  /** dBm: good / acceptable received signal on the CPE. */
  signalGood: -65,
  signalMin: -75,
  /** dB: CINR below this means interference or misalignment. */
  cinrMin: 20,
  /** dB: difference between the two chains above this suggests polarization/obstacle. */
  chainDelta: 6,
  /** Mbit/s: minimum airMAX capacity (download) for a new installation. */
  capacityMinMbps: 100,
  /** Mbit/s: Ethernet port below this (10 Mbit or half duplex) points to the cable. */
  ethMinMbps: 100,
} as const;

export function fieldRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('field_alignment', 'field_diagnosis', 'acceptance')] };

  /** Secrets go only to the Android app, at the minimum version. */
  const trustedClient = (header: string | undefined) => {
    const client = parseClientHeader(header);
    if (!client) throw new HttpError(403, 'trusted_client_required');
    if (!versionAtLeast(client.version, ctx.cfg.minAndroidVersion)) {
      throw new HttpError(426, 'client_update_required', { minVersion: ctx.cfg.minAndroidVersion });
    }
  };

  app.post('/api/field/access', user, async (req, reply) => {
    trustedClient(req.headers['x-cda-client'] as string | undefined);
    const b = z
      .object({ purpose: z.enum(['alignment', 'diagnosis', 'acceptance']).default('diagnosis'), target: z.string().trim().max(80).optional() })
      .strict()
      .parse(req.body ?? {});
    const s = ctx.cfg.cpeSecrets;
    if (!s.adminPassword) throw new HttpError(409, 'cpe_admin_secret_missing');
    const n = ctx.cfg.network;
    recordEvent(ctx.db, req.user!.id, 'field.access', b.target || '—', b.purpose);
    reply.header('Cache-Control', 'no-store');
    return {
      credentials: { username: s.adminUsername, password: s.adminPassword },
      // Tried in order by the app, after the gateway of the current Wi-Fi.
      hosts: [...new Set([n.lanIp, n.factoryIp])],
      sshPort: n.sshPort,
      targetFirmware: TARGET_FIRMWARE,
      thresholds: ctx.cfg.thresholds,
      expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    };
  });

  /**
   * Re-linking a CPE to another AP (guided installation, re-pointing): the WPA2 key of the new
   * CDA Net SSID, which the app writes into the CPE. Same trust model as the provisioning package.
   */
  app.post('/api/field/relink', user, async (req, reply) => {
    trustedClient(req.headers['x-cda-client'] as string | undefined);
    const b = z
      .object({ ssid: z.string().regex(SSID_RX), mac: z.string().max(40).optional(), from: z.string().max(64).optional() })
      .strict()
      .parse(req.body);
    const row = ctx.db.prepare('SELECT wpa2_ciphertext FROM wireless_secrets WHERE ssid = ?').get(b.ssid) as { wpa2_ciphertext: string } | undefined;
    if (!row) throw new HttpError(409, 'ssid_secret_not_configured');
    const psk = ctx.sealer.open(row.wpa2_ciphertext);
    recordEvent(ctx.db, req.user!.id, 'field.relink', (b.mac && parseMac(b.mac)) || '—', `${b.from || '?'} → ${b.ssid}`);
    reply.header('Cache-Control', 'no-store');
    return { ssid: b.ssid, psk, sshPort: ctx.cfg.network.sshPort };
  });

  /**
   * An installed CPE found on the roof (re-pointing, maintenance): its installation job, so the
   * new acceptance test and photos go with it. Installers see their own jobs and assigned CPEs.
   */
  app.get('/api/field/cpe', user, async (req) => {
    const q = z.object({ macs: z.string().max(200) }).parse(req.query);
    const macs = [...new Set(q.macs.split(',').map((m) => parseMac(m)).filter((m): m is string => !!m))].slice(0, 8);
    if (!macs.length) throw new HttpError(400, 'invalid_mac');
    const admin = req.user!.role === 'admin';
    // the user's own installations (or the CPEs assigned to them) on these MACs, newest first
    const find = (list: string[]) =>
      list.length
        ? (ctx.db
            .prepare(
              `SELECT j.id, j.created_at createdAt, j.status, j.model, j.template_name template, j.mac, j.serial, j.ssid, j.pppoe_user pppoeUser, j.device_name deviceName
                 FROM provisioning_jobs j
                WHERE j.status = 'success' AND j.mac IN (${list.map(() => '?').join(',')})
                  ${admin ? '' : 'AND (j.user_id = ? OR EXISTS (SELECT 1 FROM cpe_assignments a WHERE a.mac = j.mac AND a.user_id = ?))'}
                ORDER BY j.created_at DESC`,
            )
            .all(...list, ...(admin ? [] : [req.user!.id, req.user!.id])) as Array<Record<string, unknown> & { mac: string }>)
        : [];
    const exact = find(macs);
    if (exact.length) return { job: exact[0] };
    // the same CPE seen from another interface (LAN vs radio MAC, fourth byte ±1), with the same
    // ownership rules; two different CPEs that could both be it: none (never a guess)
    const siblings = find([...new Set(macs.flatMap(macSiblings))].filter((m) => !macs.includes(m)));
    return { job: new Set(siblings.map((j) => j.mac)).size === 1 ? siblings[0] : null };
  });

  /**
   * Re-pointing a CPE installed by someone else (another technician, not assigned to this one): the
   * installation is found by MAC among all of them (exact MAC, else the only sibling) and handed over
   * for its re-pointing tests, without taking the CPE from anyone. Only on site (the phone's GPS near
   * the installation, when its position is known), for a day, revocable by the NOC, who hears of it
   * at once. Customer name and PPPoE user only: never passwords or CPE credentials.
   */
  app.post('/api/field/cpe/claim', user, async (req) => {
    const b = z
      .object({
        macs: z.array(z.string().max(40)).min(1).max(8),
        position: z.object({ lat: z.number(), lon: z.number(), accuracyM: z.number().min(0).max(100_000).nullable().optional() }).strict().optional(),
      })
      .strict()
      .parse(req.body);
    const macs = [...new Set(b.macs.map((m) => parseMac(m)).filter((m): m is string => !!m))];
    if (!macs.length) throw new HttpError(400, 'invalid_mac');
    const jobsOn = (list: string[]) =>
      list.length
        ? (ctx.db
            .prepare(
              `SELECT j.id, j.created_at createdAt, j.status, j.model, j.template_name template, j.mac, j.serial, j.ssid, j.pppoe_user pppoeUser, j.device_name deviceName, j.user_id userId
                 FROM provisioning_jobs j WHERE j.status = 'success' AND j.mac IN (${list.map(() => '?').join(',')}) ORDER BY j.created_at DESC`,
            )
            .all(...list) as Array<Record<string, unknown> & { id: string; mac: string; userId: number }>)
        : [];
    let found = jobsOn(macs);
    if (!found.length) {
      const sib = jobsOn([...new Set(macs.flatMap(macSiblings))].filter((m) => !macs.includes(m)));
      found = new Set(sib.map((j) => j.mac)).size === 1 ? sib : [];
    }
    const job = found[0];
    // none: a CPE installed before the app (nothing to attach the test to yet)
    if (!job) return { job: null };
    const { userId, ...view } = job;
    const me = req.user!;
    if (userId !== me.id && me.role !== 'admin') {
      // on site only: the installation's position (or its work order's) against the phone's GPS
      const at = ctx.db
        .prepare('SELECT COALESCE(j.latitude, w.lat) lat, COALESCE(j.longitude, w.lon) lon FROM provisioning_jobs j LEFT JOIN work_orders w ON w.id = j.work_order_id WHERE j.id = ?')
        .get(job.id) as { lat: number | null; lon: number | null };
      let away: number | null = null;
      if (isValidLatLon(at.lat, at.lon)) {
        if (!b.position || !isValidLatLon(b.position.lat, b.position.lon)) throw new HttpError(400, 'position_required');
        away = Math.round(distanceM({ lat: at.lat!, lon: at.lon! }, b.position));
        // the GPS error is forgiven up to 200 m
        if (away > REPOINT_CLAIM_MAX_M + Math.min(b.position.accuracyM ?? 0, 200)) throw new HttpError(403, 'too_far', { distanceM: away, maxM: REPOINT_CLAIM_MAX_M });
      }
      const now = nowIso();
      const cutoff = new Date(Date.now() - REPOINT_GRANT_HOURS * 3_600_000).toISOString();
      // a new grant, or an expired one renewed: the NOC hears of it at once
      const fresh = ctx.db
        .prepare('INSERT INTO repoint_grants(job_id, user_id, granted_at) VALUES(?, ?, ?) ON CONFLICT(job_id, user_id) DO UPDATE SET granted_at = excluded.granted_at WHERE repoint_grants.granted_at < ?')
        .run(job.id, me.id, now, cutoff);
      if (fresh.changes) {
        recordEvent(ctx.db, me.id, 'job.repoint_claim', job.id, `ripuntamento della CPE ${job.mac} installata da un altro installatore${away != null ? ` · a ${away} m` : ' · posizione dell\'installazione sconosciuta'}`);
        const installer = ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
        ctx.notify.inbox.push('noc', {
          kind: 'repoint_unplanned',
          title: `CPE di un altro installatore presa per un ripuntamento: ${String(job.deviceName || job.pppoeUser || job.mac)}`,
          lines: [
            `Tecnico: ${me.username}`,
            `CPE: ${job.mac} · ${String(job.ssid)}`,
            `Installata da ${installer?.username ?? 'un altro installatore'}`,
            away != null ? `Telefono a ${away} m dall'installazione` : `Posizione dell'installazione sconosciuta: presenza non verificata`,
            `Accesso al collaudo per ${REPOINT_GRANT_HOURS} ore, revocabile dalla console`,
          ],
          jobId: job.id,
          mac: job.mac,
        });
      }
    }
    return { job: view };
  });
}