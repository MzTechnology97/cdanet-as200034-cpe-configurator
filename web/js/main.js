import { api, session } from './api.js';
import { h, mount, toast } from './dom.js';
import { dashboardView } from './views/dashboard.js';
import { eventsView } from './views/events.js';
import { jobsView } from './views/jobs.js';
import { loginView } from './views/login.js';
import { profilesView } from './views/profiles.js';
import { routerosView } from './views/routeros.js';
import { toolsView } from './views/tools.js';
import { usersView } from './views/users.js';
import { wirelessView } from './views/wireless.js';

const ROUTES = [
  { group: 'Operatività' },
  { id: 'dashboard', label: 'Panoramica', view: dashboardView, admin: true },
  { id: 'jobs', label: 'Storico provisioning', view: jobsView },
  { id: 'tools', label: 'Strumenti di rete', view: toolsView },
  { id: 'routeros', label: 'MikroTik · RouterOS', view: routerosView },
  { group: 'Amministrazione', admin: true },
  { id: 'users', label: 'Account', view: usersView, admin: true },
  { id: 'wireless', label: 'Reti Wi-Fi (WPA2)', view: wirelessView, admin: true },
  { id: 'profiles', label: 'Profili airOS', view: profilesView, admin: true },
  { id: 'events', label: 'Registro attività', view: eventsView, admin: true },
];

const viewEl = document.getElementById('view');
const sidebar = document.getElementById('sidebar');
const navToggle = document.getElementById('navToggle');

function allowed(r, user) {
  return !r.admin || user?.role === 'admin';
}

function renderChrome(user) {
  const sessionEl = document.getElementById('session');
  if (!user) {
    sidebar.hidden = true;
    sidebar.classList.remove('open');
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
      r.group ? h('div', { class: 'group' }, r.group) : h('a', { href: `#/${r.id}`, 'data-route': r.id }, r.label),
    ),
  );
  mount(
    sessionEl,
    h('span', {}, `${user.username} · ${user.role === 'admin' ? 'Admin' : 'Installatore'}`),
    h('button', { onclick: logout }, 'Esci'),
  );
}

function logout() {
  session.clear();
  location.hash = '';
  route();
}

async function route() {
  const s = session.get();
  renderChrome(s?.user);
  sidebar.classList.remove('open');
  if (!s?.token) {
    mount(viewEl, loginView(onLogin));
    return;
  }
  const id = location.hash.replace(/^#\//, '') || (s.user.role === 'admin' ? 'dashboard' : 'jobs');
  const r = ROUTES.find((x) => x.id === id && allowed(x, s.user)) ?? ROUTES.find((x) => x.id === 'jobs');
  for (const a of sidebar.querySelectorAll('a')) a.classList.toggle('active', a.dataset.route === r.id);
  mount(viewEl, h('p', { class: 'muted' }, 'Caricamento…'));
  try {
    const content = await r.view({ user: s.user });
    mount(viewEl, content);
  } catch (e) {
    mount(viewEl, h('div', { class: 'notice bad' }, e.message || String(e)));
  }
}

async function onLogin(username, password) {
  const d = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  session.set({ token: d.token, user: d.user, expiresAt: d.expiresAt });
  toast(`Benvenuto ${d.user.username}`);
  route();
}

navToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
window.addEventListener('hashchange', route);
window.addEventListener('cda:logout', () => {
  toast('Sessione scaduta: accedi di nuovo', 'bad');
  route();
});
route();
