# CDA Net CPE Configurator · Security Policy

Piattaforma interna CDA Net: la usano solo il personale autorizzato e gli Specialist a cui un amministratore crea l'account.

## Repository

- La repository è **pubblica**. Quindi non contiene mai segreti di produzione, dati dei clienti, chat ID, token, chiavi o password, nemmeno nei test o nelle schermate delle guide (solo dati fittizi). I file `*.pem` sono esclusi da `.gitignore`; i certificati pubblici (la radice della CA del server per l'app) entrano solo come `.crt`, mai con la chiave.
- I token finti dei test non devono sembrare veri (es. `000000:token_finto_dei_test_non_un_segreto`), così lo scanner dei segreti di GitHub non li segnala.
- La CI blocca chiavi private e token GitHub riconoscibili (`server.yml` → *Secret scan*); lo scanner dei segreti di GitHub controlla ogni push.
- MFA obbligatoria per chi ha accesso in scrittura. Rivedere periodicamente collaboratori e token.
- Se un segreto finisce nella storia git, rimuovere il file non basta: va **revocato o ruotato** subito, poi si valuta la pulizia della storia.
- Il pacchetto GHCR `cdanet-cpe-server` può restare privato (vedi [docs/DEPLOY.md](docs/DEPLOY.md#repository--pacchetto-privato)).

## Dove stanno i segreti

| Segreto | Dove | Esposto a |
|---|---|---|
| Master key AES-256 | `/etc/cdanet-cpe/secrets/master.key` (root, 0400) | processo server |
| `JWT_SECRET` | `/opt/cdanet-cpe/.env` (0600) | processo server |
| Utente e password admin delle CPE | Impostazioni server, cifrati (valore iniziale dal `.env`) | all'app solo nel pacchetto del job e con `/api/field/access`, cifrati sul telefono |
| Template airOS, community SNMP e chiave UISP di ogni template, chiave Wi-Fi dei template Specialist | DB, cifrati AES-256-GCM, separati dal testo | mai mostrati; solo nel pacchetto del job |
| WPA2 per SSID | DB, cifrate | solo nel pacchetto del job e nel cambio AP (in memoria nell'app); esportazione CSV con la password dell'admin e avviso di sicurezza |
| Password PPPoE, WPA2 e password scritte nel flusso | mai salvate | richiesta → pacchetto del job |
| Token e chiavi dei connettori (UISP e CRM di UISP, ISP Billing, Telegram, Firebase, Victron, MyWic, immagini satellitari, NAS, UISP delle aziende degli Specialist) | DB, cifrati con la master key | mai restituiti alla console (al più le ultime cifre) |
| Token di sessione | in memoria (app), `sessionStorage` o `localStorage` con «Resta connesso» (console) | — |
| Sessione senza Internet, credenziali CPE, configurazioni pronte offline | telefono, cifrate con il Keystore di Android | solo l'app, fino alla scadenza |
| Chiave del telefono (accesso rapido), token MCP | DB solo come hash SHA-256 | — |
| Backup cifrati del database | copia scaricata o NAS, cifrata con la password del backup (scrypt + AES-256-GCM) | chi ha la password |
| Keystore Android | GitHub Secrets + copia offline | CI |

Lo storico (`provisioning_jobs`, `events`) contiene solo metadati: utente RADIUS, MAC, seriale, SSID, modello, fasi ed errori sanificati. Mai password, PSK o configurazioni.

## Controlli applicativi

- **Accesso**: password admin ≥ 14 caratteri, installatori ≥ 12; tempo costante per username inesistenti; limite per utente.
- **Accessi bloccati**, come fail2ban: 5 tentativi falliti in 15 minuti bloccano IP e dispositivo per 30 minuti (24 ore se recidivi), con avviso al NOC. Vedi [docs/ACCESSI-BLOCCATI.md](docs/ACCESSI-BLOCCATI.md).
- **CrowdSec** (facoltativo, dalla console): riconosce scanner ed exploit nel log di Caddy e riceve la lista della comunità; l'app blocca quegli indirizzi su pagine e API, mai le reti fidate, chi è entrato con successo negli ultimi 30 giorni, le eccezioni della console e le sessioni valide. Il log degli accessi non contiene credenziali né header segreti; a CrowdSec vanno solo indirizzo, tipo e ora degli attacchi. Vedi [docs/ACCESSI-BLOCCATI.md](docs/ACCESSI-BLOCCATI.md#crowdsec-v13617).
- **Sessioni**: ogni richiesta verifica account attivo e `token_version`. Disattivazione, reset o cambio della password, cambio di ruolo o della visibilità piena **revocano subito** le sessioni. Durata 8 ore; 30 giorni con la verifica in due passaggi (Impostazioni server, da 1 a 90). «Esci» chiude la sessione anche sul server.
- **Ruoli**: amministratore, installatore, Specialist; uno Specialist senza visibilità piena vede solo il proprio lavoro e quello dei suoi gruppi, mai i dati, le chiavi o la rete di CDA Net. Il server applica le stesse regole del menu. Vedi [docs/SPECIALIST-GRUPPI.md](docs/SPECIALIST-GRUPPI.md).
- **Pacchetto di provisioning**: rilasciato solo a `X-CDA-Client: android/x.y.z` ≥ versione minima, scade e ha `Cache-Control: no-store`. L'app verifica lo SHA-256 della configurazione ed esegue solo comandi costanti (lettura, scrittura, `cfgmtd`, reboot), mai comandi forniti dal server.
- **Target locali** limitati a reti private e CGNAT; scansioni limitate a /24; RouterOS lato server solo su reti private (salvo l'impostazione). Terminale RouterOS in sola lettura (allow/deny list, niente `;`, `[`, `$`), output con le password redatte.
- **Connettori degli Specialist**: raggiungono solo Internet. Il server rifiuta indirizzi privati, CGNAT, locali e riservati anche dietro un nome o un redirect; il test riporta solo esito e stato HTTP.
- **Console**: React, che inserisce il testo come testo (nei popup delle mappe `textContent`); CSP `default-src 'self'; script-src 'self'`. La pagina di consenso di Claude ha la propria CSP.
- **Installatori**: mai il nome delle fonti dati (UISP, ISP Billing…), mai coordinate esatte di POP e AP, codici d'errore tradotti in messaggi neutri.
- **Claude (MCP)**: solo admin con la verifica in due passaggi, OAuth 2.1 con PKCE; la scrittura chiede un secondo codice nuovo, conferma per ogni modifica e al massimo 5 azioni sulla rete all'ora; fuori sblocchi, account, connettori, impostazioni, PPPoE e chiavi Wi-Fi. Vedi [docs/MCP.md](docs/MCP.md).
- **Container** non-root (`node`), `no-new-privileges`, capability minime.

## App Android

- **Server fisso**: l'indirizzo del server è nella build e non si cambia dal telefono; la radice della CA del server è inclusa e vale solo per quel nome.
- **Sessione senza Internet**: dopo ogni contatto con il server la sessione resta sul telefono, cifrata, per le ore impostate (24 di serie, 0 = mai). Un account disattivato, una password cambiata o un telefono perso restano utilizzabili senza Internet fino alla scadenza; al primo contatto l'app cancella sessione, credenziali CPE e configurazioni, e quello che è stato fatto offline entra nel Registro. Vedi [docs/FIELD-TOOLS.md](docs/FIELD-TOOLS.md#sessione-senza-internet).
- **Screenshot bloccati** per installatori e partner (modulo «Screenshot nell'app», spento di serie): l'app blocca screenshot e registrazione dello schermo e l'anteprima nelle app recenti resta nera. Il blocco è attivo anche senza accesso e si toglie solo se il server lo consente per quell'account. Su Android 14+ un tentativo genera un avviso al NOC, che resta sul telefono finché non viene inviato. Gli amministratori possono sempre.
- **Cambio di account** sul telefono: magazzino, intervento aperto e configurazioni preparate del precedente vengono cancellati.

## Rischi residui accettati

- **Host key SSH non verificata** per CPE di fabbrica e RouterOS: i dispositivi di fabbrica non hanno un fingerprint registrato. Compensazione per le CPE: target locale, firmware, board e MAC verificati prima della scrittura. Usare reti di management controllate.
- **Certificato TLS autofirmato della CPE** accettato nell'interfaccia web della CPE dentro l'app, solo per indirizzi privati.
- **Endpoint aggiornamenti pubblico** (`/api/mobile/*`) per poter riparare un'app che non riesce più a fare login.
- **Socket Docker montato nell'updater**: equivale a root sull'host. L'updater esegue solo lo script in `deploy/updater/`, montato in sola lettura, e valida le richieste della console prima di toccare il `.env`.
- **Servizi esterni**: Telegram, Firebase, Anthropic (Claude), MyWic e i fornitori di immagini satellitari ricevono solo quello che serve; per i dati dei clienti letti da Claude serve un accordo sul trattamento dei dati con Anthropic.

## Gate di rilascio

Prima di dichiarare una versione pronta per la produzione:
- CI verde (test server, typecheck, smoke test immagine, installer e2e, aggiornamento, test e build Android);
- APK firmato con la chiave stabile;
- checklist di collaudo hardware in [docs/PROVISIONING.md](docs/PROVISIONING.md) completata sui modelli interessati, e le voci «Da verificare sul campo» della [ROADMAP](docs/ROADMAP.md) per le funzioni nuove.

## Verifica in due passaggi (v1.9.0)

- TOTP standard (RFC 6238, 30 s, 6 cifre), compatibile con Google Authenticator, Microsoft Authenticator e simili. Si attiva da **Il mio account** (password + QR code + primo codice).
- Il segreto è cifrato con la master key. I codici di recupero (8, monouso) sono salvati come hash SHA-256 e mostrati una sola volta.
- Login: la password da sola restituisce solo un token di 5 minuti, valido esclusivamente per il passo del codice e rifiutato come sessione. I codici già usati non sono riutilizzabili (anti-replay). I tentativi sono limitati come per la password.
- Con la verifica in due passaggi la sessione dura 30 giorni (console: «Resta connesso per 30 giorni su questo browser», già spuntata; da togliere su un computer condiviso).
- Un amministratore può rendere il 2FA **obbligatorio per gli admin** (Account → Sicurezza), ma solo dopo averlo attivato sul proprio account. Gli admin senza 2FA vedono solo «Il mio account» finché non lo attivano.
- Telefono perso: un admin può azzerare il 2FA di un account (Account → utente). Le sessioni vengono revocate.
- Attivazioni, disattivazioni, codici di recupero usati, cambi di politica e azzeramenti finiscono nel Registro attività e, se configurate, nelle notifiche Telegram di sicurezza.

## Accesso rapido con impronta o volto (v1.30.0)

- L'app non salva la password. Dopo un accesso completo (password e, se attivo, codice TOTP) il server rilascia una **chiave del telefono**: 32 byte casuali, di cui nel database resta solo l'hash SHA-256.
- Sul telefono la chiave è cifrata con una chiave AES dell'Android Keystore. Con biometria forte (impronta, volto 3D) la chiave del keystore si sblocca solo con il prompt biometrico ed è invalidata se cambiano le impronte registrate. Con biometria debole (lo sblocco col volto della maggior parte dei telefoni) il prompt autorizza l'uso di una chiave che comunque non lascia il keystore.
- L'accesso rapido non richiede di nuovo il codice TOTP: il telefono è stato registrato dopo la verifica in due passaggi e resta legato alla biometria.
- La chiave vale finché non cambia la versione dei token dell'account. È revocata da: «Esci da tutti i dispositivi», cambio password, reset o disattivazione da parte di un admin, revoca dal singolo telefono (Il mio account o Impostazioni dell'app). Al massimo 5 telefoni per account.
- Solo l'app Android (header client) può registrare un telefono o usarne la chiave. Tentativi errati soggetti al blocco degli accessi. Ogni attivazione, uso e revoca finisce nel Registro attività.
- Console web: il browser può salvare le credenziali (Credential Management API). Il gestore password del browser le compila, chiedendo impronta o volto se il dispositivo è configurato così. Le passkey (WebAuthn) richiedono un nome di dominio e non funzionano su un indirizzo IP.
