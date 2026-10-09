# Notifiche

## Pagina Notifiche (console e app, v1.32.7)

Ogni utente ha la sua pagina **Notifiche**, con la campanella e il numero da leggere: nella console in alto e nel menu, nell'app nella barra in alto e nella schermata principale. Si conservano 90 giorni.

| Notifica | A chi | Quando |
|---|---|---|
| Provisioning fallito | NOC (tutti gli amministratori) | l'app registra una scrittura fallita (con "tentativo N" se ritentata) |
| Installazione KO o rimandata | NOC | il tecnico usa *Segnala KO*: tipo, fase, motivo, motivazione, giorno per riprovare, segnale |
| Collaudo da approvare | NOC | collaudo con segnale sotto il minimo o un controllo radio rosso |
| Esito dell'approvazione del NOC | chi ha installato e chi ha fatto il collaudo | il NOC approva o rifiuta (con la nota) |
| Installazione attivata dal NOC | chi ha installato | la CPE viene accettata in rete dalla console |

Per ogni tipo l'utente sceglie, nella console in **Notifiche → Anche su Telegram**, se riceverlo anche nella sua chat Telegram personale. Di default l'installatore riceve su Telegram l'esito delle sue installazioni. Le notifiche del NOC vanno di default solo nella pagina, perché arrivano già al gruppo del NOC se configurato.

API: `GET /api/notifications`, `GET /api/notifications/count`, `POST /api/notifications/read` (`{ids}` o `{all:true}`), `GET`/`PUT /api/notifications/prefs`.

# Notifiche Telegram

Console → **Connettori → Telegram**, solo per amministratori. Un solo bot serve sia il gruppo del NOC sia le **notifiche personali** di ogni utente.

## Notifiche personali (tutti gli utenti)

Basta il **token del bot**: incollalo in Connettori → Telegram e salva. Il gruppo del NOC non serve. L'opzione "Ogni utente può collegare il proprio Telegram" è attiva di default, e l'amministratore può spegnerla.

Ogni utente, amministratore o installatore, collega il proprio Telegram:
- dalla console, in **Il mio account → Notifiche Telegram**;
- dall'app, in **Impostazioni** (o in Guasti Enel): **Collega Telegram**, poi nel bot **Avvia** e **Verifica**. In alternativa si inserisce il proprio ID Telegram.

Oggi arrivano i guasti Enel delle proprie zone e dei POP/AP assegnati, per chi ha il modulo Guasti Enel. Se le notifiche non sono disponibili:
- l'amministratore vede cosa manca e dove sistemarlo: bot non configurato, notifiche personali spente o modulo Telegram spento;
- l'installatore vede a chi chiedere.

## Configurazione del gruppo del NOC

1. Su Telegram apri **@BotFather**, comando `/newbot`, e copia il token del bot.
2. Aggiungi il bot al gruppo del NOC e scrivi un messaggio qualsiasi nel gruppo.
3. Nella console incolla il token, premi **Trova chat ID** e scegli il gruppo.
4. Premi **Invia messaggio di prova**, scegli gli eventi, l'ora del riepilogo e salva.

Il token è salvato cifrato con la master key e non viene più mostrato (resta visibile solo l'id del bot). I messaggi partono dal server, al massimo uno al secondo.

Per avere nei messaggi il link alla console imposta nel `.env` l'indirizzo pubblico, per esempio:

```
PUBLIC_URL=https://cpe.cda-net.it
```

Il link apre lo storico già filtrato sul MAC della CPE (`/#/jobs?q=<MAC>`).

## Eventi

| Evento | Quando | Contenuto |
|---|---|---|
| Installazioni da seguire (prima "Provisioning fallito") | scrittura fallita; installazione KO o rimandata; collaudo con segnale pessimo da approvare | installatore, CPE, SSID, fase, motivo e motivazione, segnale, tentativo |
| CPE da accettare in UISP | provisioning riuscito (con UISP configurato) | modello, MAC, SSID, installatore, indicazione se è una sostituzione |
| UISP giù / di nuovo su | controllo ogni 5 minuti, messaggio solo al cambio di stato | — |
| Sicurezza | account bloccato per troppi tentativi; admin che accede da un indirizzo mai usato da quell'account; password di un admin cambiata o reimpostata; utente promosso admin | utente, indirizzo IP |
| Guasti Enel | nuovo guasto o lavoro e-distribuzione in una zona di interesse (o vicino a un AP), e ripristino | tipo (MT/BT/lavoro), località, zona/AP e distanza, clienti, ripristino previsto, mappa |
| Riepilogo serale | ogni giorno all'ora scelta (ora italiana) | installazioni riuscite e fallite, rimandate e KO, collaudi registrati, CPE ancora da accettare in UISP, versione del server |

Ogni provisioning riuscito non genera un messaggio singolo, ma entra nel riepilogo serale.

## Privacy

Telegram è un servizio esterno. I messaggi contengono solo modello, MAC, SSID e nome utente dell'installatore, **mai** nome, indirizzo o posizione del cliente, utente o password PPPoE, chiavi Wi-Fi o credenziali.
