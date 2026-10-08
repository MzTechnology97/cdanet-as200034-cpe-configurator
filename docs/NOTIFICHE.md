# Notifiche Telegram

Console → **Connettori → Telegram (notifiche NOC)**, solo per amministratori.

## Configurazione

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
| Riepilogo serale | ogni giorno all'ora scelta (ora italiana) | installazioni riuscite e fallite, collaudi registrati, CPE ancora da accettare in UISP, versione del server |

Ogni provisioning riuscito non genera un messaggio singolo, ma entra nel riepilogo serale.

## Privacy

Telegram è un servizio esterno. I messaggi contengono solo modello, MAC, SSID e nome utente dell'installatore, **mai** nome, indirizzo o posizione del cliente, utente o password PPPoE, chiavi Wi-Fi o credenziali.
