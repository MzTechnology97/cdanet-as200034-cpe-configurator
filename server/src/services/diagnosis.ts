import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { distanceM } from '../domain/geo.ts';
import { parseMac } from '../domain/policy.ts';

/**
 * Remote diagnosis of a customer's line before sending a technician: the CPE (online, signal now,
 * at the acceptance test and over the month, how often it went off this week, the LAN cable), the
 * PPPoE account and session, the AP and its other CPEs, the power (Enel outages near the AP or the
 * customer, the POP's battery) and the last speedtest, turned into the probable cause with what to
 * do. The texts never name a data source: installers read them too.
 */

export type Level = 'bad' | 'warn' | 'info' | 'ok';
export interface Finding {
  level: Level;
  /** Short and stable, for the app and the tests. */
  code: string;
  title: string;
  detail: string;
  action: string;
}
export interface Facts {
  cpe: {
    found: boolean;
    online: boolean | null;
    signal: number | null;
    ethMbps: number | null;
    ethHalfDuplex: boolean;
    lastSeen: string | null;
    /** Times it went offline in the last 7 days, and for how long in all (minutes). */
    outagesWeek: number | null;
    offlineMinWeek: number | null;
  } | null;
  signal: { acceptance: number | null; monthAvg: number | null; trend: number | null };
  pppoe: { status: string; suspended: boolean; servicesSuspended: boolean; online: boolean | null } | null;
  ap: { name: string; online: boolean; cpeTotal: number; cpeOffline: number } | null;
  power: {
    nearAp: { place: string; kind: string } | null;
    nearCustomer: { place: string; distanceM: number } | null;
    popBattery: { soc: number | null; batteryState: string | null; status: string } | null;
  };
  speed: { downMbps: number | null; upMbps: number | null; passed: boolean | null; at: string } | null;
}

const ORDER: Record<Level, number> = { bad: 0, warn: 1, info: 2, ok: 3 };

/** The probable causes, worst first (pure). */
export function diagnose(f: Facts, t: { signalMin: number; signalDropDb: number; ethMinMbps: number }): Finding[] {
  const out: Finding[] = [];
  const add = (level: Level, code: string, title: string, detail: string, action: string) => out.push({ level, code, title, detail, action });

  if (f.pppoe && (f.pppoe.suspended || f.pppoe.servicesSuspended || /sospes/i.test(f.pppoe.status))) {
    add('bad', 'suspended', 'Cliente sospeso', 'L’abbonamento risulta sospeso: la linea non funziona per questo, non per un guasto.', 'Verificare la posizione amministrativa prima di mandare un tecnico.');
  }
  if (f.ap && !f.ap.online) {
    add('bad', 'ap_down', `AP ${f.ap.name} non raggiungibile`, 'Il problema è nella rete (AP o POP), non a casa del cliente.', 'Intervento sul POP/AP: non serve un’uscita dal cliente.');
  } else if (f.ap && f.ap.cpeTotal >= 3 && f.ap.cpeOffline / f.ap.cpeTotal >= 0.3) {
    add('bad', 'sector_down', `Molte CPE offline sull’AP ${f.ap.name}`, `${f.ap.cpeOffline} su ${f.ap.cpeTotal} non raggiungibili: probabile problema del settore.`, 'Controllare l’AP e il POP prima di uscire dal singolo cliente.');
  }
  if (f.power.nearAp) {
    const b = f.power.popBattery;
    const battery = b ? ` Batteria del POP ${b.soc != null ? `${Math.round(b.soc)}%` : 'presente'}${b.batteryState === 'discharging' ? ', in scarica' : ''}.` : '';
    // the cause only when the network is down: with AP and CPE working it is something to keep an eye on
    const apUp = !f.ap || f.ap.online;
    if (!apUp) add('bad', 'power_ap', 'Guasto Enel vicino al POP/AP', `${f.power.nearAp.place}.${battery}`, 'Attendere il ripristino della corrente o intervenire sul POP: non è un guasto del cliente.');
    else if (f.cpe?.online === false) add('warn', 'power_ap', 'Guasto Enel vicino al POP/AP', `${f.power.nearAp.place}: l’AP per ora funziona.${battery}`, 'Verificare se il guasto tocca anche il cliente prima di uscire.');
    else add('info', 'power_ap', 'Guasto Enel vicino al POP/AP, per ora la rete regge', `${f.power.nearAp.place}.${battery}`, 'Tenere d’occhio la batteria del POP finché la corrente non torna.');
  }
  const cpe = f.cpe;
  if (!cpe || !cpe.found) {
    add('info', 'cpe_unknown', 'CPE non trovata in rete', 'Non c’è una CPE associata a questo cliente, oppure non è mai stata vista.', 'Controllare MAC e installazione; se è nuova, procedere con l’installazione.');
  } else if (cpe.online === false) {
    if (f.power.nearCustomer) {
      add('warn', 'power_customer', 'Probabile mancanza di corrente dal cliente', `Guasto Enel a ${f.power.nearCustomer.distanceM} m (${f.power.nearCustomer.place}): la CPE è spenta.`, 'Chiedere al cliente se ha corrente; attendere il ripristino.');
    } else if (!f.ap || f.ap.online) {
      add('bad', 'cpe_off', 'CPE spenta o scollegata', `L’AP funziona, ma la CPE non risponde${cpe.lastSeen ? ` dall’ultimo contatto (${new Date(cpe.lastSeen).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })})` : ''}.`, 'Far verificare al cliente alimentatore PoE, presa e cavo; se tutto è acceso, uscita del tecnico.');
    }
  } else if (cpe.online) {
    if ((cpe.ethMbps != null && cpe.ethMbps > 0 && cpe.ethMbps < t.ethMinMbps) || cpe.ethHalfDuplex) {
      add('warn', 'lan_cable', 'Cavo di rete probabilmente danneggiato', `La porta LAN lavora a ${cpe.ethMbps ?? '?'} Mbit/s${cpe.ethHalfDuplex ? ' in half duplex' : ''}.`, 'Controllare cavo, connettori e PoE; spesso basta rifare un plug.');
    }
    if (f.pppoe && f.pppoe.online === false && !f.pppoe.suspended) {
      add('warn', 'pppoe_down', 'CPE in linea ma connessione del cliente giù', 'La CPE risponde, ma la sessione PPPoE non è attiva.', 'Router del cliente spento o scollegato, oppure credenziali PPPoE errate nel router.');
    }
    if (cpe.signal != null && cpe.signal < t.signalMin) {
      add('bad', 'signal_low', 'Segnale insufficiente', `Segnale ${cpe.signal} dBm (minimo ${t.signalMin}).`, 'Ripuntamento o cambio AP: uscita del tecnico.');
    } else {
      const drop = cpe.signal != null && f.signal.acceptance != null ? f.signal.acceptance - cpe.signal : null;
      if ((drop != null && drop >= t.signalDropDb) || (f.signal.trend != null && f.signal.trend <= -t.signalDropDb)) {
        add('warn', 'signal_drop', 'Segnale in calo', [drop != null && drop > 0 ? `${drop} dB in meno rispetto al collaudo (${f.signal.acceptance} → ${cpe.signal} dBm)` : null, f.signal.trend != null && f.signal.trend < 0 ? `${Math.abs(f.signal.trend)} dB in meno nell’ultimo mese` : null].filter(Boolean).join('; ') + '.', 'Probabile puntamento spostato o un ostacolo nuovo (alberi, edifici): valutare un ripuntamento.');
      }
    }
  }
  if (cpe?.outagesWeek != null && cpe.outagesWeek >= 5) {
    add('warn', 'flapping', 'La CPE si spegne spesso', `${cpe.outagesWeek} interruzioni negli ultimi 7 giorni${cpe.offlineMinWeek ? `, ${cpe.offlineMinWeek} minuti in tutto` : ''}.`, 'Alimentatore PoE o presa del cliente instabili, oppure cavo: da verificare sul posto.');
  }
  if (f.speed && f.speed.passed === false) {
    add('info', 'speed_low', 'Ultimo speedtest sotto il profilo', `${f.speed.downMbps ?? '?'}/${f.speed.upMbps ?? '?'} Mbit/s il ${new Date(f.speed.at).toLocaleDateString('it-IT')}.`, 'Confrontare con il segnale; se il segnale è buono, verificare la Wi-Fi del router del cliente.');
  }
  if (!out.some((x) => x.level === 'bad' || x.level === 'warn')) {
    add('ok', 'network_ok', 'Lato rete tutto regolare', 'CPE in linea con un buon segnale, AP e connessione attivi.', 'Probabile problema della Wi-Fi o dei dispositivi del cliente: verificare il router prima di uscire.');
  }
  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

const NEAR_CUSTOMER_M = 1500;

/** What the server knows of a line, gathered for [diagnose]. */
export function createDiagnosis(ctx: AppContext) {
  const { db } = ctx;

  async function subjectOf(q: { workOrderId?: number | undefined; mac?: string | undefined; pppoeUser?: string | undefined }) {
    let mac = q.mac ? parseMac(q.mac) : null;
    let pppoeUser = q.pppoeUser?.trim() ?? '';
    let customer = '';
    let address = '';
    let where: { lat: number; lon: number } | null = null;
    if (q.workOrderId) {
      const o = db.prepare('SELECT customer, address, lat, lon, pppoe_user, job_id FROM work_orders WHERE id = ?').get(q.workOrderId) as
        | { customer: string; address: string; lat: number | null; lon: number | null; pppoe_user: string; job_id: string | null }
        | undefined;
      if (!o) throw new HttpError(404, 'work_order_not_found');
      customer = o.customer;
      address = o.address;
      pppoeUser = pppoeUser || o.pppoe_user;
      if (o.lat != null && o.lon != null) where = { lat: o.lat, lon: o.lon };
      if (!mac && o.job_id) mac = (db.prepare('SELECT mac FROM provisioning_jobs WHERE id = ?').get(o.job_id) as { mac: string } | undefined)?.mac ?? null;
    }
    const crm = ctx.crmSync.available() ? ctx.crmSync.index() : null;
    const account = (pppoeUser && crm?.byUser.get(pppoeUser.toLowerCase())) || (mac && crm?.byMac.get(mac)) || null;
    if (!mac && pppoeUser) mac = (db.prepare("SELECT mac FROM provisioning_jobs WHERE pppoe_user = ? COLLATE NOCASE AND status = 'success' ORDER BY created_at DESC LIMIT 1").get(pppoeUser) as { mac: string } | undefined)?.mac ?? account?.mac ?? null;
    if (!pppoeUser && account) pppoeUser = account.username;
    return { mac, pppoeUser, customer: customer || account?.customerName || '', address, where, account };
  }

  async function facts(q: { workOrderId?: number | undefined; mac?: string | undefined; pppoeUser?: string | undefined }) {
    const s = await subjectOf(q);
    const u = ctx.uisp;
    const devices = u ? await u.allDevices().catch(() => []) : [];
    const norm = (m: string | null | undefined) => (m ? m.replace(/[^0-9a-f]/gi, '').toUpperCase() : '');
    const dev = s.mac ? devices.find((d) => norm(d.mac) === norm(s.mac)) : undefined;
    const ap = dev?.apId ? devices.find((d) => d.id === dev.apId) : undefined;
    const sameAp = ap ? devices.filter((d) => d.apId === ap.id) : [];
    const [stats, outs] = dev && u ? await Promise.all([u.statistics(dev.id, 'month').catch(() => null), u.outages(dev.id, 'week').catch(() => null)]) : [null, null];
    const acceptance = s.mac
      ? (db
          .prepare("SELECT a.data FROM job_acceptance a JOIN provisioning_jobs j ON j.id = a.job_id WHERE replace(upper(j.mac), ':', '') = ? ORDER BY a.created_at DESC LIMIT 1")
          .get(norm(s.mac)) as { data: string } | undefined)
      : undefined;
    const accSignal = acceptance ? ((JSON.parse(acceptance.data) as { radio?: { signal?: number } }).radio?.signal ?? null) : null;
    // the Enel outages now, near the AP / its POP or near the customer
    const active = ctx.outages.active();
    const popId = ap?.siteId ?? null;
    const nearAp = active.find((o) => o.impact.some((i) => (ap && i.type === 'ap' && i.id === ap.id) || (popId && (i.id === popId || i.popId === popId))));
    const at = dev?.location ?? s.where;
    const nearCustomer = at
      ? active
          .map((o) => ({ o, d: Math.round(distanceM(at, { lat: o.lat, lon: o.lon })) }))
          .filter((x) => x.d <= NEAR_CUSTOMER_M)
          .sort((a, b) => a.d - b.d)[0]
      : undefined;
    const battery = popId ? ctx.victronSync.byPop().get(popId) : undefined;
    const speed = s.mac
      ? (db.prepare('SELECT down_mbps downMbps, up_mbps upMbps, passed, measured_at at FROM speed_tests WHERE mac = ? ORDER BY measured_at DESC LIMIT 1').get(s.mac) as
          | { downMbps: number | null; upMbps: number | null; passed: number | null; at: string }
          | undefined)
      : undefined;
    const f: Facts = {
      cpe: dev
        ? {
            found: true,
            online: dev.status === 'active',
            signal: dev.signal,
            ethMbps: dev.ethMbps,
            ethHalfDuplex: dev.ethHalfDuplex,
            lastSeen: dev.lastSeen,
            outagesWeek: outs ? outs.length : null,
            offlineMinWeek: outs ? Math.round(outs.reduce((n, o) => n + (o.seconds ?? 0), 0) / 60) : null,
          }
        : s.mac
          ? { found: false, online: null, signal: null, ethMbps: null, ethHalfDuplex: false, lastSeen: null, outagesWeek: null, offlineMinWeek: null }
          : null,
      signal: { acceptance: accSignal, monthAvg: stats?.signal.avg ?? null, trend: stats?.signal.trend ?? null },
      pppoe: s.account ? { status: s.account.accountStatus, suspended: s.account.accountStatus === 'Sospeso', servicesSuspended: s.account.servicesSuspended, online: s.account.online } : null,
      ap: ap ? { name: ap.name, online: ap.status === 'active', cpeTotal: sameAp.length, cpeOffline: sameAp.filter((d) => d.status !== 'active').length } : null,
      power: {
        nearAp: nearAp ? { place: nearAp.place, kind: nearAp.kind } : null,
        nearCustomer: nearCustomer ? { place: nearCustomer.o.place, distanceM: nearCustomer.d } : null,
        popBattery: battery ? { soc: battery.soc, batteryState: battery.batteryState, status: battery.status } : null,
      },
      speed: speed ? { downMbps: speed.downMbps, upMbps: speed.upMbps, passed: speed.passed === null ? null : !!speed.passed, at: speed.at } : null,
    };
    return { subject: { customer: s.customer, address: s.address, pppoeUser: s.pppoeUser, mac: s.mac, apName: ap?.name ?? dev?.apName ?? null, signalPoints: stats?.signal.points ?? [] }, facts: f };
  }

  return {
    async run(q: { workOrderId?: number | undefined; mac?: string | undefined; pppoeUser?: string | undefined }) {
      if (!q.workOrderId && !q.mac && !q.pppoeUser) throw new HttpError(400, 'invalid_request');
      const { subject, facts: f } = await facts(q);
      const findings = diagnose(f, ctx.cfg.thresholds);
      return { at: new Date().toISOString(), subject, facts: f, findings, verdict: findings[0]!.title };
    },
  };
}
export type Diagnosis = ReturnType<typeof createDiagnosis>;
