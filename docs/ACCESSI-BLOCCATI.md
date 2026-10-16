# Accessi bloccati (come fail2ban)

La piattaforma registra ogni tentativo di accesso: dalla console web, dall'app e dal connettore Claude. Ogni tentativo vale, sia con la password, sia con il codice della verifica in due passaggi, sia con l'accesso rapido del telefono, sia con il consenso di Claude. Dopo **5 tentativi falliti in 15 minuti** blocca l'IP e il dispositivo da cui arrivano.

## Regole

- Il blocco dura **30 minuti**. Se lo stesso IP o dispositivo viene bloccato di nuovo entro 24 ore, dura **24 ore**.
- **Blocco per IP.** Vale solo per gli accessi e per le richieste senza una sessione valida. Chi è già collegato dallo stesso IP continua a lavorare. Serve perché molti installatori escono su Internet con lo stesso IP del gestore mobile (CGNAT): uno che sbaglia la password non deve fermare i colleghi.
- **Blocco per dispositivo.** Blocca tutto da quel dispositivo, anche con una sessione aperta. L'app manda un proprio identificativo, `X-CDA-Device`: un UUID casuale creato all'installazione, che non è un dato del telefono. **Lo sceglie il dispositivo**, quindi chi attacca può cambiarlo a ogni tentativo. Ferma un'app o un PC che sbagliano in continuazione, non un attaccante: contro la forza bruta conta il blocco per IP.
- **Mai bloccati per IP:**
  - il server stesso (loopback);
  - le reti private: i container, le LAN interne e la rete del gestore (CGNAT 100.64.0.0/10);
  - gli indirizzi in `LOGIN_BAN_IGNORE` del file `.env`, separati da spazio o virgola, IP o CIDR, per esempio l'ufficio.

  Per loro resta il limite di 10 tentativi per utente in 10 minuti.
- L'IP considerato è quello vero del client. `X-Forwarded-For` vale solo se arriva dal proxy della piattaforma (Caddy, `TRUST_PROXY`), e Caddy sovrascrive quello che manda un client esterno.
- Durante il blocco, la risposta è `429 {"error":"banned","until":"…"}` con `Retry-After`.
- Ogni blocco manda un avviso di sicurezza al NOC (Telegram) e finisce nel Registro: `auth.ban`, `auth.unban`.
- Il registro dei tentativi si tiene 90 giorni. Contiene ora, IP, dispositivo, utente tentato, canale (web, app, claude), tipo ed esito, **mai la password**.

## Console

- `GET /api/admin/bans`: blocchi in corso e passati, con `lastAttemptAt`, gli utenti tentati e i flag `active` / `expired`.
- `DELETE /api/admin/bans/:id`: sblocca subito.
- `GET /api/admin/login-attempts?failed=1&ip=&username=&limit=`: il registro dei tentativi.
