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
  /**
   * Until v1.35.10 the same for every CPE; now each airOS template has its own value. Still applied
   * at start (the conversion of the old templates copies it into them), no longer shown or editable.
   */
  retired?: true;
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
    retired: true, key: 'cpe.uispEnrollment', env: 'UISP_ENROLLMENT', group: 'Credenziali delle CPE', label: 'Chiave di adozione UISP', kind: 'secret',
    help: 'La "UISP key" (wss://…) scritta nelle CPE per farle comparire in UISP.',
    get: (c) => c.cpeSecrets.uispEnrollment, set: (c, v) => (c.cpeSecrets.uispEnrollment = v as string | undefined),
  },
  {
    retired: true, key: 'cpe.snmpCommunity', env: 'SNMP_COMMUNITY', group: 'Credenziali delle CPE', label: 'Community SNMP delle CPE', kind: 'secret',
    get: (c) => c.cpeSecrets.snmpCommunity, set: (c, v) => (c.cpeSecrets.snmpCommunity = (v as string | undefined) ?? 'public'),
  },
  {
    retired: true, key: 'cpe.snmpContact', env: 'SNMP_CONTACT', group: 'Credenziali delle CPE', label: 'Contatto SNMP (sysContact)', kind: 'text',
    get: (c) => c.cpeSecrets.snmpContact, set: (c, v) => (c.cpeSecrets.snmpContact = (v as string | undefined) ?? ''),
  },
  { ...ip('factoryIp', 'CPE_FACTORY_IP', 'IP di fabbrica / management della CPE'), group: 'Credenziali delle CPE' },
  { ...ip('lanIp', 'CPE_LAN_IP', 'IP LAN della CPE'), retired: true },
  { ...ip('lanNetmask', 'CPE_LAN_NETMASK', 'Netmask LAN'), retired: true },
  { ...ip('dhcpStart', 'CPE_DHCP_START', 'DHCP: primo indirizzo'), retired: true },
  { ...ip('dhcpEnd', 'CPE_DHCP_END', 'DHCP: ultimo indirizzo'), retired: true },
  { ...netInt('dhcpLease', 'CPE_DHCP_LEASE', 'DHCP: durata lease (s)', 60, 86400), retired: true },
  { ...netInt('pppoeMtu', 'CPE_PPPOE_MTU', 'PPPoE MTU', 576, 1500), retired: true },
  { ...netInt('pppoeMru', 'CPE_PPPOE_MRU', 'PPPoE MRU', 576, 1500), retired: true },
  {
    retired: true, key: 'network.watchdogHost', env: 'CPE_WATCHDOG_HOST', group: 'Rete standard delle CPE', label: 'Host del watchdog (ping)', kind: 'text',
    get: (c) => c.network.watchdogHost, set: (c, v) => (c.network.watchdogHost = (v as string | undefined) ?? '8.8.8.8'),
  },
  {
    retired: true, key: 'network.ntpServer', env: 'CPE_NTP_SERVER', group: 'Rete standard delle CPE', label: 'Server NTP', kind: 'text',
    get: (c) => c.network.ntpServer, set: (c, v) => (c.network.ntpServer = (v as string | undefined) ?? '10.0.0.254'),
  },
  { ...netInt('sshPort', 'CPE_SSH_PORT', 'Porta SSH della CPE', 1, 65535), retired: true },
  { ...netInt('discoveryPort', 'CPE_DISCOVERY_PORT', 'Porta discovery Ubiquiti', 1, 65535), retired: true },
  {
    key: 'jobTtlMinutes', env: 'PROVISION_JOB_TTL_MINUTES', group: 'Provisioning e app', label: 'Validità di un provisioning (minuti)', kind: 'int', min: 5, max: 2880,
    help: 'Per quanto tempo la configurazione preparata resta valida sul telefono: anche 48 ore (2880) per salire sul tetto senza Internet.',
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
    key: 'offlineSessionHours', env: 'OFFLINE_SESSION_HOURS', group: 'Provisioning e app', label: 'Sessione dell’app senza Internet (ore, 0 = mai)', kind: 'int', min: 0, max: 72,
    help: 'Dopo l’ultimo contatto con il server l’app resta utilizzabile per questo tempo anche se viene chiusa, il telefono si spegne o manca Internet: strumenti sulla CPE (verifica, puntamento, collaudo) con le credenziali salvate cifrate sul telefono. Torna online e si ricollega da sola; un account bloccato o disconnesso dal server perde l’accesso al primo contatto.',
    get: (c) => c.offlineSessionHours, set: (c, v) => (c.offlineSessionHours = (v as number | undefined) ?? 24),
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
    key: 'firmwareBypass', env: 'FIRMWARE_BYPASS', group: 'Provisioning e app', label: 'Provisioning con firmware diverso dopo 2 aggiornamenti non riusciti', kind: 'bool',
    help: 'Se l’app non riesce ad aggiornare il firmware della CPE per 2 volte, l’installatore può scrivere comunque la configurazione con il firmware che ha la CPE; resta annotato nell’esito.',
    get: (c) => c.firmwareBypass, set: (c, v) => (c.firmwareBypass = v === undefined ? true : !!v),
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
    key: 'speedtest.server', env: 'SPEEDTEST_SERVER', group: 'Collaudo: speedtest e Wi-Fi', label: 'Server di speedtest (host:porta)', kind: 'text',
    help: 'Il server Ookla (OoklaServer) contro cui l’app misura la velocità, nel collaudo, negli interventi e tra gli strumenti di rete: per esempio speedtest.cda-net.it:8080. Il test si fa solo dalla Wi-Fi del router del cliente, mai con i dati mobili.',
    get: (c) => c.speedtest.server, set: (c, v) => (c.speedtest.server = (v as string | undefined) ?? 'speedtest.cda-net.it:8080'),
  },
  {
    key: 'speedtest.minPct', env: 'SPEEDTEST_MIN_PCT', group: 'Collaudo: speedtest e Wi-Fi', label: 'Velocità minima rispetto al profilo del cliente (%)', kind: 'int', min: 10, max: 100,
    help: 'Lo speedtest passa se download e upload arrivano almeno a questa percentuale del profilo PPPoE del cliente (per esempio 80% di 30/5 = 24/4 Mbit/s). Sotto, l’app non segna subito un’anomalia: indica all’installatore cosa controllare (puntamento, altri dispositivi sul router, canale Wi-Fi) e fa ripetere il test.',
    get: (c) => c.speedtest.minPct, set: (c, v) => (c.speedtest.minPct = (v as number | undefined) ?? 80),
  },
  {
    key: 'speedtest.wifiWarnDbm', env: 'WIFI_WARN_DBM', group: 'Collaudo: speedtest e Wi-Fi', label: 'Segnale Wi-Fi del telefono: avviso sotto (dBm)', kind: 'int', min: -90, max: -30,
    help: 'Segnale del telefono verso il router del cliente. Sotto questo valore lo speedtest parte, con l’avviso che il risultato può dipendere dalla Wi-Fi.',
    get: (c) => c.speedtest.wifiWarnDbm, set: (c, v) => (c.speedtest.wifiWarnDbm = (v as number | undefined) ?? -65),
  },
  {
    key: 'speedtest.wifiBlockDbm', env: 'WIFI_BLOCK_DBM', group: 'Collaudo: speedtest e Wi-Fi', label: 'Segnale Wi-Fi del telefono: test bloccato sotto (dBm)', kind: 'int', min: -95, max: -30,
    help: 'Sotto questo valore l’app non fa partire lo speedtest e chiede all’installatore di avvicinarsi al router: misurerebbe la Wi-Fi, non la linea.',
    get: (c) => c.speedtest.wifiBlockDbm, set: (c, v) => (c.speedtest.wifiBlockDbm = (v as number | undefined) ?? -70),
  },
  {
    key: 'speedtest.seconds', env: 'SPEEDTEST_SECONDS', group: 'Collaudo: speedtest e Wi-Fi', label: 'Durata dello speedtest per verso (secondi)', kind: 'int', min: 5, max: 30,
    get: (c) => c.speedtest.seconds, set: (c, v) => (c.speedtest.seconds = (v as number | undefined) ?? 10),
  },
  {
    key: 'speedtest.streams', env: 'SPEEDTEST_STREAMS', group: 'Collaudo: speedtest e Wi-Fi', label: 'Connessioni in parallelo dello speedtest', kind: 'int', min: 1, max: 16,
    get: (c) => c.speedtest.streams, set: (c, v) => (c.speedtest.streams = (v as number | undefined) ?? 4),
  },
  {
    key: 'proactive.apBusyPct', env: 'PROACTIVE_AP_BUSY_PCT', group: 'Avvisi proattivi', label: 'AP vicino alla saturazione da (% la sera)', kind: 'int', min: 50, max: 100,
    help: 'Il NOC riceve un avviso (al massimo una volta a settimana per AP) quando l’airtime o l’occupazione del canale di un AP, all’ora di punta della sera, arriva a questa percentuale.',
    get: (c) => c.proactive.apBusyPct, set: (c, v) => (c.proactive.apBusyPct = (v as number | undefined) ?? 80),
  },
  {
    key: 'proactive.popLowHours', env: 'PROACTIVE_POP_LOW_HOURS', group: 'Avvisi proattivi', label: 'POP a batteria: avviso sotto (ore di autonomia)', kind: 'int', min: 1, max: 24,
    help: 'Quando un POP va a batteria il NOC riceve l’autonomia stimata (da quanto scende la carica); un secondo avviso quando ne restano meno di queste ore, e uno quando torna in carica. Il calo di segnale delle CPE usa la soglia «Calo di segnale rispetto al collaudo».',
    get: (c) => c.proactive.popLowHours, set: (c, v) => (c.proactive.popLowHours = (v as number | undefined) ?? 2),
  },
  {
    key: 'warehouseMinStock', env: 'WAREHOUSE_MIN_STOCK', group: 'Magazzino', label: 'CPE minime nel magazzino di un installatore', kind: 'int', min: 0, max: 50,
    help: 'Sotto questo numero il NOC riceve l’avviso di rifornire l’installatore (una volta, quando ci scende) e la pagina Magazzino lo segnala. Ogni account può avere il suo minimo (Account → Magazzino). 0 = nessun avviso.',
    get: (c) => c.warehouseMinStock, set: (c, v) => (c.warehouseMinStock = (v as number | undefined) ?? 2),
  },
  {
    key: 'coverageOps.cacheDays', env: 'COVERAGE_OPS_CACHE_DAYS', group: 'Copertura altri operatori', label: 'Riusa una verifica per (giorni)', kind: 'int', min: 1, max: 90,
    help: 'La copertura degli altri operatori (fibra, FTTC, FWA) di un punto viene richiesta al servizio esterno una volta e poi riusata per questi giorni: meno richieste e risposte immediate. «Rileggi» la aggiorna subito.',
    get: (c) => c.coverageOps.cacheDays, set: (c, v) => (c.coverageOps.cacheDays = (v as number | undefined) ?? 7),
  },
  {
    key: 'coverageOps.fwaMinMbps', env: 'COVERAGE_OPS_FWA_MIN_MBPS', group: 'Copertura altri operatori', label: 'FWA con bollino FR da (Mbit/s)', kind: 'int', min: 1, max: 1000,
    help: 'Bollino AGCOM delle reti radio (FWA): da questa velocità in su «FR» giallo (misto fibra-radio), sotto «R» rosso. La delibera fissa la soglia a 30 Mbit/s.',
    get: (c) => c.coverageOps.fwaMinMbps, set: (c, v) => (c.coverageOps.fwaMinMbps = (v as number | undefined) ?? 30),
  },
  {
    key: 'coverageOps.vhcnTechs', env: 'COVERAGE_OPS_VHCN_TECHS', group: 'Copertura altri operatori', label: 'Tecnologie FWA con bollino blu VHCN', kind: 'text',
    help: 'Codici delle tecnologie radio con il bollino blu «FWA VHCN», separati da virgola. Predefinite: WIRELESS_28 (radio a 28 GHz) e WIRELESS_P2P (radio punto-punto). Le altre reti radio restano FR o R secondo la velocità.',
    get: (c) => c.coverageOps.vhcnTechs, set: (c, v) => (c.coverageOps.vhcnTechs = (v as string | undefined) ?? 'WIRELESS_28,WIRELESS_P2P'),
  },
  {
    key: 'coverageHideBelowDbm', env: 'COVERAGE_HIDE_BELOW_DBM', group: 'Copertura per gli installatori', label: 'Nascondi gli AP con segnale stimato più debole di (dBm)', kind: 'int', min: -100, max: -40,
    help: 'In ogni verifica di copertura (console e app, installatori e amministratori) gli AP con un segnale stimato più debole di questo valore non vengono elencati: la risposta dice quanti ne sono stati nascosti. Gli AP senza una stima restano. −100 = mostra tutti.',
    get: (c) => c.coverageHideBelowDbm, set: (c, v) => (c.coverageHideBelowDbm = (v as number | undefined) ?? -70),
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
    key: 'advisorFreqRange', env: 'ADVISOR_FREQ_RANGE', group: 'Assistente rete', label: 'Frequenze utilizzabili per i suggerimenti di canale (MHz, da-a)', kind: 'text',
    help: 'L’assistente propone canali solo dentro questo intervallo, con il canale intero dentro (bordi compresi): predefinito 5120-5800. I canali dei nostri AP vicini sono sempre evitati, e un canale che porterebbe il cliente più debole sotto il minimo del collaudo viene scartato (risposta in frequenza delle antenne e perdita di percorso).',
    get: (c) => c.advisorFreqRange, set: (c, v) => (c.advisorFreqRange = /^\s*\d{4}\s*-\s*\d{4}\s*$/.test(String(v ?? '')) ? String(v) : '5120-5800'),
  },
  {
    key: 'advisorAutoOptimize', env: 'ADVISOR_AUTO_OPTIMIZE', group: 'Assistente rete', label: 'Ottimizzazione automatica degli AP tramite UISP', kind: 'bool',
    help: 'Permette agli amministratori di far provare all’IA-AP il canale consigliato (o i migliori dello spettro) su un AP: cambia il canale tramite UISP, aspetta che tutte le CPE si riaggancino, confronta i collegamenti e tiene il canale solo se è davvero migliore, altrimenti torna a quello iniziale. Un AP alla volta, sempre dopo la conferma di un amministratore. Spento = l’assistente dà solo consigli.',
    get: (c) => c.advisorAutoOptimize, set: (c, v) => (c.advisorAutoOptimize = !!v),
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
      settings: SERVER_SETTINGS.filter((d) => !d.retired).map((d) => {
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
      if (!d || d.retired) throw Object.assign(new Error(`unknown setting ${k}`), { code: 'unknown_setting' });
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
