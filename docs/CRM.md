# CRM: ISP Billing

Console → **Connettori → CRM · ISP Billing**, solo per amministratori. È il collegamento con [ISP Billing](https://ispbilling.it/api/docs): clienti, account RADIUS (ISPRadius 2.0) e profili, servizi, attività e magazzino. Gli installatori non vedono mai questa fonte.

## Configurazione

1. In ISP Billing, **Dashboard → API**, crea una chiave dedicata, per esempio "CDA Net CPE".
   - Dai solo i permessi di lettura che servono: Clienti, ISPRadius 2.0, Servizi, Attività, Magazzino.
   - Se puoi, limita gli IP all'indirizzo pubblico del server CDA Net.
2. Nella console inserisci **Indirizzo** (predefinito `https://ispbilling.it`; va bene anche l'URL della documentazione), **API ID** e **API key**.
3. **Testa connessione** prova i valori del modulo senza salvarli. Fa una lettura per ogni modulo usato dall'integrazione e mostra quelli leggibili, con il numero di record, e quelli bloccati.
4. **Salva**. Lasciando vuota l'API key si mantiene quella salvata.

La chiave è cifrata con la master key, non viene mai restituita dalla console (resta visibile solo l'ultima parte) e non finisce mai nel Registro attività. Modifiche e test sono registrati (`connector.crm.*`).

Le chiamate usano `Authorization: Bearer {api_id}:{api_key}`.

| Esito del test | Significato |
|---|---|
| Chiave non valida | API ID o API key sbagliati (HTTP 401) |
| Permesso mancante (o IP non autorizzato) | La chiave non ha il permesso per quel modulo, oppure l'IP del server non è tra quelli autorizzati della chiave (HTTP 403) |
| Non raggiungibile | Indirizzo, DNS o firewall |

## Stato RADIUS per il NOC

Con il connettore attivo il server copia ogni 10 minuti (prima volta un minuto dopo l'avvio) lo stato RADIUS nella tabella `crm_radius`: tutti gli account ISPRadius con profilo, cliente, gruppo, sospensioni (account `Sospeso`, cliente `suspended`, servizio sospeso) e, per gli account non terminati, la sessione (`/accounts/{id}/status`: online/offline, MAC, IP, durata). Circa un minuto per mille account, quattro letture in parallelo; se una lettura di sessione fallisce resta quella precedente.

- **Salute CPE** (solo amministratori): colonna PPPoE e problemi `pppoe_offline` (CPE online in UISP, sessione giù) e `account_suspended`; la CPE si abbina con il MAC della sessione (≈80% sul campo: le CPE Ubiquiti fanno PPPoE con il MAC che UISP conosce) o con l'utente PPPoE dell'installazione. Riquadro **Account PPPoE** con offline, sospesi e account senza CPE in rete.
- **Stato rete** (solo amministratori): sessioni PPPoE online, offline e sospese delle CPE di ogni AP.
- **Connettori → CRM**: ultima sincronizzazione, conteggi e *Sincronizza stato RADIUS*.

Velocità del piano dal nome del profilo (`CDA-NET-HOME-30-6` → 30/6 Mbit/s).

## Prossimi passi

Decisi con l'utente (vedi la [ROADMAP](ROADMAP.md)):
- preparazione del provisioning: account inesistente → creato in ISP Billing; account sospeso → blocco, notifica al NOC, all'installatore "contatta l'assistenza" con un codice d'errore;
- collaudo: "PPPoE autenticato" obbligatorio (online, MAC della CPE, velocità del profilo), con notifica al NOC e codice d'errore bloccante;
- coordinate delle CPE da UISP scritte nelle anagrafiche e sede di installazione dall'anagrafica;
- attività ISP Billing nell'agenda interventi, seriali del magazzino.
