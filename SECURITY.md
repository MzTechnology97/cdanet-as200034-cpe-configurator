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

## Accesso rapido con impronta o volto (v1.30.0)

- L'app non salva la password. Dopo un accesso completo (password e, se attivo, codice TOTP) il server rilascia una **chiave del telefono**: 32 byte casuali, di cui nel database resta solo l'hash SHA-256.
- Sul telefono la chiave è cifrata con una chiave AES dell'Android Keystore. Con biometria forte (impronta, volto 3D) la chiave del keystore si sblocca solo con il prompt biometrico ed è invalidata se cambiano le impronte registrate. Con biometria debole (lo sblocco col volto della maggior parte dei telefoni) il prompt autorizza l'uso di una chiave che comunque non lascia il keystore.
- L'accesso rapido non richiede di nuovo il codice TOTP: il telefono è stato registrato dopo la verifica in due passaggi e resta legato alla biometria.
- La chiave vale finché non cambia la versione dei token dell'account. È revocata da: "Esci da tutti i dispositivi", cambio password, reset o disattivazione da parte di un admin, revoca dal singolo telefono (Il mio account o Impostazioni dell'app). Al massimo 5 telefoni per account.
- Solo l'app Android (header client) può registrare un telefono o usarne la chiave. Tentativi errati soggetti al limitatore di accesso. Ogni attivazione, uso e revoca finisce nel Registro attività.
- Console web: il browser può salvare le credenziali (Credential Management API). Il gestore password del browser le compila, chiedendo impronta o volto se il dispositivo è configurato così. Le passkey (WebAuthn) richiedono un nome di dominio e non funzionano su un indirizzo IP.
