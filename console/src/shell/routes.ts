import type { ComponentType } from 'react';

/**
 * The pages of the console, in menu order, with who sees them: `admin` pages only for admins (the
 * management of the platform), `staff` pages for admins and specialists (the specialist sees
 * everything like an admin), `specialist` pages only for specialists (their own section),
 * `installer` pages only for installers, `module` pages only while that module is on. The server
 * enforces the same rules: the menu only hides.
 *
 * Each page is a component, loaded when opened (`react`); a link outside the console has `href`.
 */
export interface User {
  id: number;
  username: string;
  role: 'admin' | 'installer' | 'specialist' | string;
  /** A specialist with «visibilità piena» (issue #275). */
  fullView?: boolean;
}

export interface PageContext {
  user: User;
  params: URLSearchParams;
}

export interface Route {
  id: string;
  label: string;
  installerLabel?: string;
  icon: string;
  admin?: boolean;
  /** Admins and specialists: technical tools without data of others. */
  staff?: boolean;
  /** CDA Net's data of everyone: admins and specialists with «visibilità piena» (issue #275). */
  all?: boolean;
  /** Works from CDA Net's own network (the server's tools): not for a specialist without «visibilità piena». */
  cdaWork?: boolean;
  /** Only the specialists: their own section. */
  specialist?: boolean;
  installer?: boolean;
  module?: string;
  hidden?: boolean;
  parent?: string;
  /** Opens outside the console (the installers' guide). */
  href?: string;
  react?: () => Promise<ComponentType<PageContext>>;
  /** Shown in the bottom bar on phones (at most four). */
  bottom?: boolean;
}

/** A title of the menu: shown when at least one of its pages is. */
export interface Group {
  group: string;
}

export const ROUTES: Array<Route | Group> = [
  // the specialist's own work first (owner, 17/10/2026): apart from CDA Net's
  { group: 'Specialist' },
  { id: 'specialist', label: 'Storico Specialist', icon: 'history', specialist: true, bottom: true, react: () => import('../pages/specialist/SpecialistJobs').then((m) => m.SpecialistJobs) },
  { id: 'specialist-templates', label: 'I miei template', icon: 'memory', specialist: true, react: () => import('../pages/specialist/SpecialistTemplates').then((m) => m.SpecialistTemplates) },
  { id: 'specialist-connectors', label: 'I miei connettori', icon: 'link', specialist: true, react: () => import('../pages/specialist/SpecialistConnectors').then((m) => m.SpecialistConnectors) },
  { group: 'Operatività' },
  { id: 'dashboard', label: 'Panoramica', icon: 'home', all: true, bottom: true, react: () => import('../pages/Dashboard').then((m) => m.Dashboard) },
  { id: 'notifications', label: 'Notifiche', icon: 'notifications', react: () => import('../pages/Notifications').then((m) => m.Notifications) },
  { id: 'work-orders', icon: 'pending_actions', label: 'Interventi', installerLabel: 'I miei interventi', module: 'work_orders', bottom: true, react: () => import('../pages/WorkOrders').then((m) => m.WorkOrders) },
  { id: 'jobs', label: 'Storico provisioning', icon: 'history', react: () => import('../pages/Jobs').then((m) => m.Jobs) },
  { id: 'health', icon: 'monitor_heart', label: 'Salute CPE', installerLabel: 'Le mie CPE', module: 'cpe_health', bottom: true, react: () => import('../pages/Health').then((m) => m.Health) },
  // one CPE managed as in the UISP app (opened from Salute CPE, not in the menu)
  { id: 'cpe', icon: 'monitor_heart', label: 'Gestione CPE', module: 'cpe_health', all: true, hidden: true, parent: 'health', react: () => import('../pages/CpeAdmin').then((m) => m.CpeAdmin) },
  { id: 'warehouse', icon: 'inventory', label: 'Magazzino', installerLabel: 'Il mio magazzino', react: () => import('../pages/Warehouse').then((m) => m.Warehouse) },
  { id: 'customers', icon: 'my_location', label: 'Clienti', all: true, react: () => import('../pages/Customers').then((m) => m.Customers) },
  { id: 'stats', icon: 'query_stats', label: 'Statistiche', all: true, module: 'stats', react: () => import('../pages/Stats').then((m) => m.Stats) },
  { id: 'outages', icon: 'power_off', label: 'Guasti Enel', module: 'power_outages', react: () => import('../pages/Outages').then((m) => m.Outages) },
  { id: 'network', icon: 'hub', label: 'Stato rete', module: 'network_status', react: () => import('../pages/Network').then((m) => m.Network) },
  { id: 'ia-ap', icon: 'troubleshoot', label: 'IA-AP', all: true, react: () => import('../pages/Advisor').then((m) => m.Advisor) },
  { id: 'mytemplates', icon: 'memory', label: 'Template disponibili', installer: true, react: () => import('../pages/MyTemplates').then((m) => m.MyTemplates) },
  { id: 'coverage', icon: 'explore', label: 'Copertura', module: 'coverage', bottom: true, react: () => import('../pages/Coverage').then((m) => m.Coverage) },
  { id: 'feasibility', icon: 'my_location', label: 'Fattibilità', all: true, module: 'coverage', react: () => import('../pages/Feasibility').then((m) => m.Feasibility) },
  { id: 'routeros', icon: 'router', label: 'MikroTik · RouterOS', module: 'routeros', cdaWork: true, react: () => import('../pages/RouterOs').then((m) => m.RouterOs) },
  { group: 'Amministrazione' },
  { id: 'users', icon: 'person', label: 'Account', admin: true, react: () => import('../pages/Users').then((m) => m.Users) },
  { id: 'work-groups', icon: 'person', label: 'Gruppi di lavoro', all: true, react: () => import('../pages/WorkGroups').then((m) => m.WorkGroups) },
  { id: 'wireless', icon: 'wifi_find', label: 'Reti Wi-Fi (WPA2)', admin: true, react: () => import('../pages/Wireless').then((m) => m.Wireless) },
  { id: 'profiles', icon: 'settings_input_antenna', label: 'Profili airOS', admin: true, react: () => import('../pages/Profiles').then((m) => m.Profiles) },
  { id: 'firmware', icon: 'system_update', label: 'Firmware airOS', admin: true, module: 'firmware_upgrade', react: () => import('../pages/Firmware').then((m) => m.Firmware) },
  { id: 'connectors', icon: 'link', label: 'Connettori', admin: true, react: () => import('../pages/Connectors').then((m) => m.Connectors) },
  { id: 'claude', icon: 'monitor_heart', label: 'Connetti il tuo Claude', admin: true, react: () => import('../pages/Claude').then((m) => m.Claude) },
  { id: 'server', icon: 'dns', label: 'Impostazioni server', admin: true, react: () => import('../pages/ServerSettings').then((m) => m.ServerSettings) },
  { id: 'modules', icon: 'handyman', label: 'Funzionalità', admin: true, react: () => import('../pages/Modules').then((m) => m.Modules) },
  { id: 'bans', icon: 'lock', label: 'Accessi bloccati', admin: true, react: () => import('../pages/Bans').then((m) => m.Bans) },
  { id: 'privacy', icon: 'lock', label: 'Informativa privacy', admin: true, react: () => import('../pages/Privacy').then((m) => m.Privacy) },
  { id: 'platform', icon: 'check_circle', label: 'Salute piattaforma', admin: true, react: () => import('../pages/Platform').then((m) => m.Platform) },
  { id: 'events', icon: 'manage_search', label: 'Registro attività', all: true, react: () => import('../pages/Events').then((m) => m.Events) },
  { id: 'admin-guide', icon: 'menu_book', label: 'Guida amministratore', staff: true, react: () => import('../pages/Guide').then((m) => m.Guide) },
  // the components of the console in both themes (admins): to check the look at a glance
  { id: 'ui', icon: 'handyman', label: 'Componenti', admin: true, hidden: true, react: () => import('../pages/UiShowcase').then((m) => m.UiShowcase) },
  { group: 'Profilo' },
  { id: 'account', icon: 'lock', label: 'Il mio account', react: () => import('../pages/Account').then((m) => m.Account) },
  // static page, also opened by the app: same guide for installers and admins
  { id: 'guide', icon: 'menu_book', label: 'Guida installatore', href: '/wiki/' },
];

export const isGroup = (r: Route | Group): r is Group => 'group' in r;

/** Whether [user] may open [r] with the modules on now ([isOn]). */
export function allowed(r: Route, user: User | null, isOn: (key: string) => boolean): boolean {
  if (r.module && !isOn(r.module)) return false;
  // admins manage CDA Net's templates in Profili airOS, the specialist has his own
  if (r.installer) return user?.role === 'installer';
  if (r.specialist) return user?.role === 'specialist';
  if (r.all) return seesAllUser(user);
  if (r.cdaWork && user?.role === 'specialist' && !user.fullView) return false;
  if (r.staff) return user?.role === 'admin' || user?.role === 'specialist';
  return !r.admin || user?.role === 'admin';
}

/** The pages and titles of the menu for [user]: a title only when one of its pages is shown. */
export function menuFor(user: User, isOn: (key: string) => boolean): Array<Route | Group> {
  const out: Array<Route | Group> = [];
  let title: Group | null = null;
  for (const r of ROUTES) {
    if (isGroup(r)) {
      title = r;
      continue;
    }
    if (!allowed(r, user, isOn) || r.hidden) continue;
    if (title) {
      out.push(title);
      title = null;
    }
    out.push(r);
  }
  return out;
}

function seesAllUser(user: User | null) {
  return user?.role === 'admin' || (user?.role === 'specialist' && !!user.fullView);
}
export const labelOf = (r: Route, user: User | null) => (!seesAllUser(user) && r.installerLabel ? r.installerLabel : r.label);
