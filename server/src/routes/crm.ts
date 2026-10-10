import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { isSuspended } from '../services/crm-sync.ts';

/**
 * RADIUS state from the CRM for the NOC (admins only): last sync, sync on demand and the account
 * list with the CPE each one is matched to in UISP (session MAC) or in the app (PPPoE user).
 */
export function crmRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireAdmin] };

  app.get('/api/admin/crm/radius/status', admin, async () => ({ configured: ctx.crm.client() !== null, ...ctx.crmSync.state() }));

  /** Starts a sync and answers at once: the console polls the status. */
  app.post('/api/admin/crm/radius/sync', admin, async (req) => {
    if (!ctx.crm.client()) throw new HttpError(409, 'crm_not_configured');
    const already = ctx.crmSync.state().running;
    if (!already) {
      recordEvent(ctx.db, req.user!.id, 'crm.radius.sync', 'RADIUS', 'sincronizzazione manuale');
      void ctx.crmSync.sync();
    }
    return { started: !already, running: true };
  });

  app.get('/api/admin/crm/radius', admin, async (req) => {
    const q = z
      .object({
        filter: z.enum(['all', 'offline', 'suspended', 'unmatched']).default('all'),
        q: z.string().trim().max(80).default(''),
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      })
      .parse(req.query);
    // CPEs in UISP by MAC and installations of the app by PPPoE user, to say which CPE an account is
    const cpeByMac = new Map<string, { name: string; status: string; apName: string | null }>();
    if (ctx.uisp) {
      try {
        for (const d of await ctx.uisp.allDevices()) if (d.mac) cpeByMac.set(d.mac, { name: d.name, status: d.status, apName: d.apName });
      } catch {
        // without UISP the list still shows the accounts
      }
    }
    const jobByUser = new Map(
      (ctx.db.prepare("SELECT lower(pppoe_user) u, mac FROM provisioning_jobs WHERE status = 'success' AND pppoe_user <> '' ORDER BY created_at").all() as Array<{ u: string; mac: string }>).map((r) => [r.u, r.mac]),
    );
    const needle = q.q.toLowerCase();
    const rows = ctx.crmSync
      .all()
      .filter((r) => r.accountStatus !== 'Terminato')
      .map((r) => {
        const mac = r.mac ?? jobByUser.get(r.username.toLowerCase()) ?? null;
        const cpe = mac ? cpeByMac.get(mac) ?? null : null;
        return { ...r, suspended: isSuspended(r), cpe: cpe ? { mac, ...cpe } : null };
      })
      .filter((r) => {
        if (q.filter === 'offline' && !(r.online === false && !r.suspended)) return false;
        if (q.filter === 'suspended' && !r.suspended) return false;
        if (q.filter === 'unmatched' && r.cpe) return false;
        return !needle || [r.username, r.customerName, r.profile, r.mac, r.clientIp, r.cpe?.name, r.cpe?.apName].some((v) => v?.toLowerCase().includes(needle));
      })
      .sort((a, b) => Number(b.suspended) - Number(a.suspended) || Number(a.online ?? 2) - Number(b.online ?? 2) || a.customerName.localeCompare(b.customerName));
    return { ...ctx.crmSync.state(), total: rows.length, rows: rows.slice(0, q.limit) };
  });
}
