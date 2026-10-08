import { api } from '../api.js';
import { busy, card, field, fmtDate, h, mount, pageHead, statusBadge, table } from '../dom.js';
import { acceptanceBadge, acceptancePanel } from './acceptance-panel.js';
import { osmLink } from './coverage.js';
import { uispPanel } from './uisp-panel.js';

export async function jobsView({ user }) {
  const q = h('input', { placeholder: 'MAC, seriale, utente RADIUS, SSID, cliente…' });
  const status = h(
    'select',
    {},
    h('option', { value: '' }, 'Tutti'),
    h('option', { value: 'success' }, 'Completati'),
    h('option', { value: 'failed' }, 'Falliti'),
    h('option', { value: 'prepared' }, 'Preparati / in corso'),
    h('option', { value: 'expired' }, 'Scaduti'),
  );
  const out = h('div', {});
  const detail = h('div', {});
  const search = h('button', { class: 'primary', type: 'submit' }, 'Cerca');

  async function load() {
    const params = new URLSearchParams({ limit: '300' });
    if (q.value.trim()) params.set('q', q.value.trim());
    if (status.value) params.set('status', status.value);
    const jobs = await api(`/api/provisioning/jobs?${params}`);
    mount(
      out,
      table(
        [
          { label: 'Data', render: (j) => fmtDate(j.createdAt) },
          { label: 'Esito', render: (j) => statusBadge(j.status) },
          { label: 'Cliente', render: (j) => h('div', {}, j.deviceName || '—', h('div', { class: 'small muted' }, j.pppoeUser)) },
          { label: 'CPE', render: (j) => h('div', {}, j.model, j.template ? h('div', { class: 'small muted' }, `Template: ${j.template}`) : null, h('div', { class: 'small muted mono' }, j.mac)) },
          { label: 'SSID', key: 'ssid' },
          { label: 'Collaudo', render: (j) => (j.acceptance ? h('span', {}, acceptanceBadge(j.acceptance), j.photos ? h('span', { class: 'small muted' }, ` · ${j.photos} foto`) : '') : j.photos ? h('span', { class: 'small muted' }, `${j.photos} foto`) : '—') },
          { label: 'UISP', render: (j) => (j.uispAuthorizedAt ? h('span', { class: 'small' }, `✓ ${j.uispSite}`) : j.status === 'success' ? h('span', { class: 'small muted' }, 'da accettare') : '—') },
          user.role === 'admin' ? { label: 'Installatore', key: 'installer' } : null,
        ].filter(Boolean),
        jobs,
        (j) => showDetail(j),
      ),
    );
  }

  function showDetail(j) {
    mount(
      detail,
      card(
        h('h2', {}, `Job ${j.id}`),
        h(
          'div',
          { class: 'grid' },
          [
            ['Creato', fmtDate(j.createdAt)],
            ['Completato', fmtDate(j.completedAt)],
            ['Esito', j.status],
            ['Template', j.template || '—'],
            ['Client', j.client || '—'],
            ['Seriale', j.serial],
            ['Firmware rilevato', j.detected?.firmware || '—'],
            ['Board rilevata', j.detected?.board || '—'],
            ['MAC rilevato', j.detected?.mac || '—'],
          ].map(([k, v]) => h('div', { class: 'stat' }, h('small', {}, k), h('strong', {}, v))),
        ),
        h('h3', {}, 'Posizione CPE'),
        j.latitude != null
          ? h(
              'p',
              {},
              `${j.latitude.toFixed(6)}, ${j.longitude.toFixed(6)}`,
              j.locationAccuracy ? ` · ±${Math.round(j.locationAccuracy)} m` : '',
              ` · ${{ gps: 'GPS del telefono', address: 'da indirizzo', manual: 'inserita a mano' }[j.locationSource] ?? j.locationSource} · `,
              h('a', { href: osmLink(j.latitude, j.longitude), target: '_blank', rel: 'noopener' }, 'apri su OpenStreetMap'),
            )
          : h('p', { class: 'small muted' }, 'Non registrata.'),
        j.status === 'success' ? [h('h3', {}, 'Collaudo'), acceptancePanel(j)] : null,
        j.replacesJobId ? h('p', { class: 'small muted' }, `Sostituisce la CPE del job ${j.replacesJobId}`) : null,
        j.status === 'success' ? [h('h3', {}, 'UISP'), uispPanel(j, user.role === 'admin')] : null,
        j.stages?.length ? [h('h3', {}, 'Fasi'), h('ol', {}, j.stages.map((s) => h('li', {}, s)))] : null,
        j.error ? [h('h3', {}, 'Errore'), h('pre', {}, j.error)] : null,
      ),
    );
    detail.scrollIntoView({ behavior: 'smooth' });
  }

  const form = h(
    'form',
    { class: 'row', onsubmit: (e) => (e.preventDefault(), busy(search, load)) },
    field('Ricerca', q),
    field('Esito', status),
    search,
  );
  await load();
  return h(
    'div',
    {},
    pageHead('Storico provisioning', user.role === 'admin' ? 'Tutti gli installatori · solo metadati, nessuna password' : 'I tuoi provisioning · solo metadati'),
    card(form, out),
    detail,
  );
}
