import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Button, Card, Icon, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * Registro attività (admins): administrative operations and provisioning preparations, newest
 * first. No secret is ever recorded. Search and action filter work on the rows already read.
 */

const LABELS: Record<string, string> = {
  speedtest: 'Speedtest dall’app',
  'job.acceptance_pass': 'Collaudo segnato come superato dal NOC',
  'advisor.dismiss': 'IA-AP: avviso ignorato',
  'advisor.optimize': 'IA-AP: ottimizzazione programmata',
  'advisor.optimize_cancel': 'IA-AP: ottimizzazione annullata',
  'advisor.refresh': 'IA-AP: analisi aggiornata',
  'antennas.ap': 'Antenna di un AP impostata',
  'antennas.import': 'Diagrammi delle antenne scaricati',
  'assignments.settings': 'POP/AP visibili agli installatori: impostazioni',
  'connector.firebase.update': 'Connettore Firebase modificato',
  'connector.firebase.delete': 'Connettore Firebase rimosso',
  'connector.imagery.update': 'Immagini satellitari modificate',
  'connector.imagery.reset': 'Immagini satellitari rimosse',
  'connector.imagery.test': 'Immagini satellitari: prova',
  'coverage.accuracy': 'Affidabilità della copertura misurata',
  'cpe_health.assign': 'CPE assegnate a un installatore',
  'crm.customer.view': 'Scheda cliente CRM consultata',
  'crm.radius.sync': 'Stato RADIUS sincronizzato',
  'firmware.upload': 'Firmware caricato',
  'firmware.delete': 'Firmware eliminato',
  'firmware.download': 'Firmware scaricato',
  'firmware.upgrade': 'Aggiornamento firmware di una CPE',
  'job.acceptance_position': 'Collaudo rifiutato: troppo lontano dall’intervento',
  'job.acceptance_pdf': 'Rapporto di collaudo PDF scaricato',
  'job.delete': 'Tentativo di installazione eliminato',
  'notifications.device': 'Telefono registrato per le notifiche push',
  'outages.assign': 'POP/AP assegnati a un installatore',
  'outages.selection': 'Guasti Enel: POP/AP monitorati',
  'outages.my_zone_add': 'Zona personale dei guasti aggiunta',
  'outages.my_zone_edit': 'Zona personale dei guasti modificata',
  'outages.my_zone_delete': 'Zona personale dei guasti eliminata',
  'outages.telegram_link': 'Telegram personale collegato',
  'outages.telegram_unlink': 'Telegram personale scollegato',
  'pointing.config': 'Puntamento: impostazioni modificate',
  'privacy.accept': 'Informativa privacy accettata',
  'privacy.controller': 'Titolare del trattamento modificato',
  'security.screenshot': 'Tentativo di screenshot nell’app',
  'terrain.import': 'Terreno e ostacoli scaricati',
  'terrain.buildings': 'Edifici dalla mappa base',
  'terrain.canopy': 'Altezze degli alberi scaricate',
  'terrain.anncsu': 'Civici ANNCSU scaricati',
  'uisp.subscriber': 'Nuovo subscriber creato in UISP',
  'warehouse.refresh': 'Magazzino riletto',
  'work_order.create': 'Intervento creato',
  'work_order.update': 'Intervento modificato',
  'work_order.delete': 'Intervento eliminato o annullato',
  'work_order.status': 'Stato di un intervento cambiato',
  'work_order.position_mismatch': 'Intervento: posizione non corrispondente',
  'user.create': 'Account creato',
  'user.update': 'Account modificato',
  'wireless.set': 'WPA2 impostata',
  'wireless.delete': 'WPA2 eliminata',
  'wireless.import': 'Import WPA2 da CSV',
  'wireless.uisp_import': 'Chiave WPA2 comune applicata agli SSID di UISP',
  'wireless.export': 'Chiavi WPA2 esportate in chiaro (CSV)',
  'wireless.bulk_delete': 'WPA2 eliminate (multiplo)',
  'profile.set': 'Profilo caricato',
  'template.create': 'Template creato',
  'template.convert': 'Template convertito (valori del server copiati)',
  'template.convert_failed': 'Template non convertito',
  'template.edit': 'Template modificato',
  'template.update': 'Template aggiornato (nome/board/predefinito)',
  'template.delete': 'Template eliminato',
  'uisp.authorize': 'CPE accettata in UISP',
  'uisp.backup': 'Backup UISP richiesto',
  'account.password': 'Password personale cambiata',
  'network.export': 'Export CSV salute rete',
  'outages.config': 'Guasti Enel: impostazioni',
  'outages.zone_add': 'Guasti Enel: zona aggiunta',
  'outages.zone_delete': 'Guasti Enel: zona eliminata',
  'outages.device': 'Notifiche guasti attivate sull’app',
  'modules.user': 'Funzionalità di un utente modificate',
  'modules.update': 'Funzionalità modificate',
  'cpe_health.export': 'Export CSV salute CPE',
  'jobs.export': 'Export CSV dello storico',
  'connector.telegram.update': 'Notifiche Telegram modificate',
  'connector.telegram.reset': 'Notifiche Telegram rimosse',
  'uisp.drift': 'Confronto configurazione con il template',
  'job.replace': 'Sostituzione CPE (nuovo job)',
  'job.adopted': 'CPE installata prima dell’app registrata',
  'job.acceptance': 'Collaudo registrato',
  'rma.update': 'CPE smontata: stato aggiornato',
  'rma.condition': 'CPE smontata: condizione indicata dall’installatore',
  'warehouse.min_stock': 'Minimo di CPE del magazzino cambiato',
  'feasibility.pdf': 'Fattibilità scaricata in PDF',
  'platform.backup': 'Backup del database scaricato',
  'nas.backup': 'Backup sul NAS',
  'auth.ban': 'Accesso bloccato dopo troppi tentativi',
  'auth.unban': 'Accesso sbloccato',
  'mcp.authorize': 'Claude collegato alla piattaforma',
  'mcp.call': 'Claude ha letto la piattaforma',
  'mcp.revoke': 'Connessione di Claude revocata',
  'nas.verify': 'Prova di ripristino di un backup sul NAS',
  'nas.mkdir': 'Cartella creata sul NAS',
  'connector.nas.update': 'Connettore NAS modificato',
  'connector.nas.reset': 'Connettore NAS rimosso',
  'connector.nas.test': 'Test del connettore NAS',
  'platform.backup_verify': 'Backup verificato',
  'report.monthly_pdf': 'Report mensile scaricato',
  'job.acceptance_repoint': 'Collaudo di ripuntamento',
  'job.repoint_claim': 'CPE di un altro installatore presa per un ripuntamento',
  'job.repoint_revoke': 'Accesso al ripuntamento revocato',
  'coverage.operators': 'Verifica altri operatori',
  'work_order.export': 'Export CSV degli interventi',
  'job.review_approved': 'Collaudo con segnale pessimo approvato dal NOC',
  'job.review_rejected': 'Collaudo con segnale pessimo rifiutato dal NOC',
  'install.postponed': 'Installazione rimandata',
  'install.ko': 'Installazione KO definitivo',
  'install.ko_resolved': 'Rimando o KO segnato come risolto',
  'notifications.prefs': 'Preferenze notifiche Telegram',
  'job.photo': 'Foto di installazione caricata',
  'job.photo_delete': 'Foto di installazione eliminata',
  'account.totp_enable': 'Verifica in due passaggi attivata',
  'account.totp_disable': 'Verifica in due passaggi disattivata',
  'account.recovery_code': 'Codice di recupero usato',
  'account.recovery_new': 'Nuovi codici di recupero',
  'security.policy': 'Politica di sicurezza modificata',
  'field.access': 'Accesso alla CPE dagli strumenti di campo',
  'session.offline_resume': 'Ripresa della sessione senza Internet',
  'field.offline_use': 'Uso dell’app senza Internet',
  'server.settings': 'Impostazioni server modificate',
  'server.restart': 'Riavvio dell’app dalla console',
  'server.infra': 'Infrastruttura richiesta dalla console',
  'field.relink': 'CPE spostata su un altro AP (installazione guidata)',
  'account.logout_all': 'Chiuse tutte le sessioni',
  'account.session_long': 'Accesso con verifica in due passaggi: resta connesso',
  'specialist.template_create': 'Specialist: template creato',
  'specialist.template_copy': 'Specialist: template copiato da CDA Net',
  'specialist.template_edit': 'Specialist: template modificato',
  'specialist.template_update': 'Specialist: dati del template modificati',
  'specialist.template_delete': 'Specialist: template eliminato',
  'specialist.connector_create': 'Specialist: connettore aggiunto',
  'specialist.connector_update': 'Specialist: connettore modificato',
  'specialist.connector_delete': 'Specialist: connettore eliminato',
  'specialist.job': 'Specialist: configurazione preparata',
  'specialist.job_written': 'Specialist: configurazione scritta nella CPE',
  'specialist.job_failed': 'Specialist: scrittura non riuscita',
  'specialist.job_delete': 'Specialist: installazione eliminata dallo storico',
  'specialist.acceptance': 'Specialist: collaudo',
  'specialist.uisp_authorize': 'Specialist: CPE autorizzata nell’UISP dell’azienda',
  'specialist.export': 'Specialist: export CSV dello storico',
  'account.quick_login_on': 'Accesso rapido (impronta/volto) attivato su un telefono',
  'account.quick_login_off': 'Accesso rapido revocato',
  'account.quick_login': 'Accesso rapido dall’app',
  'connector.uisp.update': 'Connettore UISP modificato',
  'connector.crm.update': 'Connettore CRM (ISP Billing) modificato',
  'connector.crm.reset': 'Connettore CRM (ISP Billing) rimosso',
  'connector.crm.test': 'Test del connettore CRM',
  'connector.uisp.reset': 'Connettore UISP rimosso (torna al .env)',
  'profile.delete': 'Profilo eliminato',
  'job.create': 'Provisioning preparato',
};

interface Event {
  id: number;
  createdAt: string;
  username: string | null;
  action: string;
  target: string;
  detail: string;
}

const date = (iso: string) => new Date(iso.includes('T') || iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
const LIMITS = [300, 500];

export function Events() {
  const [limit, setLimit] = useState(300);
  const q = useQuery({ queryKey: ['admin', 'events', limit], queryFn: () => api<Event[]>(`/api/admin/events?limit=${limit}`) });
  const [text, setText] = useState('');
  const [action, setAction] = useState('');
  const rows = q.data ?? [];
  const actions = useMemo(() => [...new Set(rows.map((e) => e.action))].sort((a, b) => (LABELS[a] ?? a).localeCompare(LABELS[b] ?? b, 'it')), [rows]);
  const t = text.trim().toLowerCase();
  const shown = rows.filter((e) => (!action || e.action === action) && (!t || `${e.username ?? ''} ${LABELS[e.action] ?? e.action} ${e.target} ${e.detail}`.toLowerCase().includes(t)));

  return (
    <div className="ui-page">
      <PageHeader
        icon="manage_search"
        title="Registro attività"
        subtitle="Operazioni amministrative e preparazioni di provisioning. Nessun segreto viene registrato."
        actions={
          <Button icon="refresh" busy={q.isFetching} onClick={() => void q.refetch()}>
            Aggiorna
          </Button>
        }
      />
      <div className="nw-tools">
        <label className="hl-search">
          <Icon name="search" />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Cerca utente, azione, oggetto o dettaglio" aria-label="Cerca" />
        </label>
        <select className="wo-date" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Azione">
          <option value="">Tutte le azioni</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {LABELS[a] ?? a}
            </option>
          ))}
        </select>
      </div>
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !q.data ? (
        <Skeleton lines={8} />
      ) : (
        <Card padded={false}>
          <div className="hl-count">
            {shown.length === rows.length ? `${rows.length} operazioni` : `${shown.length} di ${rows.length} operazioni`}
            <span className="ui-muted"> · le più recenti per prime</span>
          </div>
          <Table
            rows={shown}
            rowKey={(e) => e.id}
            empty="Nessuna operazione con questi filtri."
            columns={[
              { label: 'Data', render: (e) => <span className="ev-date">{date(e.createdAt)}</span> },
              { label: 'Utente', render: (e) => e.username ?? '—' },
              { label: 'Azione', render: (e) => LABELS[e.action] ?? e.action },
              { label: 'Oggetto', render: (e) => <span className="ui-mono ui-small">{e.target}</span> },
              { label: 'Dettaglio', render: (e) => <span className="ui-muted ui-small">{e.detail}</span> },
            ]}
          />
          {rows.length >= limit && limit < LIMITS[LIMITS.length - 1]! && (
            <div className="hl-more">
              <Button onClick={() => setLimit(LIMITS[LIMITS.length - 1]!)}>Mostra fino a {LIMITS[LIMITS.length - 1]} operazioni</Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
