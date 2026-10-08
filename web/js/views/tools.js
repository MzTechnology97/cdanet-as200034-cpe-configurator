import { api } from '../api.js';
import { busy, card, field, h, mount, pageHead, stat, table } from '../dom.js';

/** Server-side diagnostics: everything runs from the CDA Net server's network. */

function ipCalc(cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(cidr.trim());
  if (!m) throw new Error('Formato IPv4/CIDR non valido');
  const q = m[1].split('.').map(Number);
  const p = Number(m[2] ?? 24);
  if (q.some((x) => x > 255) || p > 32) throw new Error('Formato IPv4/CIDR non valido');
  const ip = ((q[0] << 24) | (q[1] << 16) | (q[2] << 8) | q[3]) >>> 0;
  const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  const net = (ip & mask) >>> 0;
  const bc = (net | (~mask >>> 0)) >>> 0;
  const s = (x) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join('.');
  return {
    Rete: `${s(net)}/${p}`,
    Netmask: s(mask),
    Broadcast: s(bc),
    'Primo host': p < 31 ? s(net + 1) : s(net),
    'Ultimo host': p < 31 ? s(bc - 1) : s(bc),
    Indirizzi: 2 ** (32 - p),
  };
}

async function speedTest() {
  const pings = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await api('/api/tools/speed/ping');
    pings.push(performance.now() - t);
  }
  const avg = pings.reduce((a, b) => a + b, 0) / pings.length;
  const jitter = pings.slice(1).reduce((a, x, i) => a + Math.abs(x - pings[i]), 0) / (pings.length - 1);
  let t = performance.now();
  const r = await api('/api/tools/speed/download?bytes=16777216', { raw: true });
  const bytes = (await r.arrayBuffer()).byteLength;
  const down = (bytes * 8) / ((performance.now() - t) / 1000) / 1e6;
  const payload = new Uint8Array(8 * 1024 * 1024);
  t = performance.now();
  await api('/api/tools/speed/upload', { method: 'POST', body: payload, headers: { 'Content-Type': 'application/octet-stream' } });
  const up = (payload.byteLength * 8) / ((performance.now() - t) / 1000) / 1e6;
  return { Ping: `${avg.toFixed(0)} ms`, Jitter: `${jitter.toFixed(0)} ms`, Download: `${down.toFixed(1)} Mbps`, Upload: `${up.toFixed(1)} Mbps` };
}

function render(kind, d) {
  if (kind === 'ping') return h('div', { class: 'grid' }, stat('Host', `${d.host} (${d.ip})`), stat('Stato', d.reachable ? 'Raggiungibile' : 'Non raggiungibile'), stat('Latenza', d.ms != null ? `${d.ms} ms` : '—'));
  if (kind === 'traceroute')
    return table(
      [
        { label: 'Hop', key: 'hop' },
        { label: 'IP', render: (x) => x.ip ?? '*' },
        { label: 'DNS', render: (x) => x.hostname || '' },
        { label: 'ms', render: (x) => (x.ms != null ? x.ms : '—') },
      ],
      d.hops,
    );
  if (kind === 'dns') return h('div', { class: 'grid' }, stat('Host', d.host), stat('Indirizzi', d.addresses.join(' · ') || 'nessuno'));
  if (kind === 'discover' || kind === 'neighbors')
    return table(
      [
        { label: 'IP', key: 'ip' },
        { label: 'Hostname', render: (x) => x.hostname || '—' },
        { label: 'MAC', render: (x) => h('span', { class: 'mono' }, x.mac || '—') },
        { label: 'Stato', render: (x) => x.state || 'online' },
      ],
      d.hosts ?? d.neighbors,
    );
  if (kind === 'onvif' || kind === 'hikvision')
    return table(
      [
        { label: 'IP', key: 'ip' },
        { label: 'Descrizione', render: (x) => x.DeviceDescription || x.xaddrs || '—' },
        { label: 'MAC', render: (x) => x.MAC || '—' },
        { label: 'Firmware', render: (x) => x.SoftwareVersion || '—' },
      ],
      d.devices,
    );
  if (kind === 'interfaces') return h('div', { class: 'grid' }, stat('Interfaccia', d.interface), stat('Indirizzi', d.addresses.join(', ')), stat('Gateway', d.gateway || '—'), stat('DNS', d.dns.join(', ')));
  if (kind === 'port-probe') return h('div', { class: 'grid' }, stat('Host', d.host), stat('Porte aperte', d.openPorts.join(', ') || 'nessuna'));
  if (kind === 'netbios') return h('div', { class: 'grid' }, stat('Host', d.host), stat('NetBIOS', d.available ? d.names.join(', ') || 'risposta senza nomi' : 'nessuna risposta'));
  if (kind === 'bgp') return h('div', {}, h('div', { class: 'grid' }, stat('Risorsa', d.resource), stat('Origin AS', d.origins.join(', ') || '—')), h('pre', {}, JSON.stringify(d.visibility, null, 2)));
  return h('div', { class: 'grid' }, Object.entries(d).map(([k, v]) => stat(k, typeof v === 'object' ? JSON.stringify(v) : v)));
}

export async function toolsView() {
  const out = h('div', {});
  const target = h('input', { value: '1.1.1.1', placeholder: 'IP, hostname, ASN o prefisso' });
  const cidr = h('input', { placeholder: '192.168.1.0/24' });
  const mac = h('input', { placeholder: 'AABBCCDDEEFF o AA:BB:CC:DD:EE:FF' });
  const snmpHost = h('input', { placeholder: '10.x.x.x' });
  const community = h('input', { type: 'password', autocomplete: 'off', placeholder: 'community v2c' });
  const ports = h('input', { value: '80,443,554,8000,8080,8899,22,20080,20443' });

  const tool = (label, kind, fn) => {
    const b = h('button', {}, label);
    b.onclick = () =>
      busy(b, async () => {
        mount(out, h('p', { class: 'muted' }, `${label} in corso…`));
        try {
          const d = await fn();
          mount(out, card(h('h2', {}, label), render(kind, d)));
        } catch (e) {
          mount(out, h('div', { class: 'notice bad' }, `${label}: ${e.message}`));
        }
      });
    return b;
  };
  const post = (path, body) => api(`/api/tools/${path}`, { method: 'POST', body });

  return h(
    'div',
    {},
    pageHead('Strumenti di rete', 'Eseguiti dal server CDA Net (punto di vista NOC). Per diagnosi sulla LAN del cliente usa l’app Android.'),
    card(
      h('h2', {}, 'Host / Internet'),
      h('div', { class: 'row' }, field('Target', target)),
      h(
        'div',
        { class: 'btns' },
        tool('Ping', 'ping', () => post('ping', { host: target.value.trim() })),
        tool('Traceroute', 'traceroute', () => post('traceroute', { host: target.value.trim() })),
        tool('DNS lookup', 'dns', () => post('dns', { host: target.value.trim() })),
        tool('BGP (RIPEstat)', 'bgp', () => post('bgp', { resource: target.value.trim() })),
        tool('NetBIOS', 'netbios', () => post('netbios', { host: target.value.trim() })),
        tool('Interfacce server', 'interfaces', () => api('/api/tools/interfaces')),
        tool('Speed test server', 'speed', speedTest),
      ),
    ),
    card(
      h('h2', {}, 'Reti private / CGNAT'),
      h('div', { class: 'row' }, field('Subnet (max /24)', cidr), field('Porte da verificare', ports)),
      h(
        'div',
        { class: 'btns' },
        tool('Scansione subnet', 'discover', () => post('discover', { cidr: cidr.value.trim() })),
        tool('ARP / neighbor', 'neighbors', () => api('/api/tools/neighbors')),
        tool('Verifica porte', 'port-probe', () =>
          post('port-probe', { host: target.value.trim(), ports: ports.value.split(/[ ,;]+/).filter(Boolean).map(Number) }),
        ),
        tool('ONVIF discovery', 'onvif', () => post('onvif', {})),
        tool('Hikvision SADP', 'hikvision', () => post('hikvision', {})),
      ),
    ),
    card(
      h('h2', {}, 'SNMP v2c'),
      h('div', { class: 'row' }, field('Host', snmpHost), field('Community', community)),
      tool('Interroga', 'snmp', async () => {
        try {
          return await post('snmp', { host: snmpHost.value.trim(), community: community.value });
        } finally {
          community.value = '';
        }
      }),
    ),
    card(
      h('h2', {}, 'Utility'),
      h('div', { class: 'row' }, field('IPv4/CIDR', cidr), field('MAC address', mac)),
      h(
        'div',
        { class: 'btns' },
        tool('Calcolatrice IP', 'ipcalc', async () => ipCalc(cidr.value || '192.168.1.0/24')),
        tool('MAC vendor', 'mac', () => post('mac-vendor', { mac: mac.value.trim() })),
      ),
    ),
    out,
  );
}
