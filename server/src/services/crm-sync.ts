import { parseMac } from '../domain/policy.ts';
import { nowIso, type Db } from '../db.ts';
import type { CrmClient, CrmSettings } from './crm.ts';

/**
 * RADIUS state from ISP Billing, copied on the server every few minutes for the NOC: every
 * ISPRadius account with its customer, plan, account/customer/service suspensions and the current
 * session (online, MAC of the CPE, IP). Customer CPEs in UISP are matched by the session MAC,
 * installations of the app also by PPPoE user. Admins only: installers never see this source.
 */

export interface RadiusInfo {
  accountId: string;
  customerId: string;
  /** Installation site of the account (an address of the customer). */
  addressId: string;
  username: string;
  /** "Attivo", "Sospeso", "Terminato" as in ISP Billing. */
  accountStatus: string;
  profile: string;
  /** Plan speed in Mbit/s from the profile name, when it has one. */
  speed: { down: number; up: number } | null;
  staticIp: string;
  customerName: string;
  /** active, suspended, termination_in_progress… */
  customerStatus: string;
  customerGroup: string;
  /** At least one subscription service of the customer is suspended (usually unpaid). */
  servicesSuspended: boolean;
  /** null when the session state could not be read. */
  online: boolean | null;
  mac: string | null;
  clientIp: string | null;
  sessionSeconds: number | null;
  checkedAt: string | null;
}

export interface SyncState {
  at: string | null;
  ms: number | null;
  error: string | null;
  accounts: number;
  online: number;
  offline: number;
  suspended: number;
}

/** "ISP37@CDA-NET-HOME-30-6-NEW" → 30/6 Mbit/s (the last "number-number" of the name). */
export function profileSpeed(name: string): { down: number; up: number } | null {
  const all = [...name.matchAll(/(?:^|[^0-9])(\d{1,5})-(\d{1,5})(?=$|[^0-9])/g)];
  const m = all.at(-1);
  if (!m) return null;
  const down = Number(m[1]);
  const up = Number(m[2]);
  return down > 0 && up > 0 ? { down, up } : null;
}

/** Suspended for the NOC: the account, the customer or one of its services. */
export function isSuspended(r: Pick<RadiusInfo, 'accountStatus' | 'customerStatus' | 'servicesSuspended'>): boolean {
  return r.accountStatus === 'Sospeso' || r.customerStatus === 'suspended' || r.servicesSuspended;
}

const STATE_KEY = 'crm.radius.sync';
const EMPTY: SyncState = { at: null, ms: null, error: null, accounts: 0, online: 0, offline: 0, suspended: 0 };

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Every page of an offset-paginated list ({ data, next }). */
async function allPages(client: CrmClient, path: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; page <= 500; page++) {
    const d = (await client.call('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}`)) as { data?: Row[]; next?: unknown } | Row[];
    if (Array.isArray(d)) return [...out, ...d];
    out.push(...(d.data ?? []));
    if (!d.next || !(d.data ?? []).length) break;
  }
  return out;
}

export function createCrmSync(db: Db, crm: CrmSettings, opts: { concurrency?: number } = {}) {
  let running: Promise<SyncState> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const state = (): SyncState => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY) as { value: string } | undefined;
    return r ? { ...EMPTY, ...(JSON.parse(r.value) as SyncState) } : EMPTY;
  };
  const saveState = (v: SyncState) =>
    db
      .prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(STATE_KEY, JSON.stringify(v), nowIso());

  const toInfo = (r: Row): RadiusInfo => ({
    accountId: s(r.account_id),
    customerId: s(r.customer_id),
    addressId: s(r.address_id),
    username: s(r.username),
    accountStatus: s(r.account_status),
    profile: s(r.profile),
    speed: profileSpeed(s(r.profile)),
    staticIp: s(r.static_ip),
    customerName: s(r.customer_name),
    customerStatus: s(r.customer_status),
    customerGroup: s(r.customer_group),
    servicesSuspended: r.services_suspended === 1,
    online: r.online === null || r.online === undefined ? null : r.online === 1,
    mac: (r.mac as string | null) ?? null,
    clientIp: (r.client_ip as string | null) ?? null,
    sessionSeconds: (r.session_seconds as number | null) ?? null,
    checkedAt: (r.checked_at as string | null) ?? null,
  });

  async function run(): Promise<SyncState> {
    const client = crm.client();
    if (!client) return state();
    const started = Date.now();
    try {
      const [accounts, customers, instances] = [
        await allPages(client, '/api/modules/ispradius2/accounts'),
        await allPages(client, '/api/modules/crm/customers'),
        await allPages(client, '/api/modules/subscription-services/service-instances'),
      ];
      const customerById = new Map(customers.map((c) => [s(c.customer_id), c]));
      const suspendedCustomers = new Set(instances.filter((i) => s(i.status) === 'suspended').map((i) => s(i.customer_id)));
      // the previous session state stays when a single read fails
      const previous = new Map((db.prepare('SELECT * FROM crm_radius').all() as Row[]).map((r) => [s(r.account_id), r]));
      const live = accounts.filter((a) => s(a.status) !== 'Terminato');
      const sessions = new Map<string, Row>();
      const queue = [...live];
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          try {
            sessions.set(s(a.account_id), (await client.call('GET', `/api/modules/ispradius2/accounts/${encodeURIComponent(s(a.account_id))}/status`, undefined, 10_000)) as Row);
          } catch {
            // kept from the previous sync below
          }
        }
      };
      await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));

      // addresses (installation sites, main one included) of the customers with a live account
      const addresses = new Map<string, Row[]>();
      const custQueue = [...new Set(live.map((a) => s(a.customer_id)).filter(Boolean))];
      const addrWorker = async () => {
        for (let id = custQueue.shift(); id; id = custQueue.shift()) {
          try {
            const d = (await client.call('GET', `/api/modules/crm/customers/${encodeURIComponent(id)}/additional-addresses?include_main=1`, undefined, 10_000)) as Row[] | null;
            addresses.set(id, Array.isArray(d) ? d : []);
          } catch {
            // kept from the previous sync below
          }
        }
      };
      await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, addrWorker));
      const previousAddresses = db.prepare('SELECT * FROM crm_addresses').all() as Row[];
      const coord = (v: unknown) => {
        const n = Number(v);
        return v !== null && v !== '' && Number.isFinite(n) && n !== 0 ? n : null;
      };

      const now = nowIso();
      const ins = db.prepare(
        `INSERT INTO crm_radius(account_id, customer_id, username, account_status, profile, static_ip, cpe_type, customer_name, customer_status,
           customer_group, services_suspended, online, mac, client_ip, session_seconds, checked_at, address_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insCustomer = db.prepare(
        `INSERT INTO crm_customers(customer_id, name, internal_code, type, status, group_name, phone, phone2, email, address_line1, address_line2, city, postal_code, state_code)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insAddress = db.prepare(
        `INSERT OR REPLACE INTO crm_addresses(address_id, customer_id, description, address_line1, address_line2, city, postal_code, state_code, lat, lng, is_main)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      );
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM crm_radius');
        for (const a of accounts) {
          const id = s(a.account_id);
          const c = customerById.get(s(a.customer_id));
          const st = sessions.get(id);
          const prev = previous.get(id);
          const online = st ? (s(st.connection_status) === 'online' ? 1 : 0) : ((prev?.online as number | null) ?? null);
          const mac = st ? parseMac(s(st.mac_address)) : ((prev?.mac as string | null) ?? null);
          ins.run(
            id,
            s(a.customer_id),
            s(a.username),
            s(a.status),
            s(a.profile_name),
            s(a.static_ip),
            s(a.cpe_type),
            s(c?.customer_name ?? a.customer_name ?? [s(a.first_name), s(a.last_name)].filter(Boolean).join(' ')),
            s(c?.status),
            s(c?.group_name),
            suspendedCustomers.has(s(a.customer_id)) ? 1 : 0,
            s(a.status) === 'Terminato' ? null : online,
            mac,
            st ? (s(st.client_ip) || null) : ((prev?.client_ip as string | null) ?? null),
            st ? (typeof st.session_duration === 'number' ? st.session_duration : null) : ((prev?.session_seconds as number | null) ?? null),
            st ? now : ((prev?.checked_at as string | null) ?? null),
            s(a.address_id),
          );
        }
        db.exec('DELETE FROM crm_customers');
        for (const c of customers) {
          const name = s(c.customer_name) || s(c.business_name) || [s(c.first_name), s(c.last_name)].filter(Boolean).join(' ');
          insCustomer.run(
            s(c.customer_id), name, s(c.internal_code), s(c.type), s(c.status), s(c.group_name), s(c.phone_number), s(c.phone_number2),
            s(c.notification_general_email), s(c.address_line1), s(c.address_line2), s(c.city), s(c.postal_code), s(c.state_code),
          );
        }
        db.exec('DELETE FROM crm_addresses');
        for (const r of previousAddresses) {
          if (addresses.has(s(r.customer_id))) continue; // replaced by the fresh read below
          insAddress.run(r.address_id as string, r.customer_id as string, s(r.description), s(r.address_line1), s(r.address_line2), s(r.city), s(r.postal_code), s(r.state_code), r.lat as number | null, r.lng as number | null, r.is_main as number);
        }
        for (const [customerId, list] of addresses) {
          for (const ad of list) {
            insAddress.run(
              s(ad.address_id), customerId, s(ad.description), s(ad.address_line1), s(ad.address_line2), s(ad.city), s(ad.postal_code), s(ad.state_code),
              coord(ad.lat), coord(ad.lng), ad.is_main === true || ad.is_main === 1 ? 1 : 0,
            );
          }
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      const rows = all();
      const v: SyncState = {
        at: now,
        ms: Date.now() - started,
        error: null,
        accounts: rows.length,
        online: rows.filter((r) => r.online === true).length,
        // offline on purpose (suspended) is not a fault
        offline: rows.filter((r) => r.online === false && r.accountStatus === 'Attivo' && !isSuspended(r)).length,
        suspended: rows.filter((r) => r.accountStatus !== 'Terminato' && isSuspended(r)).length,
      };
      saveState(v);
      return v;
    } catch (e) {
      const v = { ...state(), error: String((e as { code?: string }).code ?? (e as Error).message).slice(0, 120), ms: Date.now() - started };
      saveState(v);
      return v;
    }
  }

  function all(): RadiusInfo[] {
    return (db.prepare('SELECT * FROM crm_radius').all() as Row[]).map(toInfo);
  }

  return {
    state: () => ({ ...state(), running: running !== null }),

    /** Runs a sync (or joins the one in progress). */
    sync(): Promise<SyncState> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },

    all,

    /** Lookup maps for a page: by session MAC (excluding terminated accounts) and by PPPoE user. */
    index() {
      const rows = all().filter((r) => r.accountStatus !== 'Terminato');
      return {
        byMac: new Map(rows.filter((r) => r.mac).map((r) => [r.mac!, r])),
        byUser: new Map(rows.map((r) => [r.username.toLowerCase(), r])),
      };
    },

    /** Only when the connector is active and at least one sync has data. */
    available: () => crm.client() !== null && (db.prepare('SELECT 1 FROM crm_radius LIMIT 1').get() !== undefined),

    start(everyMs = 10 * 60_000) {
      const tick = () => {
        if (crm.client()) void this.sync();
      };
      timer = setInterval(tick, everyMs);
      timer.unref();
      setTimeout(tick, 60_000).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
export type CrmSync = ReturnType<typeof createCrmSync>;
