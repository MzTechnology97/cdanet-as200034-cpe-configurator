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
| Provisioning fallito | l'app registra un esito fallito | installatore, modello e MAC, SSID, ultima fase, errore |
| CPE da accettare in UISP | provisioning riuscito (con UISP configurato) | modello, MAC, SSID, installatore, indicazione se è una sostituzione |
| UISP giù / di nuovo su | controllo ogni 5 minuti, messaggio solo al cambio di stato | — |
| Sicurezza | account bloccato per troppi tentativi; admin che accede da un indirizzo mai usato da quell'account; password di un admin cambiata o reimpostata; utente promosso admin | utente, indirizzo IP |
| Guasti Enel | nuovo guasto o lavoro e-distribuzione in una zona di interesse (o vicino a un AP), e ripristino | tipo (MT/BT/lavoro), località, zona/AP e distanza, clienti, ripristino previsto, mappa |
| Riepilogo serale | ogni giorno all'ora scelta (ora italiana) | installazioni riuscite e fallite, collaudi registrati, CPE ancora da accettare in UISP, versione del server |

Ogni provisioning riuscito non genera un messaggio singolo, ma entra nel riepilogo serale.

## Privacy

Telegram è un servizio esterno. I messaggi contengono solo modello, MAC, SSID e nome utente dell'installatore, **mai** nome, indirizzo o posizione del cliente, utente o password PPPoE, chiavi Wi-Fi o credenziali.
