import { api, session } from './api.js';
import { isOn, loadModules, modulesLoaded, resetModules } from './modules.js';
import { h, mount, toast } from './dom.js';
import { accountView } from './views/account.js';
import { connectorsView } from './views/connectors.js';
import { coverageView } from './views/coverage.js';
import { dashboardView } from './views/dashboard.js';
import { eventsView } from './views/events.js';
import { healthView } from './views/health.js';
import { jobsView } from './views/jobs.js';
import { modulesView } from './views/modules-view.js';
import { outagesView } from './views/outages.js';
import { serverSettingsView } from './views/server-settings.js';
import { networkView } from './views/network.js';
import { notificationsView, unreadCount } from './views/notifications.js';
import { loginView } from './views/login.js';
import { myTemplatesView } from './views/mytemplates.js';
import { profilesView } from './views/profiles.js';
import { routerosView } from './views/routeros.js';
import { statsView } from './views/stats.js';
import { usersView } from './views/users.js';
import { wirelessView } from './views/wireless.js';
import { adminGuideView } from './views/guide.js';
import { workOrdersView } from './views/work-orders.js';
import { firmwareView } from './views/firmware.js';
import { privacyView } from './views/privacy.js';
import { setAdmin } from './terms.js';
import { icon } from './icons.js';

const ROUTES = [
  { group: 'Operatività' },
  { id: 'dashboard', label: 'Panoramica', icon: 'home', view: dashboardView, admin: true },
  { id: 'notifications', label: 'Notifiche', icon: 'notifications', view: notificationsView },
  { id: 'work-orders', icon: 'pending_actions', label: 'Interventi', installerLabel: 'I miei interventi', view: workOrdersView, module: 'work_orders' },
  { id: 'jobs', label: 'Storico provisioning', icon: 'history', view: jobsView },
  { id: 'health', icon: 'monitor_heart', label: 'Salute CPE', installerLabel: 'Le mie CPE', view: healthView, module: 'cpe_health' },
  { id: 'stats', icon: 'query_stats', label: 'Statistiche', view: statsView, admin: true, module: 'stats' },
  { id: 'outages', icon: 'power_off', label: 'Guasti Enel', view: outagesView, module: 'power_outages' },
  { id: 'network', icon: 'hub', label: 'Stato rete', view: networkView, module: 'network_status' },
  { id: 'mytemplates', icon: 'memory', label: 'Template disponibili', view: myTemplatesView, installer: true },
  { id: 'coverage', icon: 'explore', label: 'Copertura', view: coverageView, module: 'coverage' },
  { id: 'routeros', icon: 'router', label: 'MikroTik · RouterOS', view: routerosView, module: 'routeros' },
  { group: 'Amministrazione', admin: true },
  { id: 'users', icon: 'person', label: 'Account', view: usersView, admin: true },
  { id: 'wireless', icon: 'wifi_find', label: 'Reti Wi-Fi (WPA2)', view: wirelessView, admin: true },
  { id: 'profiles', icon: 'settings_input_antenna', label: 'Profili airOS', view: profilesView, admin: true },
  { id: 'firmware', icon: 'system_update', label: 'Firmware airOS', view: firmwareView, admin: true, module: 'firmware_upgrade' },
  { id: 'connectors', icon: 'link', label: 'Connettori', view: connectorsView, admin: true },
  { id: 'server', icon: 'dns', label: 'Impostazioni server', view: serverSettingsView, admin: true },
  { id: 'modules', icon: 'handyman', label: 'Funzionalità', view: (ctx) => modulesView({ ...ctx, onChange: () => renderChrome(session.get()?.user) }), admin: true },
  { id: 'privacy', icon: 'lock', label: 'Informativa privacy', view: privacyView, admin: true },
  { id: 'events', icon: 'manage_search', label: 'Registro attività', view: eventsView, admin: true },
  { id: 'admin-guide', icon: 'menu_book', label: 'Guida amministratore', view: adminGuideView, admin: true },
  { group: 'Profilo' },
  { id: 'account', icon: 'lock', label: 'Il mio account', view: accountView },
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
    ROUTES.filter((r) => allowed(r, user)).map((r) =>
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
  for (const a of sidebar.querySelectorAll('a')) a.classList.toggle('active', a.dataset.route === r.id);
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
