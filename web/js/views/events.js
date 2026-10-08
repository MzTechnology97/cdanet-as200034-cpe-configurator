import { api } from '../api.js';
import { card, fmtDate, h, pageHead, table } from '../dom.js';

const LABELS = {
  'user.create': 'Account creato',
  'user.update': 'Account modificato',
  'wireless.set': 'WPA2 impostata',
  'wireless.delete': 'WPA2 eliminata',
  'wireless.import': 'Import WPA2 da CSV',
  'wireless.bulk_delete': 'WPA2 eliminate (multiplo)',
  'profile.set': 'Profilo caricato',
  'template.create': 'Template creato',
  'template.edit': 'Template modificato',
  'template.update': 'Template aggiornato (nome/board/predefinito)',
  'template.delete': 'Template eliminato',
  'uisp.authorize': 'CPE accettata in UISP',
  'uisp.backup': 'Backup UISP richiesto',
  'connector.uisp.update': 'Connettore UISP modificato',
  'connector.uisp.reset': 'Connettore UISP rimosso (torna al .env)',
  'profile.delete': 'Profilo eliminato',
  'job.create': 'Provisioning preparato',
};

export async function eventsView() {
  const events = await api('/api/admin/events?limit=300');
  return h(
    'div',
    {},
    pageHead('Registro attività', 'Operazioni amministrative e preparazioni di provisioning. Nessun segreto viene registrato.'),
    card(
      table(
        [
          { label: 'Data', render: (e) => fmtDate(e.createdAt) },
          { label: 'Utente', render: (e) => e.username ?? '—' },
          { label: 'Azione', render: (e) => LABELS[e.action] ?? e.action },
          { label: 'Oggetto', render: (e) => h('span', { class: 'mono small' }, e.target) },
          { label: 'Dettaglio', render: (e) => h('span', { class: 'small muted' }, e.detail) },
        ],
        events,
      ),
    ),
  );
}
