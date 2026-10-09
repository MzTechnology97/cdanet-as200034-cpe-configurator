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

## Stato

Per ora c'è solo il connettore con il test della chiave: nessun dato viene letto o scritto durante il lavoro normale. Le integrazioni previste sono nella [ROADMAP](ROADMAP.md):
- utente PPPoE ↔ account RADIUS, cliente e profilo;
- stato RADIUS nel collaudo e in Salute CPE;
- account RADIUS creato dal server;
- stato, campi personalizzati e coordinate del cliente scritti dopo il collaudo;
- attività ISP Billing nell'agenda interventi;
- seriali del magazzino.
