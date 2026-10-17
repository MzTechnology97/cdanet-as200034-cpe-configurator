import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import type { User } from './routes';
import { isStaff } from '../lib/roles';

/**
 * The search of the console (Ctrl+K): CPEs, customers, APs and installations through the same API
 * the pages use, so the same rules apply (installers: their CPEs and APs only; customers: admins
 * only; a module off: nothing from it). Lists already read by a page are not read again.
 */
export interface Hit {
  kind: 'cpe' | 'customer' | 'ap' | 'job';
  id: string;
  title: string;
  sub: string;
  href: string;
  icon: string;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const hexOnly = (s: string) => s.replace(/[^0-9a-f]/gi, '').toLowerCase();

/** Every word of [q] in [text]; a MAC fragment also without separators ("2233" finds 11:22:33). */
export function matches(q: string, ...fields: unknown[]): boolean {
  const text = norm(fields.filter(Boolean).join(' '));
  const hex = hexOnly(fields.filter(Boolean).join(' '));
  return norm(q)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w) || (/^[0-9a-f:.-]{4,}$/i.test(w) && hexOnly(w).length >= 4 && hex.includes(hexOnly(w))));
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

interface HealthCpe {
  deviceId?: string | null;
  deviceName?: string;
  mac?: string;
  ssid?: string;
  model?: string;
  now?: { apName?: string | null } | null;
}
interface NetworkAp {
  id: string;
  name: string;
  ssid?: string;
  state?: string;
}
interface Job {
  id: string;
  mac?: string;
  deviceName?: string;
  ssid?: string;
  status?: string;
  installer?: string;
  createdAt?: string;
}
interface Customer {
  customerId: string;
  name: string;
  code?: string;
  sites?: Array<{ account?: { username?: string }; cpe?: { name?: string; mac?: string } | null }>;
}

export function useGlobalSearch(q: string, user: User, isOn: (m: string) => boolean): { hits: Hit[]; loading: boolean } {
  const term = useDebounced(q.trim(), 200);
  const on = term.length >= 2;
  // admins and specialists: the customers and the CPEs as in the UISP app
  const admin = isStaff(user);

  const health = useQuery({ queryKey: keys.cpeHealth, queryFn: () => api<{ cpes: HealthCpe[] }>('/api/cpe-health'), enabled: on && isOn('cpe_health'), staleTime: 60_000 });
  const network = useQuery({ queryKey: keys.network, queryFn: () => api<{ pops: Array<{ aps: NetworkAp[] }>; apsWithoutPop?: NetworkAp[] }>('/api/network/status'), enabled: on && isOn('network_status'), staleTime: 60_000 });
  const jobs = useQuery({ queryKey: keys.jobs(term), queryFn: () => api<Job[] | { jobs: Job[] }>(`/api/provisioning/jobs?q=${encodeURIComponent(term)}&limit=6`), enabled: on });
  const customers = useQuery({
    queryKey: keys.customers(term),
    queryFn: () => api<{ rows: Customer[] }>(`/api/admin/crm/customers?filter=all&q=${encodeURIComponent(term)}&limit=6`),
    enabled: on && admin,
  });

  if (!on) return { hits: [], loading: false };
  const hits: Hit[] = [];
  // the whole text in the name first ("demo 4" before the CPEs that merely have a 4 in the MAC)
  const exact = (name: unknown) => (norm(name).includes(norm(term)) ? 0 : 1);
  const cpes = (health.data?.cpes ?? [])
    .filter((c) => matches(term, c.deviceName, c.mac, c.ssid, c.model, c.now?.apName))
    .sort((a, b) => exact(a.deviceName) - exact(b.deviceName))
    .slice(0, 6);
  for (const c of cpes) {
    hits.push({
      kind: 'cpe',
      id: c.deviceId ?? c.mac ?? c.deviceName ?? '',
      title: c.deviceName || c.mac || 'CPE',
      sub: [c.mac, c.now?.apName ?? c.ssid].filter(Boolean).join(' · '),
      // admins: the CPE as in the UISP app; installers: their list, filtered
      href: admin && c.deviceId ? `#/cpe?id=${encodeURIComponent(c.deviceId)}` : `#/health?q=${encodeURIComponent(c.mac ?? c.deviceName ?? term)}`,
      icon: 'monitor_heart',
    });
  }
  for (const c of customers.data?.rows ?? []) {
    hits.push({
      kind: 'customer',
      id: c.customerId,
      title: c.name,
      sub: [c.code, c.sites?.map((s) => s.account?.username).filter(Boolean).slice(0, 2).join(', ')].filter(Boolean).join(' · '),
      href: `#/customers?q=${encodeURIComponent(c.name)}`,
      icon: 'person',
    });
  }
  const aps = [...(network.data?.pops ?? []).flatMap((p) => p.aps ?? []), ...(network.data?.apsWithoutPop ?? [])]
    .filter((a) => matches(term, a.name, a.ssid))
    .sort((a, b) => exact(a.name) - exact(b.name))
    .slice(0, 5);
  for (const a of aps) hits.push({ kind: 'ap', id: a.id, title: a.name, sub: [a.ssid, a.state === 'down' ? 'non raggiungibile' : null].filter(Boolean).join(' · '), href: '#/network', icon: 'cell_tower' });
  const jobList = Array.isArray(jobs.data) ? jobs.data : (jobs.data?.jobs ?? []);
  for (const j of jobList.slice(0, 5)) {
    hits.push({
      kind: 'job',
      id: j.id,
      title: j.deviceName || j.mac || 'Installazione',
      sub: [j.mac, j.installer, j.createdAt ? new Date(j.createdAt).toLocaleDateString('it-IT') : null].filter(Boolean).join(' · '),
      href: `#/jobs?q=${encodeURIComponent(j.mac || j.deviceName || term)}`,
      icon: 'history',
    });
  }
  return { hits, loading: [health, network, jobs, customers].some((x) => x.isFetching) };
}
