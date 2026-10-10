import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { SSID_RX, TARGET_FIRMWARE, parseClientHeader, parseMac, versionAtLeast } from '../domain/policy.ts';

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
    const marks = macs.map(() => '?').join(',');
    const job = ctx.db
      .prepare(
        `SELECT j.id, j.created_at createdAt, j.status, j.model, j.template_name template, j.mac, j.serial, j.ssid, j.pppoe_user pppoeUser, j.device_name deviceName
           FROM provisioning_jobs j
          WHERE j.status = 'success' AND j.mac IN (${marks})
            ${admin ? '' : 'AND (j.user_id = ? OR EXISTS (SELECT 1 FROM cpe_assignments a WHERE a.mac = j.mac AND a.user_id = ?))'}
          ORDER BY j.created_at DESC LIMIT 1`,
      )
      .get(...macs, ...(admin ? [] : [req.user!.id, req.user!.id]));
    return { job: job ?? null };
  });
}
