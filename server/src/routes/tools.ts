import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { ROUTEROS_SECTIONS, READONLY_ALLOW, READONLY_DENY } from '../domain/routeros.ts';
import { routerOsAction } from '../net/routeros-ssh.ts';
import * as tools from '../net/tools.ts';

const host = z.object({ host: z.string().trim().min(1).max(253) });

export function toolRoutes(app: FastifyInstance, ctx: AppContext) {
  // the MAC vendors (IEEE registries) for everyone with the tools
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('network_tools')] };
  // the tools that work from CDA Net's server (its interfaces, its ARP table, scans, SNMP and SSH
  // towards private networks, that is CDA Net's own): not for a specialist without «visibilità
  // piena» (issue #275); the app runs its tools on the phone
  const server = { preHandler: [ctx.auth.requireCdaWork, ctx.modules.require('network_tools')] };
  const ros = { preHandler: [ctx.auth.requireUser, ctx.modules.require('routeros')] };
  const rosServer = { preHandler: [ctx.auth.requireCdaWork, ctx.modules.require('routeros')] };

  app.get('/api/tools/interfaces', server, () => tools.interfaces());
  /** Adds the IEEE vendor to every MAC of a result. */
  const withVendors = async <T extends { mac?: string }>(rows: T[]) => {
    const v = await ctx.oui.lookup(rows.map((r) => r.mac).filter((m): m is string => !!m)).catch(() => ({}) as Record<string, string | null>);
    return rows.map((r) => ({ ...r, vendor: r.mac ? (v[r.mac] ?? null) : null }));
  };
  app.get('/api/tools/neighbors', server, async () => {
    const r = await tools.neighbors();
    return { ...r, neighbors: await withVendors(r.neighbors) };
  });
  app.post('/api/tools/ping', server, (req) => tools.ping(host.parse(req.body).host));
  app.post('/api/tools/traceroute', server, (req) => tools.traceroute(host.parse(req.body).host));
  app.post('/api/tools/dns', server, (req) => tools.dnsLookup(host.parse(req.body).host));
  app.post('/api/tools/netbios', server, (req) => tools.netbios(host.parse(req.body).host));
  app.post('/api/tools/discover', server, async (req) => {
    const r = await tools.discover(z.object({ cidr: z.string().max(40) }).parse(req.body).cidr);
    return { ...r, hosts: await withVendors(r.hosts) };
  });
  app.post('/api/tools/snmp', server, (req) => {
    const b = host.extend({ community: z.string().min(1).max(64) }).parse(req.body);
    return tools.snmpSystem(b.host, b.community);
  });
  app.post('/api/tools/port-probe', server, (req) => {
    const b = host.extend({ ports: z.array(z.number().int().min(1).max(65535)).min(1).max(32).default([80, 443, 554, 8000, 8080, 8899]) }).parse(req.body);
    return tools.tcpProbe(b.host, b.ports);
  });
  app.post('/api/tools/onvif', server, () => tools.onvifDiscovery());
  app.post('/api/tools/hikvision', server, () => tools.hikvisionDiscovery());
  app.post('/api/tools/bgp', server, (req) => tools.bgpView(z.object({ resource: z.string().trim().max(64) }).parse(req.body).resource));
  app.post('/api/tools/mac-vendor', user, async (req) => {
    const mac = z.object({ mac: z.string().trim().max(32) }).parse(req.body).mac;
    const vendor = (await ctx.oui.lookup([mac]))[mac];
    return vendor ? { mac, vendor, source: 'IEEE' } : tools.macVendor(mac);
  });

  /** Vendors of many MACs at once (IP scanner): IEEE registries kept by the server. */
  app.post('/api/tools/mac-vendors', user, async (req) => {
    const { macs } = z.object({ macs: z.array(z.string().trim().max(32)).max(1024) }).parse(req.body);
    return ctx.oui.lookup([...new Set(macs)]);
  });

  // RouterOS (read-only) from the server.
  app.get('/api/routeros/catalog', ros, async () => ({
    sections: ROUTEROS_SECTIONS,
    readonly: { deny: READONLY_DENY.source, allow: READONLY_ALLOW.source },
  }));
  app.post('/api/routeros/action', rosServer, async (req) => {
    const b = z
      .object({
        host: z.string().trim().min(1).max(253),
        port: z.number().int().min(1).max(65535).default(22),
        username: z.string().min(1).max(80),
        password: z.string().min(1).max(200),
        action: z.string().max(40).default('dashboard'),
        command: z.string().max(300).optional(),
      })
      .parse(req.body);
    return routerOsAction(b, b.action, b.command, ctx.cfg.routerOsAllowPublic);
  });
}
