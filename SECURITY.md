# CDA Net CPE Configurator · Security Policy

Materiale interno CDA Net, accessibile solo al personale autorizzato.

## Repository

- La repository **deve essere privata**. GitHub Pages e qualsiasi distribuzione pubblica dei sorgenti vanno tenuti disattivati.
- Valutare visibilità **privata** anche per il pacchetto GHCR `cdanet-cpe-server` (vedi [docs/DEPLOY.md](docs/DEPLOY.md) per l'accesso del server).
- MFA obbligatoria per chi ha accesso. Rivedere periodicamente collaboratori e token.
- Nessun segreto di produzione nei commit. Se un segreto finisce nella storia git, rimuovere il file non basta: va **revocato/ruotato** subito, poi si valuta la pulizia della storia.
- La CI blocca chiavi private e token GitHub riconoscibili (`server.yml` → *Secret scan*).

## Dove stanno i segreti

| Segreto | Dove | Esposto a |
|---|---|---|
| Master key AES-256 | `/etc/cdanet-cpe/secrets/master.key` (root, 0400) | processo server |
| `JWT_SECRET`, `CPE_ADMIN_PASSWORD`, `UISP_ENROLLMENT`, `SNMP_COMMUNITY` | `/opt/cdanet-cpe/.env` (0600) | processo server; la password CPE arriva all'app solo nel pacchetto del job |
| WPA2 per SSID, template airOS | DB, cifrati AES-256-GCM | solo nel pacchetto del job (in memoria nell'app) |
| Password PPPoE | mai salvata | richiesta → pacchetto del job |
| Token di sessione | solo in memoria (app) / `sessionStorage` (console) | — |
| Keystore Android | GitHub Secrets + copia offline | CI |

Lo storico (`provisioning_jobs`, `events`) contiene solo metadati: utente RADIUS, MAC, seriale, SSID, modello, fasi ed errori sanificati. Mai password, PSK o configurazioni.

## Controlli applicativi

- Login con rate limit e tempo costante per username inesistenti. Password admin ≥ 14 caratteri, installatori ≥ 12.
- Ogni richiesta verifica account attivo e `token_version`: disabilitazione, reset password o cambio ruolo **revocano subito** le sessioni.
- Il pacchetto di provisioning è rilasciato solo a `X-CDA-Client: android/x.y.z` ≥ `MIN_ANDROID_VERSION`, scade (`PROVISION_JOB_TTL_MINUTES`) e ha `Cache-Control: no-store`.
- L'app verifica lo SHA-256 della configurazione ed esegue solo comandi costanti (lettura, scrittura, `cfgmtd`, reboot). Non esegue comandi forniti dal server.
- Target locali limitati a reti private/CGNAT; scansioni limitate a /24; RouterOS lato server solo su reti private (salvo `ROUTEROS_ALLOW_PUBLIC=1`).
- Terminale RouterOS in sola lettura (allow/deny list, niente `;`, `[`, `$`); output con le password redatte.
- Console web con CSP `default-src 'self'` senza inline e rendering via `textContent` (nessun HTML costruito dai dati).
- Container non-root (`node`), `no-new-privileges`, capability minime.

## Rischi residui accettati

- **Host key SSH non verificata** per CPE factory e RouterOS: i dispositivi factory non hanno un fingerprint registrato. Compensazione per le CPE: target locale, firmware, board e MAC verificati prima della scrittura. Usare reti di management controllate.
- **Certificato TLS self-signed della CPE** accettato nel WebView di primo avvio, solo per l'IP factory del job.
- **Endpoint aggiornamenti pubblico** (`/api/mobile/*`) per poter riparare un'app che non riesce più a fare login. Se il server è esposto su Internet, valutare di limitarlo alla rete CDA Net/VPN.
- **Socket Docker montato nell'updater**: equivale a root sull'host. L'updater esegue solo lo script in `deploy/updater/`, montato in sola lettura.

## Gate di rilascio

Prima di dichiarare una versione pronta per la produzione:
- CI verde (test server, typecheck, smoke test immagine, test e build Android);
- APK firmato con la chiave stabile;
- checklist di collaudo hardware in [docs/PROVISIONING.md](docs/PROVISIONING.md) completata sui modelli interessati.

## Verifica in due passaggi (v1.9.0)

- TOTP standard (RFC 6238, 30 s, 6 cifre), compatibile con Google Authenticator, Microsoft Authenticator e simili. Si attiva da **Il mio account** (password + QR code + primo codice).
- Il segreto è cifrato con la master key. I codici di recupero (8, monouso) sono salvati come hash SHA-256 e mostrati una sola volta.
- Login: la password da sola restituisce solo un token di 5 minuti, valido esclusivamente per il passo del codice e rifiutato come sessione. I codici già usati non sono riutilizzabili (anti-replay). I tentativi sono limitati come per la password.
- Un amministratore può rendere il 2FA **obbligatorio per gli admin** (Account → Sicurezza), ma solo dopo averlo attivato sul proprio account. Gli admin senza 2FA vedono solo "Il mio account" finché non lo attivano.
- Telefono perso: un admin può azzerare il 2FA di un account (Account → utente). Le sessioni vengono revocate.
- Attivazioni, disattivazioni, codici di recupero usati, cambi di politica e azzeramenti finiscono nel Registro attività e, se configurate, nelle notifiche Telegram di sicurezza.
