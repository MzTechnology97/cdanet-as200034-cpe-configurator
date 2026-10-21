# Notifiche

## Pagina Notifiche (console e app)

Ogni utente ha la sua pagina **Notifiche**, con la campanella e il numero da leggere: nella console in alto e nel menu, nell'app nella barra in alto. Si eliminano una per una, le lette o tutte (con conferma); ognuno elimina solo le proprie. Dopo 14 giorni si cancellano da sole.

| Notifica | A chi | Su Telegram di serie |
|---|---|---|
| Provisioning fallito | NOC (tutti gli amministratori) | no |
| Installazione KO o rimandata | NOC | no |
| Collaudo con segnale pessimo da approvare | NOC | no |
| Esito dell'approvazione del NOC | chi ha installato e chi ha fatto il collaudo | sì |
| Installazione attivata dal NOC | chi ha installato | sì |
| Intervento assegnato o modificato | installatore | sì |
| Promemoria degli interventi (24 h, 2 h, 1 h e 30 minuti prima) | installatore | sì |
| Intervento in ritardo o non fatto | installatore | sì |
| Interventi in ritardo o non fatti, posizione non corrispondente | NOC | sì |
| Assistente rete: nuovi problemi critici su AP e CPE (IA-AP, al massimo una volta alla settimana per avviso) | NOC | no |
| IA-AP: esito delle ottimizzazioni automatiche | NOC | sì |
| Tentativi di screenshot nell'app (screenshot o registrazione, con l'ora se l'avviso arriva in ritardo) | NOC | sì |
| CPE installata che non risulta nel magazzino dell'installatore | NOC | no |
| Magazzino di un installatore sotto il minimo | NOC | sì |
| Ripuntamento senza intervento (anche di CPE installate da altri) | NOC | sì |
| Salute piattaforma: un servizio si è fermato o è ripartito | NOC | no (va già al gruppo come «Servizi giù / di nuovo su») |
| Avvisi proattivi: segnale delle CPE in calo, AP vicini alla saturazione, batteria critica di un POP | NOC | sì |

Per ogni tipo l'utente sceglie, in **Notifiche → Anche su Telegram**, se riceverlo anche nella sua chat Telegram personale. Le notifiche del NOC che arrivano già al gruppo del NOC partono di serie solo nella pagina.

API: `GET /api/notifications`, `GET /api/notifications/count`, `POST /api/notifications/read` (`{ids}` o `{all:true}`), eliminazione, `GET`/`PUT /api/notifications/prefs`.

## Notifiche nell'app ad app chiusa

- **Con Firebase** (Connettori → **Firebase**: service account e `google-services.json`, la chiave resta cifrata sul server) l'app riceve le notifiche push di Firebase. Se arriva un push e l'app non trova nulla di nuovo tra le Notifiche del server, mostra comunque il messaggio. «Invia notifica di prova» la mostra subito. I rifiuti di Firebase finiscono nel log del server.
- **Senza Firebase** l'app resta collegata al server da sola, con una notifica fissa e silenziosa «CDA Net: notifiche attive».

Il passaggio dall'una all'altra è automatico a ogni accesso. Su Android 13+ l'app chiede il permesso di notifica. I guasti Enel delle proprie zone hanno anche il loro controllo ogni 15 minuti (vedi [GUASTI-ENEL.md](GUASTI-ENEL.md#notifiche)).

# Notifiche Telegram

Console → **Connettori → Telegram**, solo per amministratori. Un solo bot serve sia il gruppo del NOC sia le **notifiche personali** di ogni utente.

## Notifiche personali (tutti gli utenti)

Basta il **token del bot**: incollalo in Connettori → Telegram e salva. Il gruppo del NOC non serve. L'opzione «Ogni utente può collegare il proprio Telegram» è attiva di serie e l'amministratore può spegnerla.

Ogni utente collega il proprio Telegram:
- dalla console, in **Il mio account → Notifiche Telegram**;
- dall'app, in **Impostazioni** (o in Guasti Enel): **Collega Telegram**, poi nel bot **Avvia** e **Verifica**. In alternativa si inserisce il proprio ID Telegram.

Arrivano le notifiche scelte in «Anche su Telegram» (tabella sopra) e, per chi ha il modulo Guasti Enel, i guasti delle proprie zone e dei POP/AP assegnati. Se le notifiche non sono disponibili:
- l'amministratore vede cosa manca e dove sistemarlo: bot non configurato, notifiche personali spente o modulo Telegram spento;
- l'installatore vede a chi chiedere.

## Configurazione del gruppo del NOC

1. Su Telegram apri **@BotFather**, comando `/newbot`, e copia il token del bot.
2. Aggiungi il bot al gruppo del NOC e scrivi un messaggio qualsiasi nel gruppo.
3. Nella console incolla il token, premi **Trova chat ID** e scegli il gruppo.
4. Premi **Invia messaggio di prova**, scegli gli eventi, l'ora del riepilogo e salva.

Il token è salvato cifrato con la master key e non viene più mostrato (resta visibile solo l'id del bot). I messaggi partono dal server, al massimo uno al secondo; il bot sa inviare anche file (il PDF del report mensile).

Per avere nei messaggi il link alla console imposta l'indirizzo pubblico in Impostazioni server → Provisioning e app (`PUBLIC_URL`). Il link apre lo storico già filtrato sul MAC della CPE (`/#/jobs?q=<MAC>`).

## Eventi del gruppo

| Evento | Quando |
|---|---|
| Installazioni da seguire | provisioning fallito, installazione KO o rimandata (con il motivo), collaudo con segnale pessimo da approvare |
| CPE da accettare in UISP | collaudo superato o approvato dal NOC, una sola volta per installazione, con il link allo storico; mai per una CPE già autorizzata in UISP |
| Servizi giù / di nuovo su | UISP, ISP Billing, magazzino, guasti Enel, Victron, backup sul NAS e spazio su disco: controllo ogni 5 minuti, messaggio solo al cambio di stato |
| Sicurezza | account o IP bloccato per troppi tentativi; amministratore da un indirizzo nuovo; password di un amministratore o di uno Specialist cambiata o reimpostata; utente promosso amministratore o reso Specialist; nuovo Specialist; verifica in due passaggi attivata, disattivata, azzerata o resa obbligatoria; chiavi WPA2 esportate in chiaro; Claude collegato e ogni sua modifica; gruppi di lavoro creati o cambiati |
| Guasti Enel | nuovo guasto o lavoro e-distribuzione in una zona di interesse o vicino a un AP, e ripristino; batteria critica e rientro dei POP |
| Riepilogo serale e report mensile | ogni sera all'ora scelta (ora italiana): installazioni riuscite e fallite, rimandate e KO, collaudi, CPE ancora da accettare, versione del server. Il 1° del mese alle 8 il report del mese finito, testo e PDF |

Un provisioning riuscito non genera un messaggio singolo: entra nel riepilogo serale.

## Privacy

Telegram è un servizio esterno. I messaggi sulle installazioni contengono solo modello, MAC, SSID e nome utente dell'installatore. **Mai** indirizzo o posizione del cliente, utente o password PPPoE, chiavi Wi-Fi o credenziali. Il nome del cliente compare solo dove serve a chi lo riceve: negli avvisi sugli interventi (all'installatore assegnato e al NOC) e, come nome della CPE, nei cali di segnale degli avvisi proattivi al NOC.
