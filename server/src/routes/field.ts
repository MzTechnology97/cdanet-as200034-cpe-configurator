import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { TARGET_FIRMWARE, parseClientHeader, versionAtLeast } from '../domain/policy.ts';

/**
 * Field tools (alignment, diagnosis, acceptance test) of the Android app: they talk to
 * an already provisioned CPE, so they need the CDA Net CPE credentials. Same trust model
 * as the provisioning package: Android client only, short-lived, audited, never stored.
 */
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
  const user = { preHandler: ctx.auth.requireUser };

  app.post('/api/field/access', user, async (req, reply) => {
    const client = parseClientHeader(req.headers['x-cda-client'] as string | undefined);
    if (!client) throw new HttpError(403, 'trusted_client_required');
    if (!versionAtLeast(client.version, ctx.cfg.minAndroidVersion)) {
      throw new HttpError(426, 'client_update_required', { minVersion: ctx.cfg.minAndroidVersion });
    }
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
      targetFirmware: TARGET_FIRMWARE,
      thresholds: FIELD_THRESHOLDS,
      expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    };
  });
}
