import { HttpError } from '../auth.ts';

/**
 * The CRM of UISP (https://<uisp>/crm/api/v1.0, header X-Auth-App-Key): new subscribers of the
 * installations accepted by the NOC. A subscriber is a CRM client with a service of the chosen
 * plan; UISP then makes its endpoint site, where the CPE is authorized. Needs the app key of the
 * CRM (Connettori → UISP), with write permission: the token of the network API cannot do this.
 */

export interface ServicePlan {
  id: number;
  name: string;
  /** The monthly period of the plan (the service is created with it); null when the plan has none. */
  periodId: number | null;
}

export interface NewSubscriber {
  firstName: string;
  lastName: string;
  street: string;
  lat: number | null;
  lon: number | null;
  servicePlanPeriodId: number;
  note?: string | undefined;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function createUispCrm(opts: { url: string; appKey: string; fetchImpl?: typeof fetch | undefined }) {
  const base = `${opts.url.replace(/\/+$/, '')}/crm/api/v1.0`;
  const f = opts.fetchImpl ?? fetch;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let r: Response;
    try {
      r = await f(base + path, {
        method,
        headers: { 'X-Auth-App-Key': opts.appKey, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HttpError(502, 'uisp_unreachable');
    }
    if (r.status === 401 || r.status === 403) throw new HttpError(502, 'uisp_crm_unauthorized');
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new HttpError(502, 'uisp_crm_error', { status: r.status, detail: text.slice(0, 300) });
    }
    return r.status === 204 ? null : r.json();
  }

  /**
   * The service plans with their monthly period (the NOC chooses one at acceptance). A service only
   * takes plans of its client's organization, and new clients go into the default one: the plans
   * of the other organizations are left out.
   */
  async function servicePlans(): Promise<ServicePlan[]> {
    const list = (await call('GET', '/service-plans')) as unknown[];
    const orgs = (await call('GET', '/organizations').catch(() => [])) as Array<{ id?: unknown; selected?: unknown }>;
    const home = num((Array.isArray(orgs) ? orgs : []).find((o) => o?.selected === true)?.id);
    return (Array.isArray(list) ? list : []).flatMap((p) => {
      const o = p as { id?: unknown; name?: unknown; archived?: unknown; organizationId?: unknown; periods?: Array<{ id?: unknown; period?: unknown; enabled?: unknown }> };
      const id = num(o.id);
      if (id === null || typeof o.name !== 'string' || o.archived === true) return [];
      if (home !== null && num(o.organizationId) !== null && num(o.organizationId) !== home) return [];
      const periods = (o.periods ?? []).filter((x) => x.enabled !== false);
      const monthly = periods.find((x) => x.period === 1) ?? periods[0];
      return [{ id, name: o.name, periodId: num(monthly?.id) }];
    });
  }

  /** Client and service of a new subscriber; [siteId] is the endpoint site when UISP already made it. */
  async function createSubscriber(s: NewSubscriber): Promise<{ clientId: number; serviceId: number; siteId: string | null }> {
    const gps = s.lat !== null && s.lon !== null ? { addressGpsLat: s.lat, addressGpsLon: s.lon } : {};
    const client = (await call('POST', '/clients', {
      clientType: 1,
      isLead: false,
      firstName: s.firstName,
      lastName: s.lastName,
      street1: s.street,
      ...gps,
      ...(s.note ? { note: s.note } : {}),
    })) as { id?: unknown };
    const clientId = num(client?.id);
    if (clientId === null) throw new HttpError(502, 'uisp_crm_error', { detail: 'cliente senza id' });
    const service = (await call('POST', `/clients/${clientId}/services`, {
      servicePlanPeriodId: s.servicePlanPeriodId,
      activeFrom: new Date().toISOString(),
      street1: s.street,
      ...gps,
      ...(s.lat !== null && s.lon !== null ? { isAddressGpsCustom: true } : {}),
    })) as { id?: unknown; unmsClientSiteId?: unknown };
    const serviceId = num(service?.id);
    if (serviceId === null) throw new HttpError(502, 'uisp_crm_error', { detail: 'servizio senza id' });
    return { clientId, serviceId, siteId: typeof service.unmsClientSiteId === 'string' ? service.unmsClientSiteId : null };
  }

  /** The endpoint site UISP made for a service (null while it is not there yet). */
  async function serviceSite(serviceId: number): Promise<string | null> {
    const s = (await call('GET', `/clients/services/${serviceId}`)) as { unmsClientSiteId?: unknown };
    return typeof s?.unmsClientSiteId === 'string' ? s.unmsClientSiteId : null;
  }

  return { servicePlans, createSubscriber, serviceSite };
}
export type UispCrm = ReturnType<typeof createUispCrm>;

/**
 * The UISP plan of an ISPBilling PPPoE profile: "ISP37@CDA-NET-HOME-25-5" (or …-NEW) → "CDA NET HOME 25/5".
 * null for the profiles without a plan of that form (dedicated lines, FTTH…): the NOC picks it.
 */
export function planForProfile(profile: string): string | null {
  const m = /^(?:[^@]*@)?CDA-NET-(HOME|B2B|RICARICABILE)-(\d+)-(\d+)(?:-NEW)?$/i.exec(profile.trim());
  return m ? `CDA NET ${m[1]!.toUpperCase()} ${Number(m[2])}/${Number(m[3])}` : null;
}

/** "rossi.mario@cda-net.it" or "ROSSI MARIO" → first and last name for the subscriber (surname first in our users). */
export function subscriberName(pppoeUser: string, deviceName: string): { firstName: string; lastName: string } {
  const words = (deviceName.trim() || pppoeUser.replace(/@.*$/, '').replace(/[._-]+/g, ' ')).trim().split(/\s+/).filter(Boolean);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  if (words.length === 0) return { firstName: '', lastName: '' };
  if (words.length === 1) return { firstName: '', lastName: cap(words[0]!) };
  return { lastName: cap(words[0]!), firstName: words.slice(1).map(cap).join(' ') };
}
