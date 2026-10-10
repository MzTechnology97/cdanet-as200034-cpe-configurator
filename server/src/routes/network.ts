import type { FastifyInstance } from 'fastify';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { isSuspended } from '../services/crm-sync.ts';

/** AP state shown in "Stato rete". */
export type ApState = 'ok' | 'degraded' | 'down';

/**
 * State of an AP from UISP: down when UISP does not see it as active, degraded when a large share
 * of its CPEs is offline (a sector problem rather than single customers). Pure, unit-tested.
 */
export function apState(status: string, cpe: { total: number; offline: number } | undefined): ApState {
  if (status !== 'active') return 'down';
  if (cpe && cpe.total >= 3 && cpe.offline / cpe.total >= 0.3) return 'degraded';
  return 'ok';
}

/**
 * "Stato rete" (module network_status): state of the POPs and APs - admins all of them, installers
 * only the assigned ones (names and state only: no positions, no data sources). No notifications.
 */
export function networkRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('network_status')] };

  app.get('/api/network/status', user, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    const u = req.user!;
    const keys = u.role === 'admin' ? null : new Set(ctx.outages.assignments(u.id).map((i) => i.key));
    const [inf, counts] = await Promise.all([ctx.uisp.infrastructure(), ctx.uisp.cpeCounts()]);
    // admins: real positions and the sector already served, for the map of the whole network
    const sectors = keys
      ? new Map()
      : await ctx.uisp.apModels([...inf.pops.flatMap((p) => p.aps), ...inf.apsWithoutPop].map((a) => a.id)).catch(() => new Map());
    const showClients = !keys || ctx.outages.config().installerClients;
    // admins with the CRM: PPPoE sessions of the CPEs of each AP (matched by MAC), suspended accounts apart
    const pppoe = new Map<string, { online: number; offline: number; suspended: number }>();
    if (!keys && ctx.crmSync.available()) {
      const { byMac } = ctx.crmSync.index();
      for (const d of await ctx.uisp.allDevices().catch(() => [])) {
        const r = d.apId && d.mac ? byMac.get(d.mac) : undefined;
        if (!r || !d.apId) continue;
        const c = pppoe.get(d.apId) ?? { online: 0, offline: 0, suspended: 0 };
        if (isSuspended(r)) c.suspended++;
        else if (r.online === true) c.online++;
        else if (r.online === false) c.offline++;
        pppoe.set(d.apId, c);
      }
    }
    // Enel outages near a POP/AP (when the user also has Guasti Enel).
    const power = new Set<string>();
    if (ctx.modules.stateFor(u.id).power_outages) {
      for (const o of ctx.outages.active(ctx.outages.keysFor(u.id, u.role))) for (const i of o.impact) power.add(`${i.type}:${i.id}`);
    }

    const apView = (a: (typeof inf.pops)[number]['aps'][number]) => {
      const c = counts.get(a.id);
      const state = apState(a.status, c);
      return {
        id: a.id,
        name: a.name,
        ssid: a.ssid,
        model: a.model,
        state,
        lastSeen: state === 'down' ? a.lastSeen : null,
        cpe: showClients && c ? c : null,
        // without the numbers, installers still learn that customers are affected
        cpeOffline: c ? (c.offline === 0 ? 'none' : state === 'degraded' ? 'many' : 'some') : null,
        powerOutage: power.has(`ap:${a.id}`),
        // installers never get coordinates (POP/AP only as approximate areas elsewhere)
        ...(keys
          ? {}
          : {
              lat: a.lat,
              lon: a.lon,
              locationFrom: a.locationFrom,
              stations: a.stations,
              pppoe: pppoe.get(a.id) ?? null,
              served: (() => {
                const m = sectors.get(a.id);
                return m?.sector ? { center: m.sector.center, width: m.sector.width, servedM: m.servedM } : null;
              })(),
            }),
      };
    };
    const mine = (popId: string, apId: string) => !keys || keys.has(`pop:${popId}`) || keys.has(`ap:${apId}`);

    const pops = inf.pops
      .map((p) => {
        const aps = p.aps.filter((a) => mine(p.id, a.id)).map(apView);
        const listed = !keys || keys.has(`pop:${p.id}`) || aps.length > 0;
        if (!listed) return null;
        const down = aps.filter((a) => a.state === 'down').length;
        return {
          id: p.id,
          name: p.name,
          state: (aps.length && down === aps.length ? 'down' : down || aps.some((a) => a.state === 'degraded') ? 'degraded' : 'ok') as ApState,
          powerOutage: power.has(`pop:${p.id}`) || aps.some((a) => a.powerOutage),
          ...(keys ? {} : { lat: p.lat, lon: p.lon }),
          aps,
        };
      })
      .filter((p) => p !== null)
      // problems first
      .sort((a, b) => ['down', 'degraded', 'ok'].indexOf(a.state) - ['down', 'degraded', 'ok'].indexOf(b.state) || a.name.localeCompare(b.name));
    const loose = inf.apsWithoutPop.filter((a) => !keys || keys.has(`ap:${a.id}`)).map(apView);
    const all = [...pops.flatMap((p) => p.aps), ...loose];
    return {
      generatedAt: new Date().toISOString(),
      restricted: !!keys,
      assignedCount: keys ? keys.size : null,
      summary: { aps: all.length, down: all.filter((a) => a.state === 'down').length, degraded: all.filter((a) => a.state === 'degraded').length, powerOutage: all.filter((a) => a.powerOutage).length },
      pops,
      apsWithoutPop: loose,
    };
  });
}
