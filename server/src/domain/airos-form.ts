import type { CpeModel } from './policy.ts';
import { MANAGEMENT_PORTS, SUPPORTED_MODELS } from './policy.ts';
import { normalizeTemplate, setKey } from './systemcfg.ts';

/**
 * The airOS template as a form, like the CPE's own web interface (Wireless, Rete, Servizi,
 * Sistema): every field reads and writes real `system.cfg` keys of airOS 8.7.4. The template text
 * stays the only source of truth: the form is read from it and only the fields the admin changed
 * are written back, so an unchanged template stays the same byte for byte.
 *
 * What changes per customer stays a `${PLACEHOLDER}` (SSID and its key, PPPoE, device name…);
 * everything else is a value of the template. Two values are forced by the server at every
 * provisioning (watchdog host and SNMP contact): they live in the template's parameters, and two
 * secrets (SNMP community, UISP key) are sealed apart and never returned.
 */

export type FormValue = string | number | boolean;
export type FormValues = Record<string, FormValue>;
export type Section = 'wireless' | 'network' | 'services' | 'system';

type Cfg = Map<string, string>;
type Writes = Array<[string, string]>;

export interface FieldDef {
  id: string;
  section: Section;
  label: string;
  hint: string;
  type: 'bool' | 'int' | 'ip' | 'host' | 'text' | 'select';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  /** Shown only in this wireless or network mode. */
  only?: { wirelessMode?: 'station' | 'ap'; netMode?: 'router' | 'bridge' };
  /** Network rule of CDA Net: the form warns when the value differs. */
  policy?: { value: FormValue; message: string };
  /** Keys guessed from the airOS documentation, not yet seen in a lab export: to try on the bench. */
  experimental?: boolean;
  /** An address that may be left empty (no gateway, or typed for each CPE). */
  optional?: true;
  /** Kept in the template's parameters (forced by the server at every provisioning), not in the text. */
  param?: true;
  /**
   * Only in the specialist's templates (owner, 17/10/2026): CDA Net forces this value at every
   * provisioning, a template of the specialist has it in its own text.
   */
  free?: true;
  read?: (c: Cfg) => FormValue | undefined;
  /** [mode]: CDA Net's templates or the specialist's ones (free). */
  write?: (v: FormValue, c: Cfg, mode: FormMode) => Writes;
  fallback: FormValue | ((model: CpeModel) => FormValue);
}

const on = (v: string | undefined) => (v === undefined ? undefined : v === 'enabled');
const st = (v: FormValue) => (v ? 'enabled' : 'disabled');
const num = (v: string | undefined) => (v === undefined || v.trim() === '' || !/^-?\d+$/.test(v.trim()) ? undefined : Number(v));
const isPlaceholder = (v: string | undefined) => !!v && v.includes('${');
/** The SSID of the template: the AP's one in Station, its own as an AP; a placeholder is typed for each CPE. */
const ssidOf = (c: Cfg) => (c.get('radio.1.mode') === 'master' ? (c.get('aaa.1.ssid') ?? c.get('wireless.1.ssid')) : (c.get('wpasupplicant.profile.1.network.1.ssid') ?? c.get('wireless.1.ssid')));

/** LAN = the interface served by the DHCP server (router); in bridge mode, the management bridge. */
export function lanIndex(c: Cfg): string | null {
  const dev = c.get('netmode') === 'bridge' ? 'br0' : c.get('dhcpd.1.devname');
  for (const [k, v] of c) {
    const m = /^netconf\.(\d+)\.devname$/.exec(k);
    if (m && v === dev) return m[1] as string;
  }
  for (const [k, v] of c) {
    const m = /^netconf\.(\d+)\.role$/.exec(k);
    if (m && (v === 'lan' || v === 'mlan')) return m[1] as string;
  }
  return null;
}
const lanKey = (c: Cfg, leaf: string) => {
  const i = lanIndex(c);
  return i ? `netconf.${i}.${leaf}` : null;
};
const simple = (key: string, kind: 'bool' | 'int' | 'text') => ({
  read: (c: Cfg) => (kind === 'bool' ? on(c.get(key)) : kind === 'int' ? num(c.get(key)) : isPlaceholder(c.get(key)) ? undefined : c.get(key)),
  write: (v: FormValue): Writes => [[key, kind === 'bool' ? st(v) : String(v)]],
});
const both = (keys: string[]) => ({
  read: (c: Cfg) => on(c.get(keys[0] as string)),
  write: (v: FormValue): Writes => keys.map((k) => [k, st(v)]),
});

/** Antenna gain of the integrated antenna (dBi), as the model's datasheet. */
export const ANTENNA_GAIN: Record<CpeModel, number> = {
  'NanoStation Loco 5AC': 13,
  'NanoStation 5AC': 16,
  'NanoBeam 5AC': 19,
  'LiteBeam 5AC': 23,
  'PowerBeam 5AC': 25,
};

/** Range the CPEs of the CDA Net network scan (MHz), when the scan is limited. */
export const POLICY_BAND = { from: 5120, to: 5800 } as const;

const CHANNEL_WIDTHS = [
  { value: '0', label: 'Automatica' },
  { value: '10', label: '10 MHz' },
  { value: '20', label: '20 MHz' },
  { value: '30', label: '30 MHz' },
  { value: '40', label: '40 MHz' },
  { value: '50', label: '50 MHz' },
  { value: '60', label: '60 MHz' },
  { value: '80', label: '80 MHz' },
];

/** Scan list `radio.1.scan_list.channels` (MHz, comma separated) as from/to/step. */
function scanRange(c: Cfg) {
  const list = (c.get('radio.1.scan_list.channels') ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!list.length) return null;
  return { from: list[0] as number, to: list[list.length - 1] as number, step: list.length > 1 ? (list[1] as number) - (list[0] as number) : 5 };
}
function scanList(from: number, to: number, step: number) {
  const out: number[] = [];
  for (let f = from; f <= to && out.length < 400; f += Math.max(5, step)) out.push(f);
  return out.join(',');
}

export const FIELDS: FieldDef[] = [
  // ---- Wireless ---------------------------------------------------------------------------
  {
    id: 'wirelessMode',
    section: 'wireless',
    label: 'Modalità wireless',
    hint: 'Station: la CPE del cliente si collega all’AP. Access Point: la CPE trasmette la rete (ponti, rilanci).',
    type: 'select',
    options: [
      { value: 'station', label: 'Station' },
      { value: 'ap', label: 'Access Point' },
    ],
    read: (c) => (c.get('radio.1.mode') === 'master' ? 'ap' : c.get('radio.1.mode') === undefined ? undefined : 'station'),
    write: (v, c, mode) =>
      v === 'ap'
        ? [
            ['radio.1.mode', 'master'],
            ['wpasupplicant.status', 'disabled'],
            ['wpasupplicant.device.1.status', 'disabled'],
            ['aaa.status', 'enabled'],
            ['aaa.1.status', 'enabled'],
            ['aaa.1.devname', 'ath0'],
            ['aaa.1.br.devname', 'br0'],
            // CDA Net's SSID is chosen for each customer; a fixed one of the specialist's template stays
            ['aaa.1.ssid', mode.free ? (c.get('wireless.1.ssid') ?? '${SSID}') : '${SSID}'],
            ['aaa.1.wpa.mode', '2'],
            ['aaa.1.wpa.key.1.mgmt', 'WPA-PSK'],
            ['aaa.1.wpa.1.pairwise', 'CCMP'],
            ['aaa.1.wpa.psk', '${WPA2_PSK}'],
          ]
        : [
            ['radio.1.mode', 'managed'],
            ['wpasupplicant.status', 'enabled'],
            ['wpasupplicant.device.1.status', 'enabled'],
            ['aaa.status', 'disabled'],
            ['aaa.1.status', 'disabled'],
          ],
    fallback: 'station',
  },
  {
    id: 'ptp',
    section: 'wireless',
    label: 'Collegamento',
    hint: 'PtMP airMAX: un AP con più station (rete CDA Net). PtP: un solo collegamento punto-punto.',
    type: 'select',
    options: [
      { value: 'ptmp', label: 'PtMP airMAX' },
      { value: 'ptp', label: 'PtP' },
    ],
    read: (c) => (c.get('radio.1.ptpmode') === undefined ? undefined : c.get('radio.1.ptpmode') === '1' ? 'ptp' : 'ptmp'),
    write: (v) => [['radio.1.ptpmode', v === 'ptp' ? '1' : '0']],
    fallback: 'ptmp',
  },
  {
    // the specialist's templates (titolare, 17/10/2026): the company's AP may be always the same;
    // CDA Net's SSID is chosen for each customer, its key comes from Reti Wi-Fi
    id: 'ssid',
    section: 'wireless',
    label: 'SSID',
    hint: 'In Station la rete dell’AP a cui collegarsi, in Access Point quella trasmessa. Vuoto: lo scrivi nel flusso per ogni CPE (${SSID}). La chiave Wi-Fi si imposta qui sotto.',
    type: 'text',
    free: true,
    read: (c) => {
      const v = ssidOf(c);
      return v === undefined ? undefined : isPlaceholder(v) ? '' : v;
    },
    write: (v, c) => {
      const s = String(v);
      if (new TextEncoder().encode(s).length > 32) throw new Error('form_invalid_ssid');
      const value = s === '' ? '${SSID}' : s;
      return [
        ['wireless.1.ssid', value],
        c.get('radio.1.mode') === 'master' ? ['aaa.1.ssid', value] : ['wpasupplicant.profile.1.network.1.ssid', value],
      ];
    },
    fallback: '',
  },
  {
    id: 'countryCode',
    section: 'wireless',
    label: 'Codice paese',
    hint: '511 = Compliance Test, usato su tutta la rete CDA Net.',
    type: 'int',
    min: 0,
    max: 999,
    policy: { value: 511, message: 'La rete CDA Net usa il codice paese 511 su tutte le CPE.' },
    read: (c) => num(c.get('radio.1.countrycode')),
    write: (v) => [
      ['radio.1.countrycode', String(v)],
      ['radio.countrycode', String(v)],
    ],
    fallback: 511,
  },
  {
    id: 'chanbw',
    section: 'wireless',
    label: 'Larghezza di canale',
    hint: 'In Station «Automatica» segue quella dell’AP.',
    type: 'select',
    options: CHANNEL_WIDTHS,
    read: (c) => c.get('radio.1.chanbw'),
    write: (v) => [['radio.1.chanbw', String(v)]],
    fallback: '0',
  },
  {
    id: 'frequency',
    section: 'wireless',
    label: 'Frequenza (MHz)',
    hint: 'Frequenza centrale trasmessa dall’AP; 0 = automatica.',
    type: 'int',
    min: 0,
    max: 6200,
    only: { wirelessMode: 'ap' },
    read: (c) => num(c.get('radio.1.freq')),
    write: (v) => [
      ['radio.1.freq', String(v)],
      ['radio.1.center.1.freq', String(v)],
    ],
    fallback: 0,
  },
  {
    id: 'scanLimit',
    section: 'wireless',
    label: 'Limita le frequenze di scansione',
    hint: 'Spento: la station cerca l’AP su tutte le frequenze del codice paese.',
    type: 'bool',
    only: { wirelessMode: 'station' },
    ...simple('radio.1.scan_list.status', 'bool'),
    fallback: false,
  },
  {
    id: 'scanFrom',
    section: 'wireless',
    label: 'Scansione da (MHz)',
    hint: `La rete CDA Net usa ${POLICY_BAND.from}-${POLICY_BAND.to} MHz.`,
    type: 'int',
    min: 4900,
    max: 6200,
    only: { wirelessMode: 'station' },
    policy: { value: POLICY_BAND.from, message: `La banda della rete CDA Net parte da ${POLICY_BAND.from} MHz.` },
    read: (c) => scanRange(c)?.from,
    write: (v, c) => {
      const r = scanRange(c) ?? { from: POLICY_BAND.from, to: POLICY_BAND.to, step: 5 };
      return [['radio.1.scan_list.channels', scanList(Number(v), r.to, r.step)]];
    },
    fallback: POLICY_BAND.from,
  },
  {
    id: 'scanTo',
    section: 'wireless',
    label: 'Scansione fino a (MHz)',
    hint: 'Ultima frequenza cercata, a passi di 5 MHz.',
    type: 'int',
    min: 4900,
    max: 6200,
    only: { wirelessMode: 'station' },
    policy: { value: POLICY_BAND.to, message: `La banda della rete CDA Net arriva a ${POLICY_BAND.to} MHz.` },
    read: (c) => scanRange(c)?.to,
    write: (v, c) => {
      const r = scanRange(c) ?? { from: POLICY_BAND.from, to: POLICY_BAND.to, step: 5 };
      return [['radio.1.scan_list.channels', scanList(r.from, Number(v), r.step)]];
    },
    fallback: POLICY_BAND.to,
  },
  {
    id: 'dfs',
    section: 'wireless',
    label: 'DFS',
    hint: 'Rilevamento radar sulle frequenze DFS.',
    type: 'bool',
    policy: { value: false, message: 'Sulle CPE della rete CDA Net il DFS è spento.' },
    ...simple('radio.1.dfs.status', 'bool'),
    fallback: false,
  },
  {
    id: 'txPower',
    section: 'wireless',
    label: 'Potenza in uscita (dBm)',
    hint: 'In Station la regola il controllo automatico (ATPC), sempre attivo.',
    type: 'int',
    min: -4,
    max: 30,
    ...simple('radio.1.txpower', 'int'),
    fallback: 25,
  },
  {
    id: 'antennaGain',
    section: 'wireless',
    label: 'Guadagno antenna (dBi)',
    hint: 'Quello dell’antenna integrata del modello (o dell’antenna esterna).',
    type: 'int',
    min: 0,
    max: 40,
    read: (c) => num(c.get('radio.1.antenna.gain')),
    write: (v) => [['radio.1.antenna.gain', String(v)]],
    fallback: (m) => ANTENNA_GAIN[m],
  },
  {
    id: 'cableLoss',
    section: 'wireless',
    label: 'Perdita cavo (dB)',
    hint: '0 per le antenne integrate.',
    type: 'int',
    min: 0,
    max: 20,
    ...simple('radio.1.cable.loss', 'int'),
    fallback: 0,
  },
  {
    id: 'ackAuto',
    section: 'wireless',
    label: 'Distanza automatica (ACK)',
    hint: 'Spento: si usa la distanza fissa qui sotto.',
    type: 'bool',
    ...simple('radio.1.ack.auto', 'bool'),
    fallback: true,
  },
  {
    id: 'ackDistance',
    section: 'wireless',
    label: 'Distanza (m)',
    hint: 'Usata solo con la distanza automatica spenta.',
    type: 'int',
    min: 0,
    max: 200_000,
    ...simple('radio.1.ackdistance', 'int'),
    fallback: 643,
  },
  {
    id: 'polling',
    section: 'wireless',
    label: 'airMAX',
    hint: 'Protocollo airMAX (TDMA) di Ubiquiti, necessario sulla rete CDA Net.',
    type: 'bool',
    ...simple('radio.1.polling', 'bool'),
    fallback: true,
  },
  {
    id: 'hideSsid',
    section: 'wireless',
    label: 'Nascondi SSID',
    hint: 'L’AP non annuncia il nome della rete.',
    type: 'bool',
    only: { wirelessMode: 'ap' },
    ...simple('wireless.1.hide_ssid', 'bool'),
    fallback: false,
  },
  {
    id: 'l2Isolation',
    section: 'wireless',
    label: 'Isolamento client (L2)',
    hint: 'Le station dello stesso AP non si vedono tra loro.',
    type: 'bool',
    only: { wirelessMode: 'ap' },
    ...simple('wireless.1.l2_isolation', 'bool'),
    fallback: false,
  },
  {
    id: 'wds',
    section: 'wireless',
    label: 'WDS (bridge trasparente)',
    hint: 'Necessario per il bridge a livello 2 tra AP e station.',
    type: 'bool',
    ...simple('wireless.1.wds.status', 'bool'),
    fallback: true,
  },

  // ---- Network ----------------------------------------------------------------------------
  {
    id: 'netMode',
    section: 'network',
    label: 'Modalità di rete',
    hint: 'Router: PPPoE sulla CPE e DHCP verso il cliente (CDA Net). Bridge: la CPE passa tutto al router del cliente.',
    type: 'select',
    options: [
      { value: 'router', label: 'Router' },
      { value: 'bridge', label: 'Bridge' },
    ],
    read: (c) => c.get('netmode'),
    write: (v, c, mode) => {
      if (v === 'bridge') {
        const out: Writes = [
          ['netmode', 'bridge'],
          ['ppp.status', 'disabled'],
          ['ppp.1.status', 'disabled'],
          ['dhcpd.status', 'disabled'],
          ['dhcpd.1.status', 'disabled'],
          ['iptables.sys.masq.status', 'disabled'],
          ['bridge.1.port.2.devname', 'eth0'],
          ['bridge.1.port.2.status', 'enabled'],
        ];
        // the management address moves on the bridge (br0)
        const lan = lanIndex(c);
        for (const [k, val] of c) {
          const m = /^netconf\.(\d+)\.devname$/.exec(k);
          if (m && val === 'br0') {
            out.push([`netconf.${m[1]}.role`, 'mlan']);
            if (lan && lan !== m[1]) {
              out.push([`netconf.${m[1]}.ip`, c.get(`netconf.${lan}.ip`) ?? '192.168.1.20']);
              out.push([`netconf.${m[1]}.netmask`, c.get(`netconf.${lan}.netmask`) ?? '255.255.255.0']);
              out.push([`netconf.${lan}.role`, '']);
            }
          }
        }
        // with a fixed address the CPE needs a way out (Carmelo, 21/10/2026): DNS by default, and in the
        // specialist's templates a gateway typed for each CPE until one is written here
        if (c.get('resolv.nameserver.1.ip') === undefined) {
          out.push(['resolv.nameserver.status', 'enabled'], ['resolv.nameserver.1.status', 'enabled'], ['resolv.nameserver.1.ip', '1.1.1.1'], ['resolv.nameserver.2.status', 'enabled'], ['resolv.nameserver.2.ip', '8.8.8.8']);
        }
        if (mode.free && c.get('route.1.gateway') === undefined) {
          out.push(['route.status', 'enabled'], ['route.1.status', 'enabled'], ['route.1.devname', 'br0'], ['route.1.ip', '0.0.0.0'], ['route.1.netmask', '0'], ['route.1.gateway', '${GATEWAY}']);
        }
        return out;
      }
      return [
        ['netmode', 'router'],
        ['ppp.status', 'enabled'],
        ['ppp.1.status', 'enabled'],
        ['dhcpd.status', 'enabled'],
        ['dhcpd.1.status', 'enabled'],
        ['iptables.sys.masq.status', 'enabled'],
        ['bridge.1.port.2.status', 'disabled'],
      ];
    },
    fallback: 'router',
  },
  {
    id: 'lanIp',
    section: 'network',
    label: 'IP della CPE (LAN)',
    hint: 'Indirizzo della CPE verso il cliente: anche quello con cui l’app la raggiunge dopo la configurazione.',
    type: 'ip',
    read: (c) => {
      const k = lanKey(c, 'ip');
      return k && !isPlaceholder(c.get(k)) ? c.get(k) : undefined;
    },
    write: (v, c) => {
      const k = lanKey(c, 'ip');
      return k ? [[k, String(v)]] : [];
    },
    fallback: '192.168.1.254',
  },
  {
    id: 'lanNetmask',
    section: 'network',
    label: 'Netmask LAN',
    hint: 'Di solito 255.255.255.0.',
    type: 'ip',
    read: (c) => {
      const k = lanKey(c, 'netmask');
      return k && !isPlaceholder(c.get(k)) ? c.get(k) : undefined;
    },
    write: (v, c) => {
      const k = lanKey(c, 'netmask');
      const out: Writes = k ? [[k, String(v)]] : [];
      if (c.has('dhcpd.1.netmask')) out.push(['dhcpd.1.netmask', String(v)]);
      return out;
    },
    fallback: '255.255.255.0',
  },
  {
    // bridge with a fixed address (Carmelo, 21/10/2026): without a gateway the CPE reaches nothing
    // beyond its own LAN (UISP, the time, updates). The keys of airOS 8 as on the APs of the network:
    // route.status, route.1.{status,devname,ip=0.0.0.0,netmask=0,gateway}
    id: 'gateway',
    section: 'network',
    label: 'Gateway',
    hint: 'In bridge con IP statico: il router da cui la CPE esce (UISP, ora, aggiornamenti). Vuoto: nessun gateway.',
    type: 'ip',
    optional: true,
    only: { netMode: 'bridge' },
    read: (c) => {
      const v = c.get('route.1.gateway');
      if (v === undefined) return undefined;
      if (isPlaceholder(v) || c.get('route.status') === 'disabled' || c.get('route.1.status') === 'disabled' || v === '0.0.0.0') return '';
      return v;
    },
    write: (v, c, mode) => {
      const s = String(v);
      if (s === '' && !mode.free) return [['route.status', 'disabled'], ['route.1.status', 'disabled']];
      const lan = lanIndex(c);
      const dev = (lan && c.get(`netconf.${lan}.devname`)) || 'br0';
      return [
        ['route.status', 'enabled'],
        ['route.1.status', 'enabled'],
        ['route.1.devname', dev],
        ['route.1.ip', '0.0.0.0'],
        ['route.1.netmask', '0'],
        ['route.1.gateway', s === '' ? '${GATEWAY}' : s],
      ];
    },
    fallback: '',
  },
  {
    id: 'dns1',
    section: 'network',
    label: 'DNS primario',
    hint: 'In bridge con IP statico: il server DNS della CPE (per raggiungere UISP e l’ora per nome). Vuoto: nessuno.',
    type: 'ip',
    optional: true,
    only: { netMode: 'bridge' },
    read: (c) => (isPlaceholder(c.get('resolv.nameserver.1.ip')) ? undefined : c.get('resolv.nameserver.1.status') === 'disabled' ? '' : c.get('resolv.nameserver.1.ip')),
    write: (v) =>
      String(v) === ''
        ? [['resolv.nameserver.1.status', 'disabled']]
        : [
            ['resolv.nameserver.status', 'enabled'],
            ['resolv.nameserver.1.status', 'enabled'],
            ['resolv.nameserver.1.ip', String(v)],
          ],
    fallback: '1.1.1.1',
  },
  {
    id: 'dns2',
    section: 'network',
    label: 'DNS secondario',
    hint: 'Usato se il primario non risponde. Vuoto: nessuno.',
    type: 'ip',
    optional: true,
    only: { netMode: 'bridge' },
    read: (c) => (isPlaceholder(c.get('resolv.nameserver.2.ip')) ? undefined : c.get('resolv.nameserver.2.status') === 'disabled' ? '' : c.get('resolv.nameserver.2.ip')),
    write: (v) =>
      String(v) === ''
        ? [['resolv.nameserver.2.status', 'disabled']]
        : [
            ['resolv.nameserver.status', 'enabled'],
            ['resolv.nameserver.2.status', 'enabled'],
            ['resolv.nameserver.2.ip', String(v)],
          ],
    fallback: '8.8.8.8',
  },
  {
    id: 'dhcp',
    section: 'network',
    label: 'Server DHCP',
    hint: 'Assegna gli indirizzi ai dispositivi del cliente.',
    type: 'bool',
    only: { netMode: 'router' },
    ...both(['dhcpd.status', 'dhcpd.1.status']),
    fallback: true,
  },
  { id: 'dhcpStart', section: 'network', label: 'DHCP da', hint: 'Primo indirizzo assegnato.', type: 'ip', only: { netMode: 'router' }, ...simple('dhcpd.1.start', 'text'), fallback: '192.168.1.10' },
  { id: 'dhcpEnd', section: 'network', label: 'DHCP fino a', hint: 'Ultimo indirizzo assegnato.', type: 'ip', only: { netMode: 'router' }, ...simple('dhcpd.1.end', 'text'), fallback: '192.168.1.50' },
  {
    id: 'dhcpLease',
    section: 'network',
    label: 'Durata lease (s)',
    hint: 'Per quanto vale un indirizzo assegnato.',
    type: 'int',
    min: 60,
    max: 86400,
    only: { netMode: 'router' },
    ...simple('dhcpd.1.lease_time', 'int'),
    fallback: 600,
  },
  { id: 'dnsProxy', section: 'network', label: 'DNS proxy', hint: 'La CPE risponde alle richieste DNS della LAN.', type: 'bool', only: { netMode: 'router' }, ...simple('dhcpd.1.dnsproxy', 'bool'), fallback: true },
  { id: 'pppoe', section: 'network', label: 'PPPoE', hint: 'Autenticazione del cliente sul concentratore (RADIUS).', type: 'bool', only: { netMode: 'router' }, ...both(['ppp.status', 'ppp.1.status']), fallback: true },
  { id: 'pppoeMtu', section: 'network', label: 'MTU PPPoE', hint: 'CDA Net: 1450.', type: 'int', min: 576, max: 1500, only: { netMode: 'router' }, ...simple('ppp.1.mtu', 'int'), fallback: 1450 },
  { id: 'pppoeMru', section: 'network', label: 'MRU PPPoE', hint: 'CDA Net: 1450.', type: 'int', min: 576, max: 1500, only: { netMode: 'router' }, ...simple('ppp.1.mru', 'int'), fallback: 1450 },
  { id: 'nat', section: 'network', label: 'NAT', hint: 'Traduzione degli indirizzi della LAN sulla WAN.', type: 'bool', only: { netMode: 'router' }, ...simple('iptables.sys.masq.status', 'bool'), fallback: true },
  { id: 'mssClamp', section: 'network', label: 'MSS clamping', hint: 'Adatta i pacchetti TCP all’MTU PPPoE.', type: 'bool', only: { netMode: 'router' }, ...simple('iptables.sys.tcpmss.status', 'bool'), fallback: true },
  { id: 'firewall', section: 'network', label: 'Firewall', hint: 'Regole firewall di airOS.', type: 'bool', ...simple('iptables.sys.fw.status', 'bool'), fallback: false },
  { id: 'portForward', section: 'network', label: 'Port forwarding', hint: 'Inoltro di porte verso la LAN.', type: 'bool', only: { netMode: 'router' }, ...simple('iptables.sys.portfw.status', 'bool'), fallback: false },
  { id: 'upnp', section: 'network', label: 'UPnP', hint: 'I dispositivi del cliente aprono da soli le porte.', type: 'bool', only: { netMode: 'router' }, ...simple('upnpd.status', 'bool'), fallback: false },
  { id: 'igmpProxy', section: 'network', label: 'Proxy IGMP (multicast)', hint: 'Per IPTV multicast.', type: 'bool', only: { netMode: 'router' }, ...simple('igmpproxy.status', 'bool'), fallback: false },
  { id: 'stp', section: 'network', label: 'STP sul bridge', hint: 'Spanning Tree sul bridge br0.', type: 'bool', ...simple('bridge.1.stp.status', 'bool'), fallback: false },

  // ---- Services ---------------------------------------------------------------------------
  {
    id: 'httpPort',
    section: 'services',
    label: 'Porta HTTP',
    hint: `CDA Net: ${MANAGEMENT_PORTS.http}. Il NOC e gli strumenti dell’app usano questa porta.`,
    type: 'int',
    min: 1,
    max: 65535,
    policy: { value: MANAGEMENT_PORTS.http, message: `Il NOC e gli strumenti dell’app raggiungono le CPE sulla porta ${MANAGEMENT_PORTS.http}.` },
    ...simple('httpd.port', 'int'),
    fallback: MANAGEMENT_PORTS.http,
  },
  { id: 'https', section: 'services', label: 'HTTPS', hint: 'Interfaccia web cifrata.', type: 'bool', ...simple('httpd.https.status', 'bool'), fallback: true },
  {
    id: 'httpsPort',
    section: 'services',
    label: 'Porta HTTPS',
    hint: `CDA Net: ${MANAGEMENT_PORTS.https}.`,
    type: 'int',
    min: 1,
    max: 65535,
    policy: { value: MANAGEMENT_PORTS.https, message: `Il NOC e gli strumenti dell’app raggiungono le CPE sulla porta ${MANAGEMENT_PORTS.https}.` },
    ...simple('httpd.https.port', 'int'),
    fallback: MANAGEMENT_PORTS.https,
  },
  { id: 'sessionTimeout', section: 'services', label: 'Scadenza sessione web (s)', hint: 'Dopo quanto l’interfaccia web chiede di nuovo l’accesso.', type: 'int', min: 60, max: 86400, ...simple('httpd.session.timeout', 'int'), fallback: 900 },
  { id: 'ssh', section: 'services', label: 'SSH', hint: 'Serve all’app per configurare e diagnosticare la CPE.', type: 'bool', policy: { value: true, message: 'L’app configura e diagnostica la CPE via SSH.' }, ...simple('sshd.status', 'bool'), fallback: true },
  { id: 'sshPort', section: 'services', label: 'Porta SSH', hint: 'Di solito 22.', type: 'int', min: 1, max: 65535, ...simple('sshd.port', 'int'), fallback: 22 },
  { id: 'sshPassword', section: 'services', label: 'SSH con password', hint: 'Accesso SSH con utente e password.', type: 'bool', ...simple('sshd.auth.passwd', 'bool'), fallback: true },
  { id: 'telnet', section: 'services', label: 'Telnet', hint: 'Accesso in chiaro: meglio spento.', type: 'bool', ...simple('telnetd.status', 'bool'), fallback: false },
  { id: 'ntp', section: 'services', label: 'Client NTP', hint: 'Ora della CPE da un server NTP.', type: 'bool', ...both(['ntpclient.status', 'ntpclient.1.status']), fallback: true },
  { id: 'ntpServer', section: 'services', label: 'Server NTP', hint: 'IP o nome del server dell’ora.', type: 'host', ...simple('ntpclient.1.server', 'text'), fallback: '10.0.0.254' },
  {
    id: 'watchdogHost',
    section: 'services',
    label: 'Ping watchdog: indirizzo',
    hint: 'La CPE si riavvia se questo indirizzo non risponde (watchdog sempre attivo).',
    type: 'host',
    param: true,
    // a template of the specialist (no values forced by the server) has it in its own text
    ...simple('pwdog.host', 'text'),
    fallback: '8.8.8.8',
  },
  { id: 'watchdogPeriod', section: 'services', label: 'Ping watchdog: intervallo (s)', hint: 'Ogni quanto controlla.', type: 'int', min: 10, max: 3600, ...simple('pwdog.period', 'int'), fallback: 300 },
  { id: 'watchdogDelay', section: 'services', label: 'Ping watchdog: attesa all’avvio (s)', hint: 'Quanto aspetta dopo l’accensione.', type: 'int', min: 0, max: 3600, ...simple('pwdog.delay', 'int'), fallback: 300 },
  { id: 'watchdogRetry', section: 'services', label: 'Ping watchdog: tentativi', hint: 'Ping falliti prima del riavvio.', type: 'int', min: 1, max: 100, ...simple('pwdog.retry', 'int'), fallback: 3 },
  {
    id: 'snmpContact',
    section: 'services',
    label: 'SNMP: contatto',
    hint: 'Il server lo scrive in ogni CPE (SNMP sempre attivo; la location è il nome del cliente).',
    type: 'text',
    param: true,
    ...simple('snmp.contact', 'text'),
    fallback: '172.31.0.7',
  },
  // forced on by CDA Net at every provisioning: a choice of the template only for the specialist
  { id: 'watchdog', section: 'services', label: 'Ping watchdog', hint: 'La CPE si riavvia se l’indirizzo del watchdog non risponde.', type: 'bool', free: true, ...simple('pwdog.status', 'bool'), fallback: true },
  { id: 'snmp', section: 'services', label: 'SNMP', hint: 'Agente SNMP v2c della CPE (community del template).', type: 'bool', free: true, ...simple('snmp.status', 'bool'), fallback: true },
  { id: 'uisp', section: 'services', label: 'UISP', hint: 'La CPE si collega a UISP con la chiave del template.', type: 'bool', ...simple('unms.status', 'bool'), fallback: true },
  { id: 'discovery', section: 'services', label: 'Device discovery', hint: 'La CPE risponde alla ricerca Ubiquiti (anche l’app la usa).', type: 'bool', ...simple('discovery.status', 'bool'), fallback: true },
  { id: 'cdp', section: 'services', label: 'CDP', hint: 'Annunci Cisco Discovery Protocol.', type: 'bool', ...simple('discovery.cdp.status', 'bool'), fallback: true },
  { id: 'syslogRemote', section: 'services', label: 'Syslog remoto', hint: 'Invia i log a un server syslog.', type: 'bool', ...simple('syslog.remote.status', 'bool'), fallback: false },
  { id: 'syslogHost', section: 'services', label: 'Server syslog', hint: 'IP del server syslog.', type: 'host', experimental: true, ...simple('syslog.remote.ip', 'text'), fallback: '' },
  { id: 'syslogPort', section: 'services', label: 'Porta syslog', hint: 'Di solito 514.', type: 'int', min: 1, max: 65535, ...simple('syslog.remote.port', 'int'), fallback: 514 },

  // ---- System -----------------------------------------------------------------------------
  { id: 'timezone', section: 'system', label: 'Fuso orario', hint: 'Nel formato di airOS, es. UTC oppure CET-1CEST,M3.5.0,M10.5.0/3.', type: 'text', ...simple('system.timezone', 'text'), fallback: 'UTC' },
  { id: 'ledNight', section: 'system', label: 'LED spenti di notte', hint: 'Modalità notte dei LED.', type: 'bool', ...simple('system.leds.nightmode', 'bool'), fallback: false },
  { id: 'signalLed', section: 'system', label: 'LED del segnale', hint: 'I LED mostrano la qualità del segnale.', type: 'bool', ...simple('wireless.1.signal_led_status', 'bool'), fallback: true },
  { id: 'resetButton', section: 'system', label: 'Pulsante di reset', hint: 'Spento: il reset dal pulsante non funziona.', type: 'bool', ...simple('system.external.reset', 'bool'), fallback: true },
  { id: 'airview', section: 'system', label: 'airView', hint: 'Analizzatore di spettro di airOS.', type: 'bool', ...simple('airview.status', 'bool'), fallback: true },
  { id: 'updateCheck', section: 'system', label: 'Controllo aggiornamenti', hint: 'La CPE cerca nuovi firmware da sola: CDA Net li gestisce dal server.', type: 'bool', ...simple('update.check.status', 'bool'), fallback: false },
  { id: 'crashReports', section: 'system', label: 'Invio crash a Ubiquiti', hint: 'Segnalazioni automatiche degli errori.', type: 'bool', ...simple('system.autosend_crash_reports', 'bool'), fallback: false },
  { id: 'language', section: 'system', label: 'Lingua dell’interfaccia', hint: 'Lingua del web di airOS.', type: 'select', options: [{ value: 'en_US', label: 'English' }, { value: 'it_IT', label: 'Italiano' }], ...simple('gui.language', 'text'), fallback: 'en_US' },
];

const BY_ID = new Map(FIELDS.map((f) => [f.id, f]));

/**
 * How a form is read and written. CDA Net (default): two values live in the template's parameters
 * (the server forces them at every provisioning) and the network rules of CDA Net are checked.
 * [free]: a template of the specialist, where the text is the whole truth: those two values are its
 * own keys, the fields CDA Net forces are choices of the template, and no CDA Net rule applies.
 */
export interface FormMode {
  free?: boolean;
}

/** The fields of the form in a mode (the specialist's ones only in his templates). */
export function fieldsFor(mode: FormMode = {}): FieldDef[] {
  return mode.free ? FIELDS : FIELDS.filter((f) => !f.free);
}
const inParams = (f: FieldDef, mode: FormMode) => !!f.param && !mode.free;

/** Hints that speak of CDA Net's own rules, in the words of a template of the specialist. */
const FREE_HINTS: Record<string, string> = {
  watchdogHost: 'La CPE si riavvia se questo indirizzo non risponde (con il watchdog attivo).',
  snmpContact: 'Il contatto SNMP scritto nella CPE.',
  uisp: 'La CPE si collega all’UISP dell’azienda con la chiave del connettore (o quella scritta).',
  updateCheck: 'La CPE cerca nuovi firmware da sola.',
  gateway: 'In bridge con IP statico: il router da cui la CPE esce (UISP, ora, aggiornamenti). Vuoto: lo scrivi nel flusso per ogni CPE (${GATEWAY}).',
};

/** The fields as the console and the app get them (no code), with each model's default. */
export function formFieldsView(mode: FormMode = {}) {
  return fieldsFor(mode).map(({ read: _r, write: _w, fallback, param, free: _f, policy, hint, ...f }) => ({
    ...f,
    hint: (mode.free && FREE_HINTS[f.id]) || hint,
    // a value forced by the server and the network rules: only in CDA Net's templates
    ...(param && !mode.free ? { param } : {}),
    ...(policy && !mode.free ? { policy } : {}),
    fallback: typeof fallback === 'function' ? Object.fromEntries(SUPPORTED_MODELS.map((m) => [m, fallback(m)])) : fallback,
  }));
}

export interface TemplateParams {
  watchdogHost: string;
  snmpContact: string;
}

export function parseKeys(text: string): Cfg {
  const m: Cfg = new Map();
  for (const line of normalizeTemplate(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

const fallback = (f: FieldDef, model: CpeModel) => (typeof f.fallback === 'function' ? f.fallback(model) : f.fallback);

/** The form of a template: its values, and which fields were not in the text (shown with their default). */
export function readForm(text: string, params: TemplateParams, model: CpeModel, mode: FormMode = {}) {
  const c = parseKeys(text);
  const values: FormValues = {};
  const missing: string[] = [];
  for (const f of fieldsFor(mode)) {
    const v = inParams(f, mode) ? params[f.id as keyof TemplateParams] : f.read?.(c);
    if (v === undefined) missing.push(f.id);
    values[f.id] = v ?? fallback(f, model);
  }
  return { values, missing };
}

/** Values that differ from the network rules of CDA Net (none for a template of the specialist). */
export function policyWarnings(values: FormValues, mode: FormMode = {}) {
  const out: Array<{ field: string; message: string }> = [];
  if (mode.free) return out;
  for (const f of FIELDS) {
    if (!f.policy || !visible(f, values)) continue;
    if (f.id.startsWith('scan') && !values.scanLimit) continue;
    if (values[f.id] !== f.policy.value) out.push({ field: f.id, message: f.policy.message });
  }
  return out;
}

export function visible(f: FieldDef, values: FormValues) {
  return (!f.only?.wirelessMode || values.wirelessMode === f.only.wirelessMode) && (!f.only?.netMode || values.netMode === f.only.netMode);
}

/** Checks a value against its field: type, range, a single line. Throws `form_invalid_<id>`. */
function checked(f: FieldDef, v: unknown): FormValue {
  const bad = () => {
    throw new Error(`form_invalid_${f.id}`);
  };
  if (f.type === 'bool') return typeof v === 'boolean' ? v : bad();
  if (f.type === 'int') {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isInteger(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) bad();
    return n;
  }
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : bad();
  if (/[\r\n\0]/.test(s as string) || (s as string).length > 253) bad();
  if (f.type === 'select' && !f.options?.some((o) => o.value === s)) bad();
  if (f.type === 'ip' && !(f.optional && s === '') && !/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(s as string)) bad();
  if (f.type === 'host' && s !== '' && !/^[A-Za-z0-9.:-]+$/.test(s as string)) bad();
  if (f.type === 'text' && (s as string).includes('${')) bad();
  return s as string;
}

/**
 * Writes the fields the admin changed (compared with what was read from this same text) and
 * leaves everything else as it is. The modes go first: they decide which keys the others use.
 */
export function applyForm(text: string, params: TemplateParams, model: CpeModel, changes: Record<string, unknown>, mode: FormMode = {}) {
  const before = readForm(text, params, model, mode).values;
  const order = ['wirelessMode', 'netMode', ...Object.keys(changes).filter((k) => k !== 'wirelessMode' && k !== 'netMode')];
  let out = normalizeTemplate(text);
  const nextParams = { ...params };
  for (const id of order) {
    if (!(id in changes)) continue;
    const f = BY_ID.get(id);
    if (!f || (f.free && !mode.free)) throw new Error(`form_unknown_${id}`);
    const v = checked(f, changes[id]);
    if (v === before[id]) continue;
    if (inParams(f, mode)) {
      nextParams[id as keyof TemplateParams] = String(v);
      continue;
    }
    for (const [key, value] of f.write!(v, parseKeys(out), mode)) out = setKey(out, key, value);
  }
  return { text: out, params: nextParams };
}

/**
 * A new template from the form alone: the structure of an airOS 8.7.4 export (Station, Router,
 * PPPoE on the wireless WAN, DHCP on the LAN), without the lines that describe one physical CPE
 * (board, radio capabilities, MAC): airOS writes those from the hardware.
 */
export function skeletonFor(model: CpeModel): string {
  const gain = ANTENNA_GAIN[model];
  return `${[
    'upnpd.status=disabled',
    'igmpproxy.upstream.devname=br0',
    'igmpproxy.status=disabled',
    'tshaper.status=disabled',
    'ip6tables.sys.fw6.status=disabled',
    'ip6tables.sys.status=enabled',
    'ip6tables.status=enabled',
    'dhcpd.1.lease_time=600',
    'dhcpd.1.netmask=255.255.255.0',
    'dhcpd.1.end=192.168.1.50',
    'dhcpd.1.start=192.168.1.10',
    'dhcpd.1.dnsproxy=enabled',
    'dhcpd.1.devname=eth0',
    'dhcpd.1.status=enabled',
    'dhcpd.status=enabled',
    'ppp.1.require.mppe128=disabled',
    'ppp.1.mru=1450',
    'ppp.1.mtu=1450',
    'ppp.1.fallback_netmask=255.255.255.0',
    'ppp.1.fallback=192.168.10.1',
    'ppp.1.password=${PPPOE_PASSWORD}',
    'ppp.1.name=${PPPOE_USER}',
    'ppp.1.devname=br0',
    'ppp.1.status=enabled',
    'ppp.status=enabled',
    'dnsmasq.1.devname=eth0',
    'dnsmasq.1.status=enabled',
    'dnsmasq.status=enabled',
    'iptables.sys.portfw.status=disabled',
    'iptables.sys.fw.status=disabled',
    'iptables.sys.tcpmss.status=enabled',
    'iptables.sys.masq.1.devname=ppp+',
    'iptables.sys.masq.1.status=enabled',
    'iptables.sys.masq.status=enabled',
    'iptables.sys.status=enabled',
    'iptables.status=enabled',
    'bridge.1.port.1.devname=ath0',
    'bridge.1.port.1.status=enabled',
    'bridge.1.devname=br0',
    'bridge.1.stp.status=disabled',
    'bridge.1.status=enabled',
    'bridge.status=enabled',
    'netconf.3.role=wan',
    'netconf.3.mtu=1500',
    'netconf.3.autoip.status=disabled',
    'netconf.3.devname=br0',
    'netconf.3.status=enabled',
    'netconf.2.netmask=255.255.255.0',
    'netconf.2.ip=192.168.1.254',
    'netconf.2.role=lan',
    'netconf.2.flowcontrol.tx.status=enabled',
    'netconf.2.flowcontrol.rx.status=enabled',
    'netconf.2.autoneg=enabled',
    'netconf.2.mtu=1500',
    'netconf.2.autoip.status=disabled',
    'netconf.2.up=enabled',
    'netconf.2.devname=eth0',
    'netconf.2.status=enabled',
    'netconf.1.mtu=1500',
    'netconf.1.autoip.status=disabled',
    'netconf.1.up=enabled',
    'netconf.1.devname=ath0',
    'netconf.1.status=enabled',
    'netconf.status=enabled',
    'resolv.nameserver.status=enabled',
    'resolv.host.1.status=enabled',
    'resolv.host.1.name=${DEVICE_NAME}',
    'sshd.port=22',
    'sshd.auth.passwd=enabled',
    'sshd.status=enabled',
    'pppoe-relay.status=disabled',
    'ebtables.sys.eap.1.devname=ath0',
    'ebtables.sys.eap.1.status=enabled',
    'ebtables.sys.eap.status=enabled',
    'ebtables.sys.status=enabled',
    'ebtables.status=enabled',
    'wpasupplicant.status=enabled',
    'wpasupplicant.profile.1.network.2.status=disabled',
    'wpasupplicant.profile.1.network.2.priority=2',
    'wpasupplicant.profile.1.network.2.key_mgmt.1.name=NONE',
    'wpasupplicant.profile.1.network.1.ssid=${SSID}',
    'wpasupplicant.profile.1.network.1.psk=${WPA2_PSK}',
    'wpasupplicant.profile.1.network.1.proto.1.name=RSN',
    'wpasupplicant.profile.1.network.1.priority=100',
    'wpasupplicant.profile.1.network.1.pairwise.1.name=CCMP',
    'wpasupplicant.profile.1.network.1.key_mgmt.1.name=WPA-PSK',
    'wpasupplicant.profile.1.network.1.eap.1.status=disabled',
    'wpasupplicant.profile.1.name=AUTO',
    'wpasupplicant.device.1.status=enabled',
    'wpasupplicant.device.1.profile=AUTO',
    'wpasupplicant.device.1.devname=ath0',
    'wireless.1.wds.status=enabled',
    'wireless.1.status=enabled',
    'wireless.1.ssid=${SSID}',
    'wireless.1.signal_led_status=enabled',
    'wireless.1.signal_led4=65',
    'wireless.1.signal_led3=73',
    'wireless.1.signal_led2=80',
    'wireless.1.signal_led1=94',
    'wireless.1.security.type=none',
    'wireless.1.rate.mcs=-1',
    'wireless.1.rate.auto=enabled',
    'wireless.1.mcast.enhance=0',
    'wireless.1.mac_acl.status=disabled',
    'wireless.1.mac_acl.policy=allow',
    'wireless.1.l2_isolation=disabled',
    'wireless.1.hide_ssid=disabled',
    'wireless.1.devname=ath0',
    'wireless.1.amsdu=3',
    'wireless.1.ampdu.status=enabled',
    'wireless.1.ampdu.frames=32',
    'wireless.1.addmtikie=enabled',
    'wireless.status=enabled',
    'users.2.uid=100',
    'users.2.status=disabled',
    'users.2.shell=/bin/false',
    'users.2.gid=100',
    'users.1.status=enabled',
    'users.1.name=${CPE_USERNAME}',
    'users.status=enabled',
    'update.check.status=disabled',
    'unms.uri=${UISP_ENROLLMENT}',
    'unms.unms_redirector=enabled',
    'unms.status=enabled',
    'telnetd.status=disabled',
    'telnetd.port=23',
    'system.timezone=UTC',
    'system.modules.blacklist.2.expr=ip_.*_ftp',
    'system.modules.blacklist.2.status=enabled',
    'system.modules.blacklist.1.expr=ip_.*_pptp',
    'system.modules.blacklist.1.status=enabled',
    'system.modules.blacklist.status=enabled',
    'system.leds.nightmode=disabled',
    'system.external.reset=enabled',
    'system.eirp.status=disabled',
    'system.date.status=disabled',
    'system.cfg.version=65547',
    'system.autosend_crash_reports=disabled',
    'system.airosx.prov.status=enabled',
    'syslog.status=enabled',
    'syslog.remote.status=disabled',
    'syslog.remote.port=514',
    'snmp.status=enabled',
    'snmp.location=${SNMP_LOCATION}',
    'snmp.contact=172.31.0.7',
    'snmp.community=${SNMP_COMMUNITY}',
    'radio.1.txpower=25',
    'radio.1.status=enabled',
    'radio.1.scanbw.status=enabled',
    'radio.1.scan_list.status=disabled',
    'radio.1.rx_sensitivity=-96',
    'radio.1.reg_obey=disabled',
    'radio.1.rc_mode=0',
    'radio.1.ptpmode=0',
    'radio.1.pollingpri=2',
    'radio.1.pollingnoack=0',
    'radio.1.polling_ff_sta_rx_rssi_th=0',
    'radio.1.polling_ff_flex=0',
    'radio.1.polling_ff_dur=0',
    'radio.1.polling_ff_dl_ratio=50',
    'radio.1.polling_11ac_11n_compat=0',
    'radio.1.polling=enabled',
    'radio.1.obey=disabled',
    'radio.1.mode=managed',
    'radio.1.low_txpower_mode=disabled',
    'radio.1.ieee_mode=auto',
    'radio.1.freq=0',
    'radio.1.ff_cap_rep=0',
    'radio.1.dfs.status=disabled',
    'radio.1.devname=ath0',
    'radio.1.cwm.mode=1',
    'radio.1.cwm.enable=0',
    'radio.1.countrycode=511',
    'radio.1.cmsbias=0',
    'radio.1.chanbw=0',
    'radio.1.center.1.freq=0',
    'radio.1.cable.loss=0',
    'radio.1.atpc.threshold=36',
    'radio.1.atpc.status=disabled',
    'radio.1.atpc.sta.status=enabled',
    'radio.1.antenna.id=1',
    `radio.1.antenna.gain=${gain}`,
    'radio.1.acktimeout=35',
    'radio.1.ackdistance=643',
    'radio.1.ack.auto=enabled',
    'radio.status=enabled',
    'radio.countrycode=511',
    'pwdog.status=enabled',
    'pwdog.retry=3',
    'pwdog.period=300',
    'pwdog.host=8.8.8.8',
    'pwdog.delay=300',
    'pwdog.command=/bin/support /tmp/emerg /etc/persistent/emerg.supp emerg 0; reboot -f',
    'ntpclient.1.status=enabled',
    'ntpclient.1.server=10.0.0.254',
    'ntpclient.status=enabled',
    'netmode=router',
    'mac-telnetd.status=disabled',
    'httpd.status=enabled',
    'httpd.session.timeout=900',
    `httpd.port=${MANAGEMENT_PORTS.http}`,
    'httpd.https.status=enabled',
    `httpd.https.port=${MANAGEMENT_PORTS.https}`,
    'gui.network.advanced.status=disabled',
    'gui.language=en_US',
    'dyndns.status=disabled',
    'discovery.status=enabled',
    'discovery.cdp.status=enabled',
    'airview.status=enabled',
    'aaa.1.status=disabled',
    'aaa.1.radius.auth.1.port=1812',
    'aaa.1.radius.acct.1.status=disabled',
    'aaa.1.radius.acct.1.port=1813',
    'aaa.status=disabled',
    'users.1.password=${CPE_PASSWORD_HASH}',
  ].join('\n')}\n`;
}

/** What the rest of the server needs to know of a template (where the CPE answers after it). */
/** The SSID a configuration connects to (Station) or transmits (AP); null when typed for each CPE. */
export function templateSsid(text: string): string | null {
  const v = ssidOf(parseKeys(text));
  return v === undefined || isPlaceholder(v) ? null : v;
}

export function templateFacts(text: string) {
  const c = parseKeys(text);
  const lan = lanKey(c, 'ip');
  const ip = lan ? c.get(lan) : undefined;
  return {
    lanIp: ip && !isPlaceholder(ip) ? ip : null,
    sshPort: num(c.get('sshd.port')) ?? 22,
    httpPort: num(c.get('httpd.port')) ?? MANAGEMENT_PORTS.http,
    httpsPort: num(c.get('httpd.https.port')) ?? MANAGEMENT_PORTS.https,
    wirelessMode: c.get('radio.1.mode') === 'master' ? 'ap' : 'station',
    netMode: c.get('netmode') === 'bridge' ? 'bridge' : 'router',
    ptp: c.get('radio.1.ptpmode') === '1',
  };
}
