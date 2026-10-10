import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * Server parameters editable from the admin console ("Impostazioni server") instead of the .env
 * file: value set from the web > value in .env > default. Secrets are sealed with the master key
 * and never returned. Most values apply at once (they are read at use); a few need an app restart.
 */

type Kind = 'text' | 'secret' | 'int' | 'ip' | 'bool' | 'url' | 'version';

interface Def {
  key: string;
  env: string;
  group: string;
  label: string;
  help?: string;
  kind: Kind;
  min?: number;
  max?: number;
  restart?: boolean;
  get: (c: Config) => string | number | boolean | undefined;
  set: (c: Config, v: string | number | boolean | undefined) => void;
}

const ip = (key: keyof Config['network'], env: string, label: string, help?: string): Def => ({
  key: `network.${key}`,
  env,
  group: 'Rete standard delle CPE',
  label,
  ...(help ? { help } : {}),
  kind: 'ip',
  get: (c) => c.network[key],
  set: (c, v) => ((c.network as Record<string, unknown>)[key] = v),
});
const netInt = (key: keyof Config['network'], env: string, label: string, min: number, max: number): Def => ({
  key: `network.${key}`,
  env,
  group: 'Rete standard delle CPE',
  label,
  kind: 'int',
  min,
  max,
  get: (c) => c.network[key],
  set: (c, v) => ((c.network as Record<string, unknown>)[key] = v),
});

const threshold = (key: keyof Config['thresholds'], env: string, label: string, min: number, max: number, help?: string): Def => ({
  key: `thresholds.${key}`,
  env,
  group: 'Soglie di collaudo e salute CPE',
  label,
  ...(help ? { help } : {}),
  kind: 'int',
  min,
  max,
  get: (c) => c.thresholds[key],
  set: (c, v) => (c.thresholds[key] = v as number),
});

export const SERVER_SETTINGS: Def[] = [
  {
    key: 'cpe.adminUsername', env: 'CPE_ADMIN_USERNAME', group: 'Credenziali delle CPE', label: 'Utente amministratore CPE', kind: 'text',
    help: 'Scritto in ogni CPE dal provisioning e usato dagli strumenti di campo (puntamento, diagnosi, collaudo).',
    get: (c) => c.cpeSecrets.adminUsername, set: (c, v) => (c.cpeSecrets.adminUsername = (v as string | undefined) ?? 'ubnt'),
  },
  {
    key: 'cpe.adminPassword', env: 'CPE_ADMIN_PASSWORD', group: 'Credenziali delle CPE', label: 'Password amministratore CPE', kind: 'secret',
    help: 'Vale per le CPE configurate da ora in poi; quelle già installate mantengono la password con cui sono state configurate.',
    get: (c) => c.cpeSecrets.adminPassword, set: (c, v) => (c.cpeSecrets.adminPassword = v as string | undefined),
  },
  {
    key: 'cpe.uispEnrollment', env: 'UISP_ENROLLMENT', group: 'Credenziali delle CPE', label: 'Chiave di adozione UISP', kind: 'secret',
    help: 'La "UISP key" (wss://…) scritta nelle CPE per farle comparire in UISP.',
    get: (c) => c.cpeSecrets.uispEnrollment, set: (c, v) => (c.cpeSecrets.uispEnrollment = v as string | undefined),
  },
  {
    key: 'cpe.snmpCommunity', env: 'SNMP_COMMUNITY', group: 'Credenziali delle CPE', label: 'Community SNMP delle CPE', kind: 'secret',
    get: (c) => c.cpeSecrets.snmpCommunity, set: (c, v) => (c.cpeSecrets.snmpCommunity = (v as string | undefined) ?? 'public'),
  },
  {
    key: 'cpe.snmpContact', env: 'SNMP_CONTACT', group: 'Credenziali delle CPE', label: 'Contatto SNMP (sysContact)', kind: 'text',
    get: (c) => c.cpeSecrets.snmpContact, set: (c, v) => (c.cpeSecrets.snmpContact = (v as string | undefined) ?? ''),
  },
  ip('factoryIp', 'CPE_FACTORY_IP', 'IP di fabbrica / management della CPE'),
  ip('lanIp', 'CPE_LAN_IP', 'IP LAN della CPE'),
  ip('lanNetmask', 'CPE_LAN_NETMASK', 'Netmask LAN'),
  ip('dhcpStart', 'CPE_DHCP_START', 'DHCP: primo indirizzo'),
  ip('dhcpEnd', 'CPE_DHCP_END', 'DHCP: ultimo indirizzo'),
  netInt('dhcpLease', 'CPE_DHCP_LEASE', 'DHCP: durata lease (s)', 60, 86400),
  netInt('pppoeMtu', 'CPE_PPPOE_MTU', 'PPPoE MTU', 576, 1500),
  netInt('pppoeMru', 'CPE_PPPOE_MRU', 'PPPoE MRU', 576, 1500),
  {
    key: 'network.watchdogHost', env: 'CPE_WATCHDOG_HOST', group: 'Rete standard delle CPE', label: 'Host del watchdog (ping)', kind: 'text',
    get: (c) => c.network.watchdogHost, set: (c, v) => (c.network.watchdogHost = (v as string | undefined) ?? '8.8.8.8'),
  },
  {
    key: 'network.ntpServer', env: 'CPE_NTP_SERVER', group: 'Rete standard delle CPE', label: 'Server NTP', kind: 'text',
    get: (c) => c.network.ntpServer, set: (c, v) => (c.network.ntpServer = (v as string | undefined) ?? '10.0.0.254'),
  },
  netInt('sshPort', 'CPE_SSH_PORT', 'Porta SSH della CPE', 1, 65535),
  netInt('discoveryPort', 'CPE_DISCOVERY_PORT', 'Porta discovery Ubiquiti', 1, 65535),
  {
    key: 'jobTtlMinutes', env: 'PROVISION_JOB_TTL_MINUTES', group: 'Provisioning e app', label: 'Validità di un provisioning (minuti)', kind: 'int', min: 5, max: 240,
    get: (c) => c.jobTtlMinutes, set: (c, v) => (c.jobTtlMinutes = v as number),
  },
  {
    key: 'minAndroidVersion', env: 'MIN_ANDROID_VERSION', group: 'Provisioning e app', label: 'Versione minima dell’app Android', kind: 'version',
    help: 'Le app più vecchie devono aggiornarsi prima di fare provisioning o usare gli strumenti di campo.',
    get: (c) => c.minAndroidVersion, set: (c, v) => (c.minAndroidVersion = (v as string | undefined) ?? '1.0.0'),
  },
  {
    key: 'appForceLatest', env: 'APP_FORCE_LATEST', group: 'Provisioning e app', label: 'App sempre all’ultima versione (aggiornamento obbligatorio)', kind: 'bool',
    help: 'Appena esce una nuova versione, l’app la scarica e non permette login né uso finché non è installata.',
    get: (c) => c.appForceLatest, set: (c, v) => (c.appForceLatest = v === undefined ? true : !!v),
  },
  {
    key: 'jwtTtlHours', env: 'JWT_TTL_HOURS', group: 'Provisioning e app', label: 'Durata delle sessioni (ore)', kind: 'int', min: 1, max: 72, restart: true,
    get: (c) => c.jwtTtlHours, set: (c, v) => (c.jwtTtlHours = v as number),
  },
  {
    key: 'auditRetentionDays', env: 'GDPR_AUDIT_RETENTION_DAYS', group: 'Provisioning e app', label: 'Conservazione dello storico e del registro (giorni)', kind: 'int', min: 1, max: 3650,
    get: (c) => c.auditRetentionDays, set: (c, v) => (c.auditRetentionDays = v as number),
  },
  {
    key: 'publicUrl', env: 'PUBLIC_URL', group: 'Provisioning e app', label: 'Indirizzo pubblico della console', kind: 'url',
    help: 'Es. https://cpe.cda-net.it: usato per i link nei messaggi Telegram.',
    get: (c) => c.publicUrl, set: (c, v) => (c.publicUrl = (v as string | undefined)?.replace(/\/+$/, '')),
  },
  {
    key: 'routerOsAllowPublic', env: 'ROUTEROS_ALLOW_PUBLIC', group: 'Provisioning e app', label: 'RouterOS: consenti indirizzi pubblici', kind: 'bool',
    get: (c) => c.routerOsAllowPublic, set: (c, v) => (c.routerOsAllowPublic = !!v),
  },
  threshold('signalGood', 'SIGNAL_GOOD_DBM', 'Segnale buono (dBm)', -90, -40, 'Sopra questo valore il segnale della CPE è "ottimo" in diagnosi e collaudo.'),
  threshold('signalMin', 'SIGNAL_MIN_DBM', 'Segnale minimo accettato (dBm)', -95, -45, 'Sotto: collaudo da approvare dal NOC, "segnale debole" in Salute CPE, AP "improbabili" in Copertura.'),
  threshold('cinrMin', 'CINR_MIN_DB', 'CINR minimo (dB)', 0, 40, 'Sotto indica interferenze o un puntamento impreciso.'),
  threshold('chainDelta', 'CHAIN_DELTA_DB', 'Differenza massima tra le catene (dB)', 1, 30, 'Oltre suggerisce un problema di polarizzazione o un ostacolo.'),
  threshold('capacityMinMbps', 'CAPACITY_MIN_MBPS', 'Capacità airMAX minima (Mbit/s, download)', 1, 2000),
  threshold('ethMinMbps', 'ETH_MIN_MBPS', 'Velocità minima della porta LAN (Mbit/s)', 10, 1000, 'Sotto (o in half duplex) il cavo o il connettore è da controllare.'),
  threshold('signalDropDb', 'SIGNAL_DROP_DB', 'Calo di segnale rispetto al collaudo (dB)', 1, 30, 'Salute CPE: "segnale calato" se il segnale è sceso almeno di tanto.'),
  {
    key: 'staleCpeMonths', env: 'STALE_CPE_MONTHS', group: 'Soglie di collaudo e salute CPE', label: 'Nascondi le CPE offline da più di (mesi, 0 = mai)', kind: 'int', min: 0, max: 120,
    help: 'CPE di clienti spariti da tempo ma ancora in UISP: non compaiono in Salute CPE (si possono mostrare con un pulsante) e non contano tra le CPE offline degli AP in Stato rete, così un AP non risulta "con molte CPE offline" per vecchi clienti. In UISP non viene cancellato nulla.',
    get: (c) => c.staleCpeMonths, set: (c, v) => (c.staleCpeMonths = (v as number | undefined) ?? 12),
  },
  {
    key: 'installerCoverageAps', env: 'INSTALLER_COVERAGE_APS', group: 'Copertura per gli installatori', label: 'AP mostrati per ogni verifica di copertura', kind: 'int', min: 1, max: 20,
    help: 'Il server valuta tutti gli AP assegnati all’installatore entro il raggio di copertura (Connettori → UISP), li ordina per segnale stimato e mostra i primi di questo numero; esclude gli AP non attivi o troppo deboli. Vale per la console web e per l’app (Copertura, AP vicini); gli amministratori scelgono ogni volta.',
    get: (c) => c.installerCoverageAps, set: (c, v) => (c.installerCoverageAps = (v as number | undefined) ?? 5),
  },
  {
    key: 'installerDistanceStepM', env: 'INSTALLER_DISTANCE_STEP_M', group: 'Copertura per gli installatori', label: 'Arrotondamento delle distanze mostrate agli installatori (m)', kind: 'int', min: 10, max: 2000,
    help: 'Gli installatori non vedono le coordinate di POP e AP, solo un’area approssimativa sulla mappa. Per puntare ricevono però la direzione esatta dalla loro posizione: con una distanza precisa potrebbero risalire al punto esatto dell’AP. Questo valore arrotonda le distanze che vedono (Copertura, AP vicini, Visibilità, Guasti Enel): con 50 m l’AP si individua entro circa 50 m, con 500 m entro qualche centinaio di metri. Puntamento, tilt e visibilità non peggiorano: li calcola il server con i dati esatti. Gli amministratori vedono sempre le distanze esatte.',
    get: (c) => c.installerDistanceStepM, set: (c, v) => (c.installerDistanceStepM = (v as number | undefined) ?? 50),
  },
  {
    key: 'coverageEirpDbm', env: 'COVERAGE_AP_EIRP_DBM', group: 'Simulazione radio', label: 'Potenza irradiata dagli AP (EIRP, dBm)', kind: 'int', min: 10, max: 60,
    help: 'Base della stima di copertura (Copertura, AP vicini, simulazione): spazio libero da questa potenza, poi terreno e antenna. Non serve che sia esatto: il server confronta la teoria con il segnale reale di tutti i clienti e si corregge da solo (calibrazione di rete, mostrata nella simulazione: se resta lontana da 0 dB, sposta qui la differenza). Predefinito 30 dBm (limite della banda libera 5,47–5,725 GHz); con frequenze in licenza e firmware sbloccato è più alto.',
    get: (c) => c.coverageEirpDbm, set: (c, v) => (c.coverageEirpDbm = (v as number | undefined) ?? 30),
  },
  {
    key: 'coverageCpeGainDbi', env: 'COVERAGE_CPE_GAIN_DBI', group: 'Simulazione radio', label: 'Guadagno dell’antenna della CPE (dBi)', kind: 'int', min: 0, max: 40,
    help: 'La CPE tipica dei clienti: LiteBeam 5AC Gen2 23 dBi, NanoStation 5AC 16 dBi, PowerBeam 5AC 25 dBi.',
    get: (c) => c.coverageCpeGainDbi, set: (c, v) => (c.coverageCpeGainDbi = (v as number | undefined) ?? 23),
  },
  {
    key: 'coverageBuildingM', env: 'COVERAGE_BUILDING_HEIGHT_M', group: 'Simulazione radio', label: 'Altezza media degli edifici (m)', kind: 'int', min: 0, max: 60,
    help: 'Dove la mappa del suolo (ESA WorldCover) indica edifici, il profilo verso l’AP si alza di questa altezza: un paese tra la CPE e l’AP può fare ombra. Gli edifici entro 50 m dalla CPE e dall’AP non contano (l’antenna è sopra il tetto). 0 = edifici ignorati.',
    get: (c) => c.coverageBuildingM, set: (c, v) => (c.coverageBuildingM = (v as number | undefined) ?? 8),
  },
  {
    key: 'coverageTreeM', env: 'COVERAGE_TREE_HEIGHT_M', group: 'Simulazione radio', label: 'Altezza media della vegetazione (m)', kind: 'int', min: 0, max: 40,
    help: 'Dove la mappa del suolo indica alberi: il tratto di linea di vista che attraversa le chiome attenua il segnale (fogliame a 5 GHz, ITU-R P.833, fino a 20 dB). Uliveti e agrumeti 5–8 m, boschi 10–20 m. 0 = vegetazione ignorata.',
    get: (c) => c.coverageTreeM, set: (c, v) => (c.coverageTreeM = (v as number | undefined) ?? 8),
  },
  {
    key: 'releases.githubRepo', env: 'ANDROID_RELEASE_GITHUB_REPO', group: 'Rilasci dell’app Android', label: 'Repository GitHub dei rilasci (owner/repo)', kind: 'text', restart: true,
    get: (c) => c.releases.githubRepo, set: (c, v) => (c.releases.githubRepo = v as string | undefined),
  },
  {
    key: 'releases.githubToken', env: 'ANDROID_RELEASE_GITHUB_TOKEN', group: 'Rilasci dell’app Android', label: 'Token GitHub (repository privato)', kind: 'secret', restart: true,
    get: (c) => c.releases.githubToken, set: (c, v) => (c.releases.githubToken = v as string | undefined),
  },
  {
    key: 'releases.syncMinutes', env: 'ANDROID_RELEASE_SYNC_MINUTES', group: 'Rilasci dell’app Android', label: 'Controllo nuovi APK ogni (minuti, 0 = mai)', kind: 'int', min: 0, max: 1440, restart: true,
    get: (c) => c.releases.syncMinutes, set: (c, v) => (c.releases.syncMinutes = v as number),
  },
];

const KEY = 'server.settings';

function schemaOf(d: Def) {
  switch (d.kind) {
    case 'int': return z.number().int().min(d.min ?? 0).max(d.max ?? 1_000_000);
    case 'bool': return z.boolean();
    case 'ip': return z.string().regex(/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/, 'indirizzo IPv4 non valido');
    case 'url': return z.string().url().max(300);
    case 'version': return z.string().regex(/^\d+\.\d+\.\d+$/, 'formato x.y.z');
    case 'secret': return z.string().min(1).max(4096).refine((v) => !/[\r\n\0]/.test(v), 'una sola riga');
    default: return z.string().trim().min(1).max(300).refine((v) => !/[\r\n\0]/.test(v), 'una sola riga');
  }
}

export function createServerSettings(db: Db, cfg: Config, sealer: Sealer) {
  // values from .env/defaults, captured once: "ripristina" goes back to them
  const baseline = new Map(SERVER_SETTINGS.map((d) => [d.key, d.get(cfg)]));
  const byKey = new Map(SERVER_SETTINGS.map((d) => [d.key, d]));

  const read = (): { values: Record<string, unknown>; updatedAt: string | null; updatedBy: string | null } => {
    const r = db
      .prepare('SELECT s.value, s.updated_at, u.username FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?')
      .get(KEY) as { value: string; updated_at: string; username: string | null } | undefined;
    return r ? { values: JSON.parse(r.value) as Record<string, unknown>, updatedAt: r.updated_at, updatedBy: r.username } : { values: {}, updatedAt: null, updatedBy: null };
  };

  /** Stored value → runtime value (secrets are sealed). */
  const decode = (d: Def, v: unknown) => (d.kind === 'secret' ? sealer.open(String(v)) : v);

  /** Applies the console values over .env; a value that cannot be read (e.g. master key changed) falls back to .env. */
  function applyAll() {
    const { values } = read();
    for (const d of SERVER_SETTINGS) {
      let v = baseline.get(d.key) as string | number | boolean | undefined;
      if (d.key in values) {
        try {
          v = decode(d, values[d.key]) as string | number | boolean;
        } catch {
          // unreadable secret: keep the .env value rather than failing the start-up
        }
      }
      d.set(cfg, v);
    }
  }

  function view() {
    const { values, updatedAt, updatedBy } = read();
    return {
      updatedAt,
      updatedBy,
      settings: SERVER_SETTINGS.map((d) => {
        const fromWeb = d.key in values;
        const envValue = baseline.get(d.key);
        const current = d.get(cfg);
        return {
          key: d.key,
          env: d.env,
          group: d.group,
          label: d.label,
          help: d.help ?? null,
          kind: d.kind,
          min: d.min ?? null,
          max: d.max ?? null,
          restart: !!d.restart,
          source: fromWeb ? 'web' : cfg.envProvided.includes(d.env) ? 'env' : 'default',
          // secrets: only whether they are set, never the value
          value: d.kind === 'secret' ? null : (current ?? null),
          isSet: current !== undefined && current !== '',
          envValue: d.kind === 'secret' ? null : (envValue ?? null),
        };
      }),
    };
  }

  /** Saves the given values (null = back to the .env/default value); returns the keys needing a restart. */
  function update(input: Record<string, unknown>, userId: number) {
    const { values } = read();
    const next = { ...values };
    const changed: string[] = [];
    for (const [k, v] of Object.entries(input)) {
      const d = byKey.get(k);
      if (!d) throw Object.assign(new Error(`unknown setting ${k}`), { code: 'unknown_setting' });
      if (v === null) {
        delete next[k];
      } else {
        const parsed = schemaOf(d).parse(v);
        next[k] = d.kind === 'secret' ? sealer.seal(String(parsed)) : parsed;
      }
      changed.push(k);
    }
    db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(KEY, JSON.stringify(next), nowIso(), userId);
    applyAll();
    return { changed, restart: changed.filter((k) => byKey.get(k)?.restart) };
  }

  return { applyAll, view, update };
}
export type ServerSettings = ReturnType<typeof createServerSettings>;
