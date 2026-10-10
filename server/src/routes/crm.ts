import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { isSuspended, type RadiusInfo } from '../services/crm-sync.ts';
import { distanceM, type LatLon } from '../domain/geo.ts';
import { isAp } from '../services/uisp.ts';
import { radiusView } from '../domain/health.ts';

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

  // ---- Clienti: anagrafiche e sedi di installazione ------------------------------------------

  type Customer = { customer_id: string; name: string; internal_code: string; type: string; status: string; group_name: string; phone: string; phone2: string; email: string; address_line1: string; address_line2: string; city: string; postal_code: string; state_code: string };
  type Address = { address_id: string; customer_id: string; description: string; address_line1: string; address_line2: string; city: string; postal_code: string; state_code: string; lat: number | null; lng: number | null; is_main: number };
  const addressText = (a: { address_line1: string; address_line2: string; city: string; postal_code: string; state_code: string }) =>
    [[a.address_line1, a.address_line2].filter(Boolean).join(' '), [a.postal_code, a.city, a.state_code ? `(${a.state_code})` : ''].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  /**
   * Everything needed to list customers: their installation sites (the address of each account),
   * the PPPoE session and the CPE in UISP (session MAC, or PPPoE user of the installation), with
   * the distance between the CRM position and the UISP one. A UISP position equal to the one of
   * an AP or a site (within 15 m) is suspicious: UISP gives it to CPEs without their own.
   */
  async function customerIndex() {
    const customers = ctx.db.prepare('SELECT * FROM crm_customers').all() as Customer[];
    const addresses = new Map((ctx.db.prepare('SELECT * FROM crm_addresses').all() as Address[]).map((a) => [a.address_id, a]));
    const accounts = new Map<string, RadiusInfo[]>();
    for (const r of ctx.crmSync.all()) {
      if (r.accountStatus === 'Terminato') continue;
      accounts.set(r.customerId, [...(accounts.get(r.customerId) ?? []), r]);
    }
    const devices = ctx.uisp ? await ctx.uisp.allDevices().catch(() => []) : [];
    const byMac = new Map(devices.filter((d) => d.mac).map((d) => [d.mac!, d]));
    const anchors: LatLon[] = devices.filter((d) => isAp(d) && d.location).map((d) => d.location!);
    if (ctx.uisp) for (const site of await ctx.uisp.sites().catch(() => [])) if (site.location) anchors.push(site.location);
    const jobMac = new Map(
      (ctx.db.prepare("SELECT lower(pppoe_user) u, mac FROM provisioning_jobs WHERE status = 'success' AND pppoe_user <> '' ORDER BY created_at").all() as Array<{ u: string; mac: string }>).map((r) => [r.u, r.mac]),
    );
    const view = (c: Customer) => {
      const accs = accounts.get(c.customer_id) ?? [];
      const sites = accs.map((r) => {
        const a = addresses.get(r.addressId);
        const mac = r.mac ?? jobMac.get(r.username.toLowerCase()) ?? null;
        const d = mac ? byMac.get(mac) : undefined;
        const crmPos = a && a.lat !== null && a.lng !== null ? { lat: a.lat, lon: a.lng } : null;
        const uispPos = d?.location ?? null;
        return {
          addressId: r.addressId,
          description: a?.description ?? '',
          address: a ? addressText(a) : '',
          isMain: a ? a.is_main === 1 : null,
          position: crmPos,
          account: { ...radiusView(r), accountId: r.accountId, mac: r.mac },
          cpe: d ? { id: d.id, name: d.name, mac: d.mac, model: d.model, status: d.status, signal: d.signal, apName: d.apName, position: uispPos } : null,
          distanceM: crmPos && uispPos ? Math.round(distanceM(crmPos, uispPos)) : null,
          suspicious: uispPos ? anchors.some((p) => distanceM(p, uispPos) < 15) : false,
        };
      });
      return {
        customerId: c.customer_id,
        name: c.name,
        code: c.internal_code,
        type: c.type,
        status: c.status,
        group: c.group_name,
        phone: c.phone,
        phone2: c.phone2,
        email: c.email,
        mainAddress: addressText(c),
        suspended: c.status === 'suspended' || sites.some((x) => x.account.suspended),
        sites,
      };
    };
    return { customers, view };
  }

  app.get('/api/admin/crm/customers', admin, async (req) => {
    const q = z
      .object({
        filter: z.enum(['all', 'with_accounts', 'suspended', 'offline', 'mismatch', 'nocoords']).default('with_accounts'),
        q: z.string().trim().max(80).default(''),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      })
      .parse(req.query);
    const { customers, view } = await customerIndex();
    const needle = q.q.toLowerCase();
    const rows = customers
      .map(view)
      .filter((c) => {
        if (q.filter === 'with_accounts' && !c.sites.length) return false;
        if (q.filter === 'suspended' && !c.suspended) return false;
        if (q.filter === 'offline' && !c.sites.some((x) => x.account.online === false && !x.account.suspended)) return false;
        if (q.filter === 'mismatch' && !c.sites.some((x) => (x.distanceM ?? 0) > 100)) return false;
        if (q.filter === 'nocoords' && !c.sites.some((x) => !x.position)) return false;
        if (!needle) return true;
        return [c.name, c.code, c.phone, c.email, c.mainAddress, ...c.sites.flatMap((x) => [x.address, x.account.username, x.cpe?.name, x.cpe?.mac, x.cpe?.apName])].some((v) => v?.toLowerCase().includes(needle));
      })
      .sort((a, b) => (q.filter === 'mismatch' ? Math.max(...b.sites.map((x) => x.distanceM ?? 0)) - Math.max(...a.sites.map((x) => x.distanceM ?? 0)) : 0) || a.name.localeCompare(b.name));
    return { ...ctx.crmSync.state(), total: rows.length, rows: rows.slice(0, q.limit) };
  });

  /** One customer; a site without coordinates is placed from its address (local geocoder, approximate). */
  app.get('/api/admin/crm/customers/:id', admin, async (req) => {
    const id = z.string().trim().min(1).max(20).parse((req.params as { id: string }).id);
    const { customers, view } = await customerIndex();
    const c = customers.find((x) => x.customer_id === id);
    if (!c) throw new HttpError(404, 'customer_not_found');
    const v = view(c);
    const sites = await Promise.all(
      v.sites.map(async (x) => {
        if (x.position || !x.address) return { ...x, approximate: false };
        const hit = (await ctx.geocoder.search(x.address).catch(() => []))[0];
        return { ...x, position: hit ? { lat: hit.lat, lon: hit.lon } : null, approximate: !!hit };
      }),
    );
    recordEvent(ctx.db, req.user!.id, 'crm.customer.view', v.name, `cliente ${id}`);
    return { ...v, sites };
  });
}
