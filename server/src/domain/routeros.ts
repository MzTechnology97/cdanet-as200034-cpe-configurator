/**
 * Read-only RouterOS catalogue. Served to the Android client through
 * GET /api/routeros/catalog so both sides run exactly the same commands.
 */

export interface RosCommand {
  command: string;
  title: string;
}
export interface RosSection {
  id: string;
  title: string;
  commands: RosCommand[];
}

const c = (command: string, title: string): RosCommand => ({ command, title });

export const ROUTEROS_SECTIONS: RosSection[] = [
  {
    id: 'quickset',
    title: 'Quick Set',
    commands: [
      c('/system identity print', 'Identità'),
      c('/system resource print', 'Risorse'),
      c('/ip address print detail without-paging', 'Indirizzi IP'),
      c('/ip route print detail without-paging', 'Routing'),
      c('/ip dhcp-server print detail without-paging', 'DHCP'),
      c('/interface pppoe-client print detail without-paging', 'PPPoE'),
      c('/interface wireless print detail without-paging', 'Wireless'),
    ],
  },
  {
    id: 'capsman',
    title: 'CAPsMAN',
    commands: [
      c('/caps-man manager print', 'CAPsMAN Manager'),
      c('/caps-man interface print detail without-paging', 'CAPsMAN Interfaces'),
      c('/caps-man registration-table print detail without-paging', 'CAPsMAN Registrazioni'),
    ],
  },
  { id: 'interfaces', title: 'Interfaces', commands: [c('/interface print detail without-paging', 'Interfaces')] },
  {
    id: 'wireless',
    title: 'Wireless',
    commands: [
      c('/interface wireless print detail without-paging', 'Wireless v6'),
      c('/interface wireless registration-table print detail without-paging', 'Registrazioni Wireless'),
      c('/interface wifi print detail without-paging', 'WiFi RouterOS v7'),
    ],
  },
  {
    id: 'bridge',
    title: 'Bridge',
    commands: [
      c('/interface bridge print detail without-paging', 'Bridge'),
      c('/interface bridge port print detail without-paging', 'Bridge Ports'),
      c('/interface bridge host print detail without-paging', 'Bridge Hosts'),
    ],
  },
  {
    id: 'ppp',
    title: 'PPP',
    commands: [
      c('/ppp active print detail without-paging', 'PPP Active'),
      c('/interface pppoe-client print detail without-paging', 'PPPoE Client'),
      c('/interface pppoe-server server print detail without-paging', 'PPPoE Server'),
    ],
  },
  {
    id: 'switch',
    title: 'Switch',
    commands: [
      c('/interface ethernet switch print detail without-paging', 'Switch'),
      c('/interface ethernet switch port print detail without-paging', 'Switch Ports'),
    ],
  },
  { id: 'mesh', title: 'Mesh', commands: [c('/interface mesh print detail without-paging', 'Mesh')] },
  {
    id: 'ip',
    title: 'IP',
    commands: [
      c('/ip address print detail without-paging', 'IP Addresses'),
      c('/ip arp print detail without-paging', 'ARP'),
      c('/ip route print detail without-paging', 'IP Routes'),
      c('/ip dhcp-server lease print detail without-paging', 'DHCP Leases'),
      c('/ip firewall filter print stats detail without-paging', 'Firewall Filter'),
      c('/ip firewall nat print stats detail without-paging', 'Firewall NAT'),
      c('/ip service print detail without-paging', 'IP Services'),
    ],
  },
  {
    id: 'mpls',
    title: 'MPLS',
    commands: [
      c('/mpls interface print detail without-paging', 'MPLS Interfaces'),
      c('/mpls ldp neighbor print detail without-paging', 'LDP Neighbors'),
      c('/mpls forwarding-table print detail without-paging', 'MPLS Forwarding'),
    ],
  },
  {
    id: 'routing',
    title: 'Routing',
    commands: [
      c('/routing bgp peer print detail without-paging', 'BGP Peers v6'),
      c('/routing bgp session print detail without-paging', 'BGP Sessions v7'),
      c('/routing ospf neighbor print detail without-paging', 'OSPF Neighbors'),
      c('/routing ospf interface print detail without-paging', 'OSPF Interfaces'),
    ],
  },
  {
    id: 'system',
    title: 'System',
    commands: [
      c('/system identity print', 'Identity'),
      c('/system resource print', 'Resources'),
      c('/system routerboard print', 'RouterBOARD'),
      c('/system clock print', 'Clock'),
      c('/system package print without-paging', 'Packages'),
    ],
  },
  {
    id: 'queues',
    title: 'Queues',
    commands: [
      c('/queue simple print stats detail without-paging', 'Simple Queues'),
      c('/queue tree print stats detail without-paging', 'Queue Tree'),
    ],
  },
  { id: 'files', title: 'Files', commands: [c('/file print detail without-paging', 'Files')] },
  { id: 'log', title: 'Log', commands: [c('/log print without-paging', 'Log')] },
  { id: 'radius', title: 'RADIUS', commands: [c('/radius print detail without-paging', 'RADIUS')] },
  {
    id: 'tools',
    title: 'Tools',
    commands: [
      c('/tool profile duration=2', 'Profiler'),
      c('/tool bandwidth-server print', 'Bandwidth Server'),
      c('/ip service print detail without-paging', 'Management Services'),
    ],
  },
];

export const SUPOUT_COMMAND = '/system sup-output name=cda-supout.rif';

export const READONLY_DENY =
  /\b(add|set|remove|unset|enable|disable|reset|reboot|shutdown|upgrade|install|uninstall|move|make-supout|sup-output|export|backup|restore|fetch|upload|download|password|secret|user|certificate|script|scheduler|import|run|execute)\b/i;
export const READONLY_ALLOW = /\b(print|monitor|registration-table|profile|ping|traceroute)\b/i;

/** Validates a free-form terminal command. Throws a user-facing Italian message. */
export function readonlyCommand(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('/')) throw new Error('Il comando deve iniziare con /');
  if (s.length > 300) throw new Error('Comando troppo lungo');
  if (/[;\r\n`$]|\[|\]/.test(s)) throw new Error('Caratteri non ammessi nel terminale in sola lettura');
  if (READONLY_DENY.test(s)) throw new Error('Terminale RouterOS in sola lettura: comando di modifica bloccato');
  if (!READONLY_ALLOW.test(s)) throw new Error('Sono ammessi solo comandi di lettura/diagnostica');
  return s;
}

/** Removes credentials from RouterOS output before it leaves the server. */
export function redactRouterOs(text: string): string {
  return String(text)
    .replace(
      /((?:password|passwd|secret|private-key|passphrase|shared-secret|authentication-key|encryption-key|wpa-pre-shared-key|wpa2-pre-shared-key|passphrase)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1***REDACTED***',
    );
}

export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (m) out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

export interface RosSummary {
  identity: string;
  version: string;
  uptime: string;
  boardName: string;
  architecture: string;
  cpu: string;
  cpuCount: string;
  cpuFrequency: string;
  cpuLoad: string;
  freeMemory: string;
  totalMemory: string;
  freeHdd: string;
  totalHdd: string;
  currentFirmware: string;
  upgradeFirmware: string;
}

export function summarize(identity: string, resource: string, board: string): RosSummary {
  const r = parseKeyValues(resource);
  const b = parseKeyValues(board);
  const id = parseKeyValues(identity);
  return {
    identity: id.name ?? '',
    version: r.version ?? '',
    uptime: r.uptime ?? '',
    boardName: r['board-name'] ?? b.model ?? '',
    architecture: r['architecture-name'] ?? '',
    cpu: r.cpu ?? '',
    cpuCount: r['cpu-count'] ?? '',
    cpuFrequency: r['cpu-frequency'] ?? '',
    cpuLoad: r['cpu-load'] ?? '',
    freeMemory: r['free-memory'] ?? '',
    totalMemory: r['total-memory'] ?? '',
    freeHdd: r['free-hdd-space'] ?? '',
    totalHdd: r['total-hdd-space'] ?? '',
    currentFirmware: b['current-firmware'] ?? '',
    upgradeFirmware: b['upgrade-firmware'] ?? '',
  };
}
