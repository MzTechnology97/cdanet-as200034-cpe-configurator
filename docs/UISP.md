# Integrazione UISP

UISP è la fonte di AP, POP (site), CPE dei clienti, segnali e backup. Il server lo legge per Copertura, Stato rete, Salute CPE, Guasti Enel e IA-AP. Ci scrive solo su azione di un amministratore: accettazione delle CPE, backup, Gestione CPE e ottimizzazione dei canali di IA-AP.

## Configurazione

Console → **Connettori** (solo amministratori), card **UISP**:
- **Indirizzo UISP**, es. `https://uisp.esempio.it`. Va bene anche l'URL delle API incollato per intero (`…/nms/api/v2.1`): viene ridotto da solo.
- **Token API**: si crea in UISP da **Settings → Users → API tokens**, con permesso di scrittura (serve per accettazione e backup). È salvato cifrato con la master key e non viene più mostrato (solo le ultime 4 cifre). Lasciando il campo vuoto si mantiene quello salvato.
- **Chiave del CRM di UISP** (facoltativa): la chiave app del CRM, cifrata come il token. Serve per creare il **nuovo subscriber** all'accettazione della CPE (vedi sotto).
- **Ignora verifica TLS**: solo se UISP usa un certificato autofirmato e il server lo raggiunge su una rete di gestione fidata.
- **Backup automatico** dopo l'accettazione, **raggio della Copertura** (km, da 1 a 100, predefinito 15) e **cache** dei dati UISP (secondi, predefinita 60).

**Testa connessione** prova i valori del modulo senza salvarli. Mostra versione di UISP, latenza, dispositivi, AP (e quanti con posizione), dispositivi in attesa e site. Con la chiave del CRM legge anche i piani di servizio e dice quanti sono, oppure perché la chiave non va. **Salva** applica subito la configurazione, senza riavviare. Ogni modifica finisce nel Registro attività.

In alternativa restano validi i parametri del `.env` (`sudo cdanet-cpe edit`): `UISP_API_URL`, `UISP_API_TOKEN`, `UISP_IGNORE_TLS`. La configurazione salvata nella console ha la precedenza; **Rimuovi configurazione** torna ai valori del `.env`.

### Dati anche quando UISP non risponde

Gli elenchi letti da UISP (dispositivi, site, AP) restano in memoria per il tempo della cache e sono copiati anche su disco. Se UISP è lento o giù, il server usa l'ultima copia per 30 secondi senza richiamarlo e le pagine mostrano l'età dei dati (`dataAt`). Gli amministratori vedono anche il motivo (`GET /api/uisp/health`, avviso nella cornice della console). Gli installatori non vedono mai il nome della fonte.

### API usate e compatibilità

Le chiamate usano le API **UISP v2.1** (`/nms/api/v2.1`, header `x-auth-token`), verificate sulla specifica ufficiale *UISP API 1.5.0*, che vale anche per **UISP 3.1.x** (in uso la 3.1.65):

| Funzione | Chiamata |
|---|---|
| Test e versione | `GET /nms/version`, `GET /devices`, `GET /sites` |
| AP, CPE, stato e segnali | `GET /devices` (ruolo, `authorized`, `attributes.ssid`, `attributes.apDevice`, `location`), statistiche del dispositivo |
| Posizione dei site | `GET /sites` (`description.location`) |
| Accettazione CPE in attesa | `POST /devices/{id}/authorize` con `{ "siteId": … }` |
| Backup | `GET`/`POST /devices/{id}/backups`, `GET /devices/{id}/backups/{backupId}` (per airMAX è il `.cfg`) |
| Gestione CPE | riavvio, aggiornamento firmware, ripristino di un backup, parametri wireless, alias, note e manutenzione |
| CRM (nuovo subscriber) | piani di servizio, clienti e servizi del CRM (`/crm/api/v1.0`, chiave app) |

Gli endpoint dei profili AP non vengono usati perché espongono le chiavi Wi-Fi. La documentazione Swagger della vostra installazione è su `https://<uisp>/nms/api-docs`.

Gli AP sono i dispositivi con ruolo AP. I collegamenti punto-punto (SSID dei PtP) sono esclusi da Copertura, Trova l'AP, Stato rete e Salute CPE.

## Posizione della CPE

Nell'installazione la posizione viene dall'intervento, dal GPS del telefono (funziona anche senza rete) o da un indirizzo cercato con il geocoder del server (Nominatim locale, vedi [DEPLOY.md](DEPLOY.md#openstreetmap-locale-ricerca-indirizzi), con i civici ANNCSU dove la via non basta). La posizione:
- è salvata nello storico, con precisione e origine;
- è scritta nella CPE (`system.latitude` e `system.longitude` di airOS), così UISP la mostra al posto giusto.

## Copertura e AP vicini

La verifica di copertura, gli AP consigliati dell'installazione e Trova l'AP partono dagli AP di UISP: posizione del dispositivo o, se manca, del suo site; clienti collegati, segnali e carico serale per la stima. Gli installatori vedono solo i POP e gli AP assegnati. Tutto è descritto in [COPERTURA.md](COPERTURA.md); le mappe in [MAPPE.md](MAPPE.md).

## Storico provisioning → UISP

Nel dettaglio di un'installazione la sezione **UISP**:
- trova la CPE in UISP per MAC e ne mostra lo stato: in attesa o accettata, online, segnale, AP agganciato, site e firmware;
- con **Statistiche** mostra l'andamento del segnale (anche nell'app).

### Accettazione della CPE

L'accettazione si fa a **collaudo superato** (o approvato dal NOC): l'avviso «CPE pronta da accettare in UISP» arriva in quel momento, una sola volta per installazione. Una CPE che UISP ha già autorizzato (per esempio una CPE installata prima dell'app e registrata nel ripuntamento) non genera l'avviso.

- **Senza la chiave del CRM**: **Accetta in UISP** (solo amministratori) autorizza la CPE nel site dell'AP a cui è agganciata. Se l'AP non è ancora noto usa l'AP più vicino che trasmette l'SSID dell'installazione; se non si può determinare, l'amministratore sceglie il site.
- **Con la chiave del CRM**: la CPE si accetta solo con **Nuovo subscriber**, cioè entra in UISP insieme al cliente e al servizio:
  - nome e cognome (o ragione sociale) vengono dal CRM di ISP Billing o dall'utente PPPoE; indirizzo e posizione dall'installazione;
  - il **piano** è già scelto dal profilo PPPoE del cliente in ISP Billing (es. `CDA-NET-HOME-25-5` → «CDA NET HOME 25/5»); senza corrispondenza lo sceglie il NOC. L'elenco mostra solo i piani dell'organizzazione predefinita del CRM;
  - il server crea il cliente e il servizio, aspetta il site del servizio e vi autorizza la CPE;
  - se il servizio fallisce dopo la creazione del cliente, il cliente resta (nel CRM non si cancella nulla) ed è legato all'installazione: il nuovo tentativo crea solo il servizio, mai un secondo cliente. Lo stesso vale per un cliente creato con la risposta persa.

Nessuna CPE viene accettata senza questo pulsante. Dopo l'accettazione parte un **backup** automatico, se attivo. **Backup ora** e l'elenco dei backup, scaricabili dalla console, stanno nella stessa sezione. Accettazioni, subscriber e backup finiscono nel **Registro attività**.

## Gestione CPE

Da Salute CPE, «Gestisci» apre una CPE di un cliente come nell'app di UISP (console e app, amministratori e direttore tecnico):
- dettaglio, interfacce, radio, firmware, cliente di ISP Billing (account RADIUS per MAC o utente PPPoE) e sede;
- azioni: aggiorna i dati, riavvio, aggiornamento del firmware all'ultima versione, backup e ripristino di un backup, parametri wireless (letti dalla CPE e riscritti con i soli valori cambiati), alias, note e manutenzione.

Solo CPE dei clienti: AP e collegamenti PtP non si gestiscono da qui. Ogni azione finisce nel Registro attività.

## Configurazione rispetto al template

Storico → installazione → UISP → **Confronta con il template** (solo amministratori). Il server prende l'ultimo backup UISP della CPE e lo confronta con la configurazione che CDA Net le aveva applicato: template dell'installazione, dati dell'installazione (SSID, utente PPPoE, nome, porte, LAN, DHCP…) e regole forzate (posizione, nome di sistema).

Per ogni chiave diversa mostra il valore atteso e quello trovato sulla CPE. In più:
- le chiavi segrete (chiave WPA2, credenziali CPE, community SNMP, chiave UISP) vengono confrontate ma **mai mostrate**: risultano solo «segreto diverso»;
- password PPPoE e hash della password CPE non sono confrontabili (CDA Net non conserva la prima, la seconda ha un sale casuale);
- vengono contate le chiavi presenti sulla CPE ma non nel template.

Serve a scoprire modifiche fatte a mano sulla CPE (potenza, canale, utente PPPoE, SNMP disattivato…). Per un confronto aggiornato premi prima **Backup ora**. Ogni confronto finisce nel Registro attività.

## Specialist

Gli Specialist collegano l'UISP della propria azienda in **I miei connettori**, cifrato e separato da quello di CDA Net. Quei connettori raggiungono solo Internet, mai la rete di CDA Net. Vedi [SPECIALIST-GRUPPI.md](SPECIALIST-GRUPPI.md).
