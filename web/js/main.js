import { api, session } from './api.js';
import { isOn, loadModules, modulesLoaded, resetModules } from './modules.js';
import { h, mount, toast } from './dom.js';
import { notificationsView, unreadCount } from './views/notifications.js';
import { loginView } from './views/login.js';
import { setAdmin } from './terms.js';
import { icon } from './icons.js';

/**
 * A page loaded only when it is opened (its module and what it imports): the console starts with
 * the shell, login and notifications, not with the code of every page.
 */
const page = (file, name) => (ctx) => import(`./views/${file}.js`).then((m) => m[name](ctx));

const ROUTES = [
  { group: 'Operatività' },
  { id: 'dashboard', label: 'Panoramica', icon: 'home', view: page('dashboard', 'dashboardView'), admin: true },
  { id: 'notifications', label: 'Notifiche', icon: 'notifications', view: notificationsView },
  { id: 'work-orders', icon: 'pending_actions', label: 'Interventi', installerLabel: 'I miei interventi', view: page('work-orders', 'workOrdersView'), module: 'work_orders' },
  { id: 'jobs', label: 'Storico provisioning', icon: 'history', view: page('jobs', 'jobsView') },
  { id: 'health', icon: 'monitor_heart', label: 'Salute CPE', installerLabel: 'Le mie CPE', view: page('health', 'healthView'), module: 'cpe_health' },
  // one CPE managed as in the UISP app (opened from Salute CPE, not in the menu)
  { id: 'cpe', icon: 'monitor_heart', label: 'CPE', view: page('cpe', 'cpeView'), module: 'cpe_health', admin: true, hidden: true, parent: 'health' },
  { id: 'customers', icon: 'my_location', label: 'Clienti', view: page('customers', 'customersView'), admin: true },
  { id: 'stats', icon: 'query_stats', label: 'Statistiche', view: page('stats', 'statsView'), admin: true, module: 'stats' },
  { id: 'outages', icon: 'power_off', label: 'Guasti Enel', view: page('outages', 'outagesView'), module: 'power_outages' },
  { id: 'network', icon: 'hub', label: 'Stato rete', view: page('network', 'networkView'), module: 'network_status' },
  { id: 'ia-ap', icon: 'troubleshoot', label: 'IA-AP', view: page('advisor', 'advisorView'), admin: true },
  { id: 'mytemplates', icon: 'memory', label: 'Template disponibili', view: page('mytemplates', 'myTemplatesView'), installer: true },
  { id: 'coverage', icon: 'explore', label: 'Copertura', view: page('coverage', 'coverageView'), module: 'coverage' },
  { id: 'routeros', icon: 'router', label: 'MikroTik · RouterOS', view: page('routeros', 'routerosView'), module: 'routeros' },
  { group: 'Amministrazione', admin: true },
  { id: 'users', icon: 'person', label: 'Account', view: page('users', 'usersView'), admin: true },
  { id: 'wireless', icon: 'wifi_find', label: 'Reti Wi-Fi (WPA2)', view: page('wireless', 'wirelessView'), admin: true },
  { id: 'profiles', icon: 'settings_input_antenna', label: 'Profili airOS', view: page('profiles', 'profilesView'), admin: true },
  { id: 'firmware', icon: 'system_update', label: 'Firmware airOS', view: page('firmware', 'firmwareView'), admin: true, module: 'firmware_upgrade' },
  { id: 'connectors', icon: 'link', label: 'Connettori', view: page('connectors', 'connectorsView'), admin: true },
  { id: 'server', icon: 'dns', label: 'Impostazioni server', view: page('server-settings', 'serverSettingsView'), admin: true },
  { id: 'modules', icon: 'handyman', label: 'Funzionalità', view: (ctx) => import('./views/modules-view.js').then((m) => m.modulesView({ ...ctx, onChange: () => renderChrome(session.get()?.user) })), admin: true },
  { id: 'privacy', icon: 'lock', label: 'Informativa privacy', view: page('privacy', 'privacyView'), admin: true },
  { id: 'events', icon: 'manage_search', label: 'Registro attività', view: page('events', 'eventsView'), admin: true },
  { id: 'admin-guide', icon: 'menu_book', label: 'Guida amministratore', view: page('guide', 'adminGuideView'), admin: true },
  { group: 'Profilo' },
  { id: 'account', icon: 'lock', label: 'Il mio account', view: page('account', 'accountView') },
  // static page, also opened by the app: same guide for installers and admins
  { id: 'guide', icon: 'menu_book', label: 'Guida installatore', href: '/wiki/' },
];

const viewEl = document.getElementById('view');
const sidebar = document.getElementById('sidebar');
const navToggle = document.getElementById('navToggle');
const shade = document.getElementById('shade');

/** Off-canvas menu on narrow screens (no effect on desktop, where the sidebar is static). */
function setMenu(open) {
  sidebar.classList.toggle('open', open);
  shade.hidden = !open;
  navToggle.setAttribute('aria-expanded', String(open));
}

function allowed(r, user) {
  if (r.module && !isOn(r.module)) return false;
  if (r.installer) return user?.role !== 'admin'; // admins manage templates in Profili airOS
  return !r.admin || user?.role === 'admin';
}

function renderChrome(user) {
  const sessionEl = document.getElementById('session');
  if (!user) {
    sidebar.hidden = true;
    setMenu(false);
    sidebar.replaceChildren();
    navToggle.hidden = true;
    sessionEl.replaceChildren();
    return;
  }
  sidebar.hidden = false;
  navToggle.hidden = false;
  mount(
    sidebar,
    ROUTES.filter((r) => allowed(r, user) && !r.hidden).map((r) =>
      r.group
        ? h('div', { class: 'group' }, r.group)
        : r.href
          ? h('a', { href: r.href, target: '_blank', rel: 'noopener' }, icon(r.icon), h('span', {}, r.label))
          : h(
              'a',
              { href: `#/${r.id}`, 'data-route': r.id },
              icon(r.icon),
              h('span', {}, user.role !== 'admin' && r.installerLabel ? r.installerLabel : r.label),
              r.id === 'notifications' ? h('span', { class: 'bell-count', hidden: true }) : null,
            ),
    ),
  );
  mount(
    sessionEl,
    h('a', { class: 'bell', href: '#/notifications', title: 'Notifiche', 'aria-label': 'Notifiche' }, '🔔', h('span', { class: 'bell-count', hidden: true })),
    h('a', { class: 'session-name', href: '#/account', title: 'Il mio account' }, `${user.username} · ${user.role === 'admin' ? 'Admin' : 'Installatore'}`),
    h('button', { onclick: logout }, 'Esci'),
  );
}

/** Unread notifications on the bell and in the menu: refreshed every minute while logged in. */
function showUnread(n) {
  for (const el of document.querySelectorAll('.bell-count')) {
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : String(n ?? '');
  }
}
window.addEventListener('cda:unread', (e) => showUnread(e.detail));
async function pollUnread() {
  if (session.get()?.token && !document.hidden) showUnread(await unreadCount());
}
setInterval(pollUnread, 60_000);
document.addEventListener('visibilitychange', pollUnread);

function logout() {
  session.clear();
  resetModules();
  location.hash = '';
  route();
}

async function route() {
  const s = session.get();
  renderChrome(s?.user);
  setMenu(false);
  if (!s?.token) {
    mount(viewEl, loginView(onLogin, onTotp));
    return;
  }
  setAdmin(s.user.role === 'admin');
  if (!modulesLoaded()) {
    await loadModules();
    renderChrome(s.user);
  }
  // #/route?key=value — the query part is handed to the view (e.g. #/profiles?user=5).
  const [path, query = ''] = location.hash.replace(/^#\//, '').split('?');
  const id = path || (s.user.role === 'admin' ? 'dashboard' : 'jobs');
  const r = ROUTES.find((x) => x.id === id && x.view && allowed(x, s.user)) ?? ROUTES.find((x) => x.id === 'jobs');
  for (const a of sidebar.querySelectorAll('a')) a.classList.toggle('active', a.dataset.route === (r.parent ?? r.id));
  void pollUnread();
  mount(viewEl, h('p', { class: 'muted' }, 'Caricamento…'));
  try {
    const content = await r.view({ user: s.user, params: new URLSearchParams(query) });
    // the section's icon next to the page title, as in the menu
    const h1 = content.querySelector?.('.page-head h1');
    if (h1 && r.icon && !h1.querySelector('svg')) h1.prepend(h('span', { class: 'head-icon' }, icon(r.icon)));
    mount(viewEl, content);
  } catch (e) {
    if (e.body?.error === 'mfa_setup_required' && id !== 'account') {
      location.hash = '#/account';
      return;
    }
    mount(viewEl, h('div', { class: 'notice bad' }, e.message || String(e)));
  }
}

/** Returns { mfaToken } when the account uses two-step verification (code asked by the login view). */
async function onLogin(username, password) {
  const d = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  if (d.mfaRequired) return { mfaToken: d.mfaToken };
  started(d);
  return {};
}

async function onTotp(mfaToken, code) {
  started(await api('/api/auth/login/totp', { method: 'POST', body: { mfaToken, code } }));
}

function started(d) {
  session.set({ token: d.token, user: d.user, expiresAt: d.expiresAt });
  toast(`Benvenuto ${d.user.username}`);
  if (d.mfaSetupRequired) {
    toast('Per gli amministratori la verifica in due passaggi è obbligatoria: attivala ora', 'bad');
    location.hash = '#/account';
  }
  route();
}

navToggle.addEventListener('click', () => setMenu(!sidebar.classList.contains('open')));
shade.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && setMenu(false));
window.addEventListener('hashchange', route);
window.addEventListener('cda:logout', () => {
  toast('Sessione scaduta: accedi di nuovo', 'bad');
  route();
});
route();
