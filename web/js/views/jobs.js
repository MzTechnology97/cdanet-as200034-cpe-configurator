import { api } from '../api.js';
import { busy, card, field, fmtDate, h, mount, pageHead, statusBadge, table } from '../dom.js';

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
          { label: 'CPE', render: (j) => h('div', {}, j.model, h('div', { class: 'small muted mono' }, j.mac)) },
          { label: 'SSID', key: 'ssid' },
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
            ['Client', j.client || '—'],
            ['Seriale', j.serial],
            ['Firmware rilevato', j.detected?.firmware || '—'],
            ['Board rilevata', j.detected?.board || '—'],
            ['MAC rilevato', j.detected?.mac || '—'],
          ].map(([k, v]) => h('div', { class: 'stat' }, h('small', {}, k), h('strong', {}, v))),
        ),
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
