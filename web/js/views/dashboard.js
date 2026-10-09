import { api } from '../api.js';
import { badge, card, fmtDate, h, pageHead, stat } from '../dom.js';
import { icon } from '../icons.js';
import { isOn as moduleOn } from '../modules.js';
import { uispStatusCard } from './uisp-panel.js';

export async function dashboardView() {
  const [s, profiles, uisp, osm, net, privacy] = await Promise.all([
    api('/api/admin/status'),
    api('/api/admin/profiles'),
    uispStatusCard(),
    osmStatus(),
    moduleOn('network_status') ? api('/api/network/status').catch(() => null) : null,
    api('/api/admin/privacy').catch(() => null),
  ]);
  const missingProfiles = profiles.filter((p) => !p.templates.length).map((p) => p.model);
  const warnings = [];
  if (!s.runtimeSecrets.cpeAdminPassword) warnings.push('CPE_ADMIN_PASSWORD non configurata: il provisioning è bloccato.');
  if (!s.runtimeSecrets.uispEnrollment) warnings.push('UISP_ENROLLMENT non configurata: i profili che usano ${UISP_ENROLLMENT} verranno rifiutati.');
  if (missingProfiles.length) warnings.push(`Profili airOS 8.7.4 mancanti: ${missingProfiles.join(', ')}.`);
  if (!s.counts.wirelessNetworks) warnings.push('Nessuna chiave WPA2 configurata.');
  if (!s.androidRelease) warnings.push('Nessuna release Android pubblicata nel canale aggiornamenti.');
  if (privacy && !privacy.complete) warnings.push('Informativa privacy da completare con i dati del titolare (Amministrazione → Informativa privacy): finché manca, l’app non la fa accettare.');

  const n = s.policy.network;
  return h(
    'div',
    {},
    pageHead('Panoramica', `Server v${s.version}`),
    todayTiles(s.today, net),
    warnings.length ? h('div', { class: 'notice warn' }, h('b', {}, 'Da completare'), h('ul', { class: 'plain' }, warnings.map((w) => h('li', {}, w)))) : h('div', { class: 'notice good' }, 'Configurazione completa: il provisioning è operativo.'),
    card(
      h('h2', {}, 'Attività ultimi 30 giorni'),
      h(
        'div',
        { class: 'grid' },
        stat('Provisioning avviati', s.counts.jobs30d),
        stat('Completati', s.counts.success30d),
        stat('Account attivi', s.counts.users),
        stat('Reti WPA2', s.counts.wirelessNetworks),
        stat('Modelli con template', `${s.counts.profiles} / 5`),
        stat('Template airOS', s.counts.templates),
      ),
    ),
    card(h('h2', {}, 'UISP'), uisp),
    card(h('h2', {}, 'OpenStreetMap (ricerca indirizzi)'), osm),
    card(
      h('h2', {}, 'App Android'),
      h(
        'div',
        { class: 'grid' },
        stat('Release pubblicata', s.androidRelease ? `${s.androidRelease.versionName} (${s.androidRelease.versionCode})` : 'nessuna'),
        stat('Versione minima client', s.policy.minAndroidVersion),
        stat('Sync GitHub', s.androidReleaseSync ? `${s.androidReleaseSync.repo} · ogni ${s.androidReleaseSync.everyMinutes} min` : 'disattivato'),
      ),
      s.androidRelease ? h('p', { class: 'small muted mono' }, `SHA-256 ${s.androidRelease.sha256}`) : null,
    ),
    card(
      h('h2', {}, 'Baseline CPE (da variabili d’ambiente)'),
      h(
        'div',
        { class: 'grid' },
        stat('IP factory', n.factoryIp),
        stat('Utente admin CPE', s.policy.cpeAdminUsername),
        stat('LAN', `${n.lanIp} / ${n.lanNetmask}`),
        stat('DHCP', `${n.dhcpStart} – ${n.dhcpEnd} · ${n.dhcpLease}s`),
        stat('PPPoE MTU/MRU', `${n.pppoeMtu} / ${n.pppoeMru}`),
        stat('Watchdog', n.watchdogHost),
        stat('NTP', n.ntpServer),
        stat('SNMP', `${s.runtimeSecrets.snmpCommunity} · contact ${s.policy.snmpContact}`),
        stat('Validità job', `${s.policy.jobTtlMinutes} min`),
        stat('Retention audit', `${s.policy.auditRetentionDays} giorni`),
      ),
    ),
  );
}

/** Local Nominatim / public service at a glance (local import may take a while after install). */
async function osmStatus() {
  const r = await api('/api/admin/connectors/geocoder/test', { method: 'POST', body: {} }).catch(() => null);
  if (!r) return h('p', { class: 'small muted' }, 'Stato non disponibile.');
  const p = r.primary;
  const state = p.ok
    ? badge('operativo', 'good')
    : p.local && r.fallback?.ok
      ? badge('import in corso / non pronto: si usa la riserva', 'warn')
      : badge('non disponibile', 'bad');
  return h(
    'div',
    { class: 'grid' },
    stat('Servizio', p.local ? 'Nominatim locale' : 'pubblico (openstreetmap.org)'),
    h('div', { class: 'stat' }, h('small', {}, 'Stato'), state),
    stat('Dati aggiornati al', p.dataUpdated ? fmtDate(p.dataUpdated) : '—'),
    h('div', { class: 'stat' }, h('small', {}, 'Dettagli'), h('a', { href: '#/connectors' }, 'Connettori')),
  );
}

/** One number that needs attention, with its icon; the whole tile opens the page to act on it. */
function tile(href, ic, value, label, tone = '') {
  return h('a', { class: `tile ${tone}`, href }, h('span', { class: 'tile-icon' }, icon(ic)), h('span', { class: 'tile-text' }, h('b', {}, String(value)), h('span', {}, label)));
}

/** "Oggi": work orders, NOC approvals, open KO reports, the network at a glance. */
function todayTiles(t, net) {
  if (!t) return null;
  const tiles = [
    moduleOn('work_orders') ? tile('#/work-orders', 'pending_actions', `${t.workOrdersDone}/${t.workOrders}`, 'interventi di oggi fatti', '') : null,
    moduleOn('work_orders') && t.workOrdersLate ? tile('#/work-orders', 'warning_filled', t.workOrdersLate, 'interventi in ritardo', 'bad') : null,
    tile('#/jobs', t.nocPending ? 'pending_actions' : 'check_circle', t.nocPending, 'collaudi da approvare (NOC)', t.nocPending ? 'warn' : 'good'),
    tile('#/jobs', t.koOpen ? 'error_filled' : 'check_circle', t.koOpen, 'KO o rimandi aperti', t.koOpen ? 'warn' : 'good'),
    tile('#/jobs', 'rocket_launch', t.jobs24h, 'provisioning nelle ultime 24 ore'),
    net ? tile('#/network', net.summary.down ? 'cloud_off' : 'hub', net.summary.down, 'AP non raggiungibili', net.summary.down ? 'bad' : 'good') : null,
    net && net.summary.powerOutage ? tile('#/network', 'bolt', net.summary.powerOutage, 'AP con guasto Enel vicino', 'warn') : null,
  ].filter(Boolean);
  return card(h('h2', {}, 'Oggi'), h('div', { class: 'tiles' }, tiles));
}
