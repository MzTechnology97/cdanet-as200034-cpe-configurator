import { api } from '../api.js';
import { badge, card, fmtDate, h, pageHead, stat } from '../dom.js';
import { uispStatusCard } from './uisp-panel.js';

export async function dashboardView() {
  const [s, profiles, uisp, osm] = await Promise.all([api('/api/admin/status'), api('/api/admin/profiles'), uispStatusCard(), osmStatus()]);
  const missingProfiles = profiles.filter((p) => !p.templates.length).map((p) => p.model);
  const warnings = [];
  if (!s.runtimeSecrets.cpeAdminPassword) warnings.push('CPE_ADMIN_PASSWORD non configurata: il provisioning è bloccato.');
  if (!s.runtimeSecrets.uispEnrollment) warnings.push('UISP_ENROLLMENT non configurata: i profili che usano ${UISP_ENROLLMENT} verranno rifiutati.');
  if (missingProfiles.length) warnings.push(`Profili airOS 8.7.4 mancanti: ${missingProfiles.join(', ')}.`);
  if (!s.counts.wirelessNetworks) warnings.push('Nessuna chiave WPA2 configurata.');
  if (!s.androidRelease) warnings.push('Nessuna release Android pubblicata nel canale aggiornamenti.');

  const n = s.policy.network;
  return h(
    'div',
    {},
    pageHead('Panoramica', `Server v${s.version}`),
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
