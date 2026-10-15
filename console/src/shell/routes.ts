import type { ComponentType } from 'react';

/**
 * The pages of the console, in menu order, with who sees them. The same list and the same rules as
 * the console before: `admin` pages only for admins, `installer` pages only for
 * installers, `module` pages only while that module is on. The server enforces the same rules: the
 * menu only hides.
 *
 * Each page is a component, loaded when opened (`react`); a link outside the console has `href`.
 */
export interface User {
  id: number;
  username: string;
  role: 'admin' | 'installer' | string;
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

export interface Group {
  group: string;
  admin?: boolean;
}

export const ROUTES: Array<Route | Group> = [
  { group: 'Operatività' },
  { id: 'dashboard', label: 'Panoramica', icon: 'home', admin: true, bottom: true, react: () => import('../pages/Dashboard').then((m) => m.Dashboard) },
  { id: 'notifications', label: 'Notifiche', icon: 'notifications', react: () => import('../pages/Notifications').then((m) => m.Notifications) },
  { id: 'work-orders', icon: 'pending_actions', label: 'Interventi', installerLabel: 'I miei interventi', module: 'work_orders', bottom: true, react: () => import('../pages/WorkOrders').then((m) => m.WorkOrders) },
  { id: 'jobs', label: 'Storico provisioning', icon: 'history', react: () => import('../pages/Jobs').then((m) => m.Jobs) },
  { id: 'health', icon: 'monitor_heart', label: 'Salute CPE', installerLabel: 'Le mie CPE', module: 'cpe_health', bottom: true, react: () => import('../pages/Health').then((m) => m.Health) },
  // one CPE managed as in the UISP app (opened from Salute CPE, not in the menu)
  { id: 'cpe', icon: 'monitor_heart', label: 'Gestione CPE', module: 'cpe_health', admin: true, hidden: true, parent: 'health', react: () => import('../pages/CpeAdmin').then((m) => m.CpeAdmin) },
  { id: 'warehouse', icon: 'inventory', label: 'Magazzino', installerLabel: 'Il mio magazzino', react: () => import('../pages/Warehouse').then((m) => m.Warehouse) },
  { id: 'customers', icon: 'my_location', label: 'Clienti', admin: true, react: () => import('../pages/Customers').then((m) => m.Customers) },
  { id: 'stats', icon: 'query_stats', label: 'Statistiche', admin: true, module: 'stats', react: () => import('../pages/Stats').then((m) => m.Stats) },
  { id: 'outages', icon: 'power_off', label: 'Guasti Enel', module: 'power_outages', react: () => import('../pages/Outages').then((m) => m.Outages) },
  { id: 'network', icon: 'hub', label: 'Stato rete', module: 'network_status', react: () => import('../pages/Network').then((m) => m.Network) },
  { id: 'ia-ap', icon: 'troubleshoot', label: 'IA-AP', admin: true, react: () => import('../pages/Advisor').then((m) => m.Advisor) },
  { id: 'mytemplates', icon: 'memory', label: 'Template disponibili', installer: true, react: () => import('../pages/MyTemplates').then((m) => m.MyTemplates) },
  { id: 'coverage', icon: 'explore', label: 'Copertura', module: 'coverage', bottom: true, react: () => import('../pages/Coverage').then((m) => m.Coverage) },
  { id: 'routeros', icon: 'router', label: 'MikroTik · RouterOS', module: 'routeros', react: () => import('../pages/RouterOs').then((m) => m.RouterOs) },
  { group: 'Amministrazione', admin: true },
  { id: 'users', icon: 'person', label: 'Account', admin: true, react: () => import('../pages/Users').then((m) => m.Users) },
  { id: 'wireless', icon: 'wifi_find', label: 'Reti Wi-Fi (WPA2)', admin: true, react: () => import('../pages/Wireless').then((m) => m.Wireless) },
  { id: 'profiles', icon: 'settings_input_antenna', label: 'Profili airOS', admin: true, react: () => import('../pages/Profiles').then((m) => m.Profiles) },
  { id: 'firmware', icon: 'system_update', label: 'Firmware airOS', admin: true, module: 'firmware_upgrade', react: () => import('../pages/Firmware').then((m) => m.Firmware) },
  { id: 'connectors', icon: 'link', label: 'Connettori', admin: true, react: () => import('../pages/Connectors').then((m) => m.Connectors) },
  { id: 'server', icon: 'dns', label: 'Impostazioni server', admin: true, react: () => import('../pages/ServerSettings').then((m) => m.ServerSettings) },
  { id: 'modules', icon: 'handyman', label: 'Funzionalità', admin: true, react: () => import('../pages/Modules').then((m) => m.Modules) },
  { id: 'privacy', icon: 'lock', label: 'Informativa privacy', admin: true, react: () => import('../pages/Privacy').then((m) => m.Privacy) },
  { id: 'platform', icon: 'check_circle', label: 'Salute piattaforma', admin: true, react: () => import('../pages/Platform').then((m) => m.Platform) },
  { id: 'events', icon: 'manage_search', label: 'Registro attività', admin: true, react: () => import('../pages/Events').then((m) => m.Events) },
  { id: 'admin-guide', icon: 'menu_book', label: 'Guida amministratore', admin: true, react: () => import('../pages/Guide').then((m) => m.Guide) },
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
  if (r.installer) return user?.role !== 'admin'; // admins manage templates in Profili airOS
  return !r.admin || user?.role === 'admin';
}

export const labelOf = (r: Route, user: User | null) => (user?.role !== 'admin' && r.installerLabel ? r.installerLabel : r.label);
