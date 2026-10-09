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
  'account.password': 'Password personale cambiata',
  'network.export': 'Export CSV salute rete',
  'modules.update': 'Funzionalità modificate',
  'cpe_health.export': 'Export CSV salute CPE',
  'jobs.export': 'Export CSV dello storico',
  'connector.telegram.update': 'Notifiche Telegram modificate',
  'connector.telegram.reset': 'Notifiche Telegram rimosse',
  'uisp.drift': 'Confronto configurazione con il template',
  'job.replace': 'Sostituzione CPE (nuovo job)',
  'job.acceptance': 'Collaudo registrato',
  'job.photo': 'Foto di installazione caricata',
  'job.photo_delete': 'Foto di installazione eliminata',
  'account.totp_enable': 'Verifica in due passaggi attivata',
  'account.totp_disable': 'Verifica in due passaggi disattivata',
  'account.recovery_code': 'Codice di recupero usato',
  'account.recovery_new': 'Nuovi codici di recupero',
  'security.policy': 'Politica di sicurezza modificata',
  'field.access': 'Accesso alla CPE dagli strumenti di campo',
  'account.logout_all': 'Chiuse tutte le sessioni',
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
