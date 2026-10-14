import { nowIso, type Db } from '../db.ts';
import type { CrmSettings } from './crm.ts';

/**
 * Warehouse of ISP Billing (module Magazzino), read only: the stock of every warehouse (the
 * company's, the nodes', the installers' and partners'), copied here every hour. An installer
 * or partner account is linked to its warehouse: the app lists the CPEs they have and checks the
 * scanned one; the NOC sees stock by warehouse and model. Never written back to ISP Billing.
 */

export interface StockRow {
  stockId: number;
  siteId: number | null;
  site: string;
  article: string;
  code: string;
  serial: string;
  /** AA:BB:CC:DD:EE:FF when the serial is a device MAC (Ubiquiti CPEs), else ''. */
  mac: string;
  /** Model of the configurator when the article is one of its CPEs, else ''. */
  model: string;
  status: string;
  use: string;
  since: string;
}

const STATE_KEY = 'warehouse.sync';

/** Model of the configurator from an article name or code («LBE-5AC-GEN2-5-EU» → LiteBeam 5AC). */
export function cpeModel(article: string, code = ''): string {
  const t = `${article} ${code}`.toLowerCase().replace(/[-_]/g, ' ');
  const words = new Set(t.split(/[^a-z0-9]+/));
  if (t.includes('litebeam') || words.has('lbe')) return 'LiteBeam 5AC';
  if (t.includes('loco')) return 'NanoStation Loco 5AC';
  if (t.includes('nanobeam') || words.has('nbe')) return 'NanoBeam 5AC';
  if (t.includes('powerbeam') || words.has('pbe')) return 'PowerBeam 5AC';
  if (t.includes('nanostation') || /\bns 5ac\b/.test(t)) return 'NanoStation 5AC';
  return '';
}

/** A serial that is a device MAC (12 hex digits, unicast, not zero) as AA:BB:…, else ''. */
export function serialMac(serial: string): string {
  const hex = serial.trim().replace(/[\s:.-]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return '';
  if ((parseInt(hex.slice(0, 2), 16) & 1) === 1 || /^0+$/.test(hex)) return '';
  return hex.toUpperCase().match(/../g)!.join(':');
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

export function createWarehouse(db: Db, crm: CrmSettings) {
  let running: Promise<{ ok: boolean; items: number; error?: string }> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const state = () => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as { at: string | null; items: number; error: string | null }) : { at: null, items: 0, error: null };
  };
  const saveState = (v: { at: string | null; items: number; error: string | null }) =>
    db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(STATE_KEY, JSON.stringify(v), nowIso());

  /** Every page of the stock list (cursor pagination: { data, next }). */
  async function fetchAll(): Promise<StockRow[]> {
    const client = crm.client();
    if (!client) throw new Error('crm_not_configured');
    const rows: StockRow[] = [];
    let next: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const r = (await client.call('GET', `/api/modules/warehouse/stocks${next ? `?cursor=${encodeURIComponent(next)}` : ''}`)) as { data?: unknown; next?: unknown } | unknown[];
      const list = (Array.isArray(r) ? r : Array.isArray((r as { data?: unknown }).data) ? (r as { data: unknown[] }).data : []) as Array<Record<string, unknown>>;
      for (const x of list) {
        const article = str(x.article_name);
        const code = str(x.code);
        const serial = str(x.serial_number);
        const stockId = int(x.stock_id);
        if (stockId === null) continue;
        rows.push({ stockId, siteId: int(x.site_id), site: str(x.site_name), article, code, serial, mac: serialMac(serial), model: cpeModel(article, code), status: str(x.status), use: str(x.intended_use), since: str(x.created_at) });
      }
      next = Array.isArray(r) ? null : typeof (r as { next?: unknown }).next === 'string' && (r as { next: string }).next ? (r as { next: string }).next : null;
      if (!next || !list.length) break;
    }
    return rows;
  }

  async function run() {
    try {
      const rows = await fetchAll();
      // the CPEs before this read: what changed becomes a movement (not on the very first read)
      const before = new Map(
        (db.prepare("SELECT mac, site, model FROM crm_stock WHERE mac <> '' AND model <> ''").all() as Array<{ mac: string; site: string; model: string }>).map((r) => [r.mac, r]),
      );
      const after = new Map(rows.filter((r) => r.mac && r.model).map((r) => [r.mac, r]));
      const at = nowIso();
      const moves: Array<[string, string, string, string, string]> = [];
      if (before.size) {
        for (const [mac, r] of after) {
          const old = before.get(mac);
          if (!old) moves.push([mac, r.model, 'entrata', '', r.site]);
          else if (old.site !== r.site) moves.push([mac, r.model, 'trasferimento', old.site, r.site]);
        }
        for (const [mac, old] of before) if (!after.has(mac)) moves.push([mac, old.model, 'uscita', old.site, '']);
      }
      const ins = db.prepare('INSERT INTO crm_stock(stock_id, site_id, site, article, code, serial, mac, model, status, intended, since) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM crm_stock');
        for (const x of rows) ins.run(x.stockId, x.siteId, x.site, x.article, x.code, x.serial, x.mac, x.model, x.status, x.use, x.since);
        const mv = db.prepare('INSERT INTO cpe_movements(at, mac, model, kind, from_site, to_site) VALUES(?,?,?,?,?,?)');
        for (const m of moves) mv.run(at, ...m);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      saveState({ at: nowIso(), items: rows.length, error: null });
      return { ok: true, items: rows.length };
    } catch (e) {
      const error = (e as { code?: string; message?: string }).code ?? (e as Error).message;
      saveState({ ...state(), error });
      return { ok: false, items: state().items, error };
    }
  }

  const row = (r: Record<string, unknown>): StockRow => ({
    stockId: r.stock_id as number,
    siteId: r.site_id as number | null,
    site: r.site as string,
    article: r.article as string,
    code: r.code as string,
    serial: r.serial as string,
    mac: r.mac as string,
    model: r.model as string,
    status: r.status as string,
    use: r.intended as string,
    since: r.since as string,
  });

  /** A movement of our own (installed at a customer, acceptance test passed), for the audit. */
  function record(kind: 'installata' | 'collaudo', mac: string, detail: string, jobId: string | null) {
    if (!mac) return;
    const s = db.prepare('SELECT site, model FROM crm_stock WHERE mac = ? LIMIT 1').get(mac) as { site: string; model: string } | undefined;
    const model = s?.model ?? ((db.prepare('SELECT model FROM provisioning_jobs WHERE id = ?').get(jobId) as { model: string } | undefined)?.model ?? '');
    db.prepare('INSERT INTO cpe_movements(at, mac, model, kind, from_site, to_site, detail, job_id) VALUES(?,?,?,?,?,?,?,?)').run(nowIso(), mac, model, kind, s?.site ?? '', '', detail, jobId);
  }

  return {
    state,
    record,
    /** The audit of the CPE movements, newest first: one MAC's history, one warehouse's, or all. */
    movements(f: { mac?: string | undefined; site?: string | undefined; limit: number }) {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (f.mac) (where.push('mac = ?'), args.push(f.mac));
      if (f.site) (where.push('(from_site = ? OR to_site = ?)'), args.push(f.site, f.site));
      return db
        .prepare(`SELECT id, at, mac, model, kind, from_site fromSite, to_site toSite, detail, job_id jobId FROM cpe_movements ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`)
        .all(...args, f.limit) as Array<{ id: number; at: string; mac: string; model: string; kind: string; fromSite: string; toSite: string; detail: string; jobId: string | null }>;
    },
    /** A sync now (one at a time). */
    sync() {
      running ??= run().finally(() => (running = null));
      return running;
    },
    /** The warehouses (sites) with how many items and CPEs each has. */
    sites() {
      return db
        .prepare(`SELECT site_id id, site name, count(*) items, sum(model <> '') cpe FROM crm_stock WHERE site_id IS NOT NULL GROUP BY site_id, site ORDER BY items DESC, site`)
        .all() as Array<{ id: number; name: string; items: number; cpe: number }>;
    },
    /** The CPEs of a warehouse (configurator models only). */
    cpesOf(siteId: number) {
      return (db.prepare(`SELECT * FROM crm_stock WHERE site_id = ? AND model <> '' ORDER BY model, since DESC`).all(siteId) as Array<Record<string, unknown>>).map(row);
    },
    /** Where a CPE (by MAC) is in stock, if anywhere. */
    whereIs(mac: string) {
      const r = db.prepare('SELECT * FROM crm_stock WHERE mac = ? LIMIT 1').get(mac) as Record<string, unknown> | undefined;
      return r ? row(r) : null;
    },
    /** Stock was read at least once: before that no check can be made. */
    loaded: () => db.prepare('SELECT 1 FROM crm_stock LIMIT 1').get() !== undefined,
    /** CPEs by warehouse and model (NOC page). */
    byModel() {
      return db
        .prepare(`SELECT site_id siteId, site, model, count(*) n FROM crm_stock WHERE model <> '' GROUP BY site_id, site, model ORDER BY site, model`)
        .all() as Array<{ siteId: number | null; site: string; model: string; n: number }>;
    },
    /** CPEs still in a warehouse whose MAC is already installed (a written installation): to be unloaded. */
    toUnload() {
      return db
        .prepare(
          `SELECT s.site, s.model, s.mac, s.serial, j.id jobId, j.device_name customer, j.completed_at installedAt,
                  (a.job_id IS NOT NULL AND a.verdict <> 'bad' AND (a.review IS NULL OR a.review = 'approved')) accepted
             FROM crm_stock s JOIN provisioning_jobs j ON j.mac = s.mac AND j.status = 'success'
             LEFT JOIN job_acceptance a ON a.job_id = j.id
            WHERE s.mac <> '' GROUP BY s.mac ORDER BY accepted DESC, j.completed_at DESC`,
        )
        .all()
        .map((r) => ({ ...(r as Record<string, unknown>), accepted: !!(r as { accepted: number }).accepted })) as Array<{ site: string; model: string; mac: string; serial: string; jobId: string; customer: string; installedAt: string | null; accepted: boolean }>;
    },
    start(everyMs = 60 * 60_000) {
      const tick = () => {
        if (crm.client()) void this.sync();
      };
      timer = setInterval(tick, everyMs);
      timer.unref();
      setTimeout(tick, 90_000).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
export type Warehouse = ReturnType<typeof createWarehouse>;
