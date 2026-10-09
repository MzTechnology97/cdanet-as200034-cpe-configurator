import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';

/**
 * Infrastructure settings (address/HTTPS, auto-update, maps): they belong to other containers,
 * so the app cannot apply them itself. It writes a request for the updater agent, which
 * validates it again, updates .env, restarts what is needed and reports the outcome
 * (deploy/updater/update.sh, exchange files in the data volume).
 */
export const INFRA_KEYS = {
  APP_LISTEN: /^(:[0-9]{1,5}|[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/,
  HTTPS_SITES: /^https:\/\/[A-Za-z0-9.:-]+( https:\/\/[A-Za-z0-9.:-]+){0,9}$/,
  HTTPS_DEFAULT_SNI: /^[A-Za-z0-9.:-]{1,253}$/,
  AUTOUPDATE: /^[01]$/,
  UPDATE_INTERVAL: /^[0-9]{2,5}$/,
  UPDATE_WINDOW: /^(([01][0-9]|2[0-4])-([01][0-9]|2[0-4]))?$/,
  CDANET_CHANNEL: /^[a-z0-9][a-z0-9._-]{0,39}$/,
  MAP_MODE: /^(local|off)$/,
  MAP_REGION: /^(sicilia|isole|sud|centro|nord-est|nord-ovest|italia|custom)$/,
  MAP_BBOX: /^-?[0-9]{1,3}(\.[0-9]+)?,-?[0-9]{1,2}(\.[0-9]+)?,-?[0-9]{1,3}(\.[0-9]+)?,-?[0-9]{1,2}(\.[0-9]+)?$/,
} as const;
type InfraKey = keyof typeof INFRA_KEYS;

/** A request not picked up within this time means the updater is not running (or too old). */
const STALE_MS = 60_000;

function readEnvFile(file: string): Record<string, string> | null {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
  } catch {
    return null;
  }
}

function checkValue(k: InfraKey, v: string): boolean {
  if (!INFRA_KEYS[k].test(v)) return false;
  if (k === 'UPDATE_INTERVAL') return Number(v) >= 60;
  if (k === 'MAP_BBOX') {
    const [w = 0, s = 0, e = 0, n = 0] = v.split(',').map(Number);
    return w >= -180 && e <= 180 && s >= -90 && n <= 90 && w < e && s < n;
  }
  return true;
}

export function infraRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };
  const dir = ctx.cfg.infraDir;
  const file = (n: string) => join(dir, n);

  function view() {
    const current = readEnvFile(file('current.env'));
    const st = readEnvFile(file('status.env'));
    let pendingSince: string | null = null;
    try {
      pendingSince = statSync(file('request.env')).mtime.toISOString();
    } catch {
      /* no request waiting */
    }
    const values: Partial<Record<InfraKey, string>> = {};
    for (const k of Object.keys(INFRA_KEYS) as InfraKey[]) if (current && k in current) values[k] = current[k];
    return {
      agent: current?.AGENT === '1',
      values,
      status: st ? { at: st.AT || null, result: st.RESULT || null, message: st.MESSAGE || '' } : null,
      pending: pendingSince != null,
      stale: pendingSince != null && Date.now() - Date.parse(pendingSince) > STALE_MS,
    };
  }

  app.get('/api/admin/infra', admin, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return view();
  });

  app.put('/api/admin/infra', admin, async (req, reply) => {
    const b = z
      .object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}), action: z.enum(['map_update']).optional() })
      .strict()
      .parse(req.body);
    const lines: string[] = [];
    for (const [k, raw] of Object.entries(b.values)) {
      if (!(k in INFRA_KEYS)) throw new HttpError(400, 'unknown_setting');
      const v = typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw).trim().replace(/\s+/g, ' ');
      if (!checkValue(k as InfraKey, v)) throw new HttpError(400, 'invalid_value', { key: k });
      lines.push(`${k}=${v}`);
    }
    // the agent reads the lines in order: the area comes after the region
    lines.sort((a, z2) => Number(a.startsWith('MAP_BBOX=')) - Number(z2.startsWith('MAP_BBOX=')));
    if (b.action) lines.push(`ACTION=${b.action}`);
    if (!lines.length) throw new HttpError(400, 'nothing_to_apply');
    if (!existsSync(file('current.env'))) throw new HttpError(409, 'infra_agent_missing');
    if (existsSync(file('request.env'))) throw new HttpError(409, 'infra_request_pending');

    mkdirSync(dir, { recursive: true });
    const tmp = file(`.request-${process.pid}.tmp`);
    writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o644 });
    renameSync(tmp, file('request.env')); // atomic: the agent never reads half a request
    recordEvent(ctx.db, req.user!.id, 'server.infra', lines.join(' '), 'richiesta all’agente di aggiornamento');
    reply.code(202);
    return view();
  });
}
