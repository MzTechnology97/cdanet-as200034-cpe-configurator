import { createHash } from 'node:crypto';

/**
 * Privacy notice for the users of the app (installers and office), art. 13 Reg. (UE) 2016/679
 * (GDPR), D.Lgs. 196/2003 as amended by D.Lgs. 101/2018, art. 4 L. 300/1970. The controller's
 * details come from the console (Informativa privacy); the accepted text is identified by its
 * SHA-256, so any change asks everyone to read it again.
 */

export const PRIVACY_VERSION = '1.0';

export interface Controller {
  /** Ragione sociale. */
  name: string;
  address: string;
  vat: string;
  email: string;
  pec: string;
  /** Data protection officer, when appointed (name and contact); empty = not appointed. */
  dpo: string;
  /** Months the activity log and the acceptance tests are kept (default 24). */
  retentionMonths: number;
}

export const controllerComplete = (c: Controller | null): c is Controller => !!c && !!c.name.trim() && !!c.address.trim() && !!c.email.trim();

export interface NoticeSection {
  title: string;
  paragraphs: string[];
}

export function privacyNotice(c: Controller): { title: string; sections: NoticeSection[] } {
  const contact = [c.email, c.pec ? `PEC ${c.pec}` : ''].filter(Boolean).join(' · ');
  return {
    title: 'Informativa sul trattamento dei dati personali degli utenti dell’app CDA Net CPE',
    sections: [
      {
        title: '1. Titolare del trattamento',
        paragraphs: [
          `${c.name}, ${c.address}${c.vat ? `, P. IVA ${c.vat}` : ''}. Contatti: ${contact}.`,
          c.dpo ? `Responsabile della protezione dei dati (DPO): ${c.dpo}.` : 'Il Titolare non ha nominato un Responsabile della protezione dei dati: per ogni richiesta usa i contatti sopra.',
        ],
      },
      {
        title: '2. Quali dati trattiamo',
        paragraphs: [
          'Dati dell’account: nome utente, ruolo, data e ora degli accessi, indirizzo IP, modello del telefono e versione dell’app.',
          'Dati di lavoro: installazioni, configurazioni delle antenne (CPE), misure radio, test di velocità, foto e note del collaudo, segnalazioni di KO e interventi assegnati, con il loro esito.',
          'Posizione del telefono (GPS): rilevata solo mentre usi le funzioni che ne hanno bisogno (posizione della CPE, AP vicini, bussola e mirino, controllo che il collaudo avvenga entro 500 metri dall’indirizzo dell’intervento). L’app non registra il percorso e non rileva la posizione fuori da queste funzioni né ad app chiusa.',
          'Registro delle attività: le operazioni fatte con l’account, per sicurezza e verifica.',
          'Non trattiamo categorie particolari di dati (art. 9 GDPR) né dati giudiziari.',
        ],
      },
      {
        title: '3. Perché e su quale base',
        paragraphs: [
          'Svolgere gli interventi di installazione e manutenzione della rete e documentarli (collaudo, verbale): esecuzione del contratto o dell’incarico con te (art. 6.1.b GDPR) e obblighi di legge del Titolare come operatore di comunicazioni elettroniche (art. 6.1.c).',
          'Verificare che l’intervento sia fatto all’indirizzo del cliente, organizzare la giornata (promemoria, ritardi) e garantire la qualità del servizio: legittimo interesse del Titolare (art. 6.1.f), bilanciato limitando il GPS ai soli momenti di lavoro descritti sopra.',
          'Sicurezza dell’account e dei sistemi (accessi, registro attività): legittimo interesse del Titolare (art. 6.1.f).',
          'Se sei un lavoratore dipendente, l’app è uno strumento che usi per rendere la prestazione (art. 4, comma 2, L. 300/1970): i dati non sono usati per controlli a distanza dell’attività diversi da quelli previsti dalla legge e dagli accordi applicabili, e sono trattati nel rispetto dell’art. 88 GDPR e dell’art. 114 D.Lgs. 196/2003.',
        ],
      },
      {
        title: '4. Obbligo di fornire i dati',
        paragraphs: ['I dati sono necessari per usare l’app e svolgere gli interventi: senza account, posizione durante l’intervento e dati del collaudo l’app non può essere usata per installazioni e manutenzioni.'],
      },
      {
        title: '5. Per quanto tempo',
        paragraphs: [
          `Installazioni, collaudi, foto e interventi: per la durata del servizio al cliente e poi per i tempi previsti dalla legge (in genere fino a 10 anni per la documentazione fiscale e contrattuale). Registro attività e controlli di posizione: ${c.retentionMonths || 24} mesi. Dati dell’account: fino alla sua disattivazione, poi per i tempi necessari a eventuali contestazioni.`,
        ],
      },
      {
        title: '6. Chi li vede',
        paragraphs: [
          'Il personale autorizzato del Titolare (ufficio, NOC, amministratori) e i fornitori che gestiscono per suo conto i server e i servizi tecnici, nominati responsabili del trattamento (art. 28 GDPR). Gli altri installatori non vedono i tuoi dati. I dati non sono diffusi e non sono trasferiti fuori dallo Spazio economico europeo.',
        ],
      },
      {
        title: '7. I tuoi diritti',
        paragraphs: [
          'Puoi chiedere al Titolare l’accesso ai tuoi dati, la rettifica, la cancellazione, la limitazione, la portabilità e opporti ai trattamenti basati sul legittimo interesse (artt. 15-22 GDPR), scrivendo ai contatti indicati al punto 1.',
          'Puoi proporre reclamo al Garante per la protezione dei dati personali (www.garanteprivacy.it).',
        ],
      },
      {
        title: '8. Sicurezza',
        paragraphs: [
          'Le comunicazioni con il server sono cifrate; le password non sono salvate sul telefono; le credenziali dei clienti restano cifrate sul server. Puoi scollegare in ogni momento i tuoi telefoni da “Il mio account”.',
        ],
      },
    ],
  };
}

/** The text as accepted (plain, stable): its SHA-256 identifies what the user read. */
export function noticeText(c: Controller): string {
  const n = privacyNotice(c);
  return [n.title, ...n.sections.flatMap((s) => [s.title, ...s.paragraphs])].join('\n\n');
}

export const noticeSha256 = (c: Controller) => createHash('sha256').update(noticeText(c), 'utf8').digest('hex');

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Printable attestation kept with the acceptance: who, when, from where, which text. */
export function attestationHtml(a: { id: number; username: string; acceptedAt: string; ip: string; device: string; appVersion: string; sha256: string; version: string }, c: Controller): string {
  const n = privacyNotice(c);
  const when = new Date(a.acceptedAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long', timeStyle: 'medium' });
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Attestazione presa visione informativa privacy · ${esc(a.username)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:780px;margin:32px auto;padding:0 16px;color:#111}h1{font-size:20px}h2{font-size:15px;margin-top:18px}table{border-collapse:collapse;width:100%;margin:12px 0}td{border:1px solid #ccc;padding:6px 8px;vertical-align:top}td:first-child{width:200px;color:#555}.mono{font-family:ui-monospace,monospace;word-break:break-all}.box{border:2px solid #111;padding:12px 16px;margin:16px 0}</style></head><body>
<h1>Attestazione di presa visione e accettazione dell’informativa privacy</h1>
<div class="box"><p>L’utente <b>${esc(a.username)}</b> ha dichiarato, tramite l’app CDA Net CPE, di aver letto e compreso l’informativa sul trattamento dei dati personali riportata sotto e di accettarne le condizioni.</p></div>
<table>
<tr><td>Numero attestazione</td><td>${a.id}</td></tr>
<tr><td>Utente</td><td>${esc(a.username)}</td></tr>
<tr><td>Data e ora</td><td>${esc(when)} (ora italiana) · ${esc(a.acceptedAt)} UTC</td></tr>
<tr><td>Indirizzo IP</td><td>${esc(a.ip)}</td></tr>
<tr><td>Dispositivo e app</td><td>${esc(a.device || '—')} · app ${esc(a.appVersion || '—')}</td></tr>
<tr><td>Versione informativa</td><td>${esc(a.version)}</td></tr>
<tr><td>Impronta SHA-256 del testo</td><td class="mono">${esc(a.sha256)}</td></tr>
<tr><td>Titolare</td><td>${esc(c.name)}</td></tr>
</table>
<h2>Testo accettato</h2>
<h3>${esc(n.title)}</h3>
${n.sections.map((s) => `<h2>${esc(s.title)}</h2>${s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}`).join('\n')}
</body></html>`;
}
