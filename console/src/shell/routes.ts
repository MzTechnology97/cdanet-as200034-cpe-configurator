import type { ComponentType } from 'react';

/**
 * The pages of the console, in menu order, with who sees them. The same list and the same rules as
 * the console before (web/js/main.js): `admin` pages only for admins, `installer` pages only for
 * installers, `module` pages only while that module is on. The server enforces the same rules: the
 * menu only hides.
 *
 * A page is either a page of web/js (`legacy`: a function returning DOM, loaded when opened) or a
 * converted page (`react`: a component, loaded when opened).
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

type LegacyView = (ctx: PageContext & Record<string, unknown>) => Node | Promise<Node>;

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
  legacy?: () => Promise<LegacyView>;
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
  { id: 'work-orders', icon: 'pending_actions', label: 'Interventi', installerLabel: 'I miei interventi', module: 'work_orders', bottom: true, legacy: () => import('../../../web/js/views/work-orders.js').then((m) => m.workOrdersView) },
  { id: 'jobs', label: 'Storico provisioning', icon: 'history', legacy: () => import('../../../web/js/views/jobs.js').then((m) => m.jobsView) },
  { id: 'health', icon: 'monitor_heart', label: 'Salute CPE', installerLabel: 'Le mie CPE', module: 'cpe_health', bottom: true, legacy: () => import('../../../web/js/views/health.js').then((m) => m.healthView) },
  // one CPE managed as in the UISP app (opened from Salute CPE, not in the menu)
  { id: 'cpe', icon: 'monitor_heart', label: 'CPE', module: 'cpe_health', admin: true, hidden: true, parent: 'health', legacy: () => import('../../../web/js/views/cpe.js').then((m) => m.cpeView) },
  { id: 'customers', icon: 'my_location', label: 'Clienti', admin: true, legacy: () => import('../../../web/js/views/customers.js').then((m) => m.customersView) },
  { id: 'stats', icon: 'query_stats', label: 'Statistiche', admin: true, module: 'stats', legacy: () => import('../../../web/js/views/stats.js').then((m) => m.statsView) },
  { id: 'outages', icon: 'power_off', label: 'Guasti Enel', module: 'power_outages', legacy: () => import('../../../web/js/views/outages.js').then((m) => m.outagesView) },
  { id: 'network', icon: 'hub', label: 'Stato rete', module: 'network_status', legacy: () => import('../../../web/js/views/network.js').then((m) => m.networkView) },
  { id: 'ia-ap', icon: 'troubleshoot', label: 'IA-AP', admin: true, legacy: () => import('../../../web/js/views/advisor.js').then((m) => m.advisorView) },
  { id: 'mytemplates', icon: 'memory', label: 'Template disponibili', installer: true, legacy: () => import('../../../web/js/views/mytemplates.js').then((m) => m.myTemplatesView) },
  { id: 'coverage', icon: 'explore', label: 'Copertura', module: 'coverage', bottom: true, legacy: () => import('../../../web/js/views/coverage.js').then((m) => m.coverageView) },
  { id: 'routeros', icon: 'router', label: 'MikroTik · RouterOS', module: 'routeros', legacy: () => import('../../../web/js/views/routeros.js').then((m) => m.routerosView) },
  { group: 'Amministrazione', admin: true },
  { id: 'users', icon: 'person', label: 'Account', admin: true, legacy: () => import('../../../web/js/views/users.js').then((m) => m.usersView) },
  { id: 'wireless', icon: 'wifi_find', label: 'Reti Wi-Fi (WPA2)', admin: true, legacy: () => import('../../../web/js/views/wireless.js').then((m) => m.wirelessView) },
  { id: 'profiles', icon: 'settings_input_antenna', label: 'Profili airOS', admin: true, legacy: () => import('../../../web/js/views/profiles.js').then((m) => m.profilesView) },
  { id: 'firmware', icon: 'system_update', label: 'Firmware airOS', admin: true, module: 'firmware_upgrade', legacy: () => import('../../../web/js/views/firmware.js').then((m) => m.firmwareView) },
  { id: 'connectors', icon: 'link', label: 'Connettori', admin: true, legacy: () => import('../../../web/js/views/connectors.js').then((m) => m.connectorsView) },
  { id: 'server', icon: 'dns', label: 'Impostazioni server', admin: true, legacy: () => import('../../../web/js/views/server-settings.js').then((m) => m.serverSettingsView) },
  { id: 'modules', icon: 'handyman', label: 'Funzionalità', admin: true, legacy: () => import('../../../web/js/views/modules-view.js').then((m) => m.modulesView) },
  { id: 'privacy', icon: 'lock', label: 'Informativa privacy', admin: true, legacy: () => import('../../../web/js/views/privacy.js').then((m) => m.privacyView) },
  { id: 'events', icon: 'manage_search', label: 'Registro attività', admin: true, legacy: () => import('../../../web/js/views/events.js').then((m) => m.eventsView) },
  { id: 'admin-guide', icon: 'menu_book', label: 'Guida amministratore', admin: true, legacy: () => import('../../../web/js/views/guide.js').then((m) => m.adminGuideView) },
  // the components of the console in both themes (admins): to check the look at a glance
  { id: 'ui', icon: 'handyman', label: 'Componenti', admin: true, hidden: true, react: () => import('../pages/UiShowcase').then((m) => m.UiShowcase) },
  { group: 'Profilo' },
  { id: 'account', icon: 'lock', label: 'Il mio account', legacy: () => import('../../../web/js/views/account.js').then((m) => m.accountView) },
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
