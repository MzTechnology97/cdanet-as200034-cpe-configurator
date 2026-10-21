# Architettura v1

## Perché la riscrittura

La v0.5.x aveva:
- il codice Android generato in CI da heredoc dentro `android-apk.yml`;
- un backend minificato a mano;
- la stessa logica (rendering `system.cfg`, policy, RouterOS, SNMP) copiata in Java, nel Web Bridge e nel backend.

La PWA senza APK o Web Bridge non poteva fare quasi nulla. La v1 concentra la logica nel server e lascia ai client solo ciò che deve per forza essere eseguito in LAN.

## Server (`server/`)

Node.js 24 esegue TypeScript direttamente (type stripping): non c'è uno step di build e `tsc` serve solo come typecheck. Componenti: Fastify 5, `node:sqlite` (nessuna dipendenza nativa), zod, jose (JWT HS256), ssh2. Nessuna libreria per PDF, ZIP, TIFF o tessere vettoriali: sono scritti nel server (`services/pdf.ts`, `zip.ts`, `tiff.ts`, `domain/mvt.ts`, `domain/pmtiles.ts`).

| Cartella | Contenuto |
|---|---|
| `config.ts`, `context.ts` | Validazione dell'ambiente (zod), che fallisce all'avvio con un messaggio chiaro; il contesto condiviso dai moduli. |
| `db.ts` | Migrazioni con `PRAGMA user_version` (circa 50: dalla 1, che adotta lo schema v0.5.x, alla 49 della v1.36.4). |
| `crypto.ts` | AES-256-GCM per i segreti (formato compatibile con v0.5), scrypt per le password, MD5-crypt per `users.N.password`. |
| `auth.ts` | JWT con `token_version`: disattivare un account, cambiarne password o ruolo revoca subito le sessioni. Ruoli `admin`, `installer`, `specialist` (con `full_view`); `requireAdmin`, `requireStaff`, `requireSeesAll`, `requireCdaWork`. |
| `domain/` | Logica pura e testata: policy e modelli, `system.cfg` e modulo dei template (`systemcfg.ts`, `airos-form.ts`, `specialist-cfg.ts`), salute CPE, modello di copertura e linea di vista (`coverage-model.ts`, `los.ts`), carico degli AP, ottimizzatore e IA-AP, ruoli (`roles.ts`), TOTP, CSV, confronto con il template. |
| `services/` | I servizi con stato: provisioning e template, UISP e CRM di UISP, ISP Billing (CRM e magazzino), terreno, edifici, alberi e antenne, guasti Enel, Victron, MyWic, notifiche (pagina, Telegram, Firebase), avvisi proattivi, salute della piattaforma, backup sul NAS, report mensile, diagnosi, blocco degli accessi, strumenti MCP, eventi in tempo reale. |
| `routes/` | Le API, un file per area (vedi sotto). |
| `net/` | Strumenti lato server: ping, traceroute, DNS, scansione /24, SNMP BER, NetBIOS, ONVIF/SADP, porte, BGP, produttore dei MAC, RouterOS via SSH. |
| `guide-admin/` | La guida amministratore, servita solo agli account autorizzati (non sta in `web/`). |

I test (`npm test`, oltre 330) coprono dominio, API e flussi completi con server finti di UISP, ISP Billing, Telegram, WIC e smbclient. Un test d'oro confronta la configurazione generata con quella della v1.35.10.

### API

Tutte sotto `/api`, tranne il connettore MCP (`/mcp`, `/.well-known/oauth-*`, `/oauth/*`) e le tessere della mappa (`/map/*`). Un modulo spento risponde `404 module_disabled` (vedi [MODULI.md](MODULI.md)).

| Area | Percorsi | Chi |
|---|---|---|
| Pubbliche | `/api/health`, `/api/auth/login`, `/api/auth/login/totp`, `/api/auth/device-login`, `/api/mobile/update`, `/api/mobile/apk` | pubblico, con limiti e blocco degli accessi |
| Account | `/api/auth/*` (me, sessioni, verifica in due passaggi, accesso rapido, scorciatoie), `/api/meta` | utente |
| Provisioning | `/api/provisioning/plan`, `/jobs`, `/jobs/:id/result`, `/templates`, collaudo, foto, rapporto PDF, `/api/wireless-networks`, sostituzione | utente (installazioni CDA Net: `requireCdaWork`); il pacchetto del job solo all'app (`X-CDA-Client: android/x.y.z` ≥ versione minima) |
| Campo | `/api/field/*` (credenziali della CPE, ripuntamento, registrazione di una CPE, eventi offline, diagnosi dell'intervento), `/api/speedtest*`, `/api/firmware/*` | utente |
| Interventi | `/api/work-orders/*`, `/api/admin/work-orders*` | utente (i propri), amministratori |
| Copertura | `/api/coverage`, `/api/coverage/link`, `/api/pointing/*`, `/api/saved-checks*`, `/api/geocode*`, `/api/admin/coverage/simulation`, `/api/admin/feasibility*` | modulo Copertura, con limiti per ruolo |
| Rete | `/api/network/status`, `/api/cpe-health*`, `/api/outages/*`, `/api/notifications/*`, `/api/events` (SSE) | utente, per modulo |
| Specialist | `/api/specialist/*` (template, connettori, flusso, storico, gruppi) | Specialist |
| Amministrazione | `/api/admin/*`: account, gruppi di lavoro, template, reti Wi-Fi, firmware, connettori, impostazioni, moduli, UISP, CPE, IA-AP, magazzino, statistiche e report, terreno e antenne, accessi bloccati, MCP, privacy, salute piattaforma e backup, NAS, Registro | amministratori; le viste dei dati di CDA Net anche al direttore tecnico (`requireSeesAll`) |
| Strumenti | `/api/tools/*`, `/api/routeros/*` | utente (dalla rete di CDA Net: `requireCdaWork`) |

### Pacchetto del job (solo all'app, `Cache-Control: no-store`)

```json
{
  "jobId": "uuid", "expiresAt": "…",
  "target": {"host": "192.168.172.1", "sshPort": 22},
  "credentials": {"username": "…", "password": "…"},
  "checks": {"firmware": "8.7.4", "boardMatch": "…", "mac": "AA:BB:…"},
  "config": {"path": "/tmp/system.cfg", "text": "…", "sha256": "…"},
  "summary": {…}, "afterApply": {"lanIp": "…", "httpPort": 20080, "httpsPort": 20443}
}
```

Il client non esegue comandi forniti dal server: lettura, scrittura e `cfgmtd` sono costanti nell'app. `afterApply` viene dal template (`templateFacts`).

### Dati

Le tabelle principali: `users` (con `full_view` e i moduli per utente), `wireless_secrets` (cifrate), `provision_profiles` (template cifrati, con `params_json` e `secrets_ciphertext`), `provisioning_jobs` (solo metadati: niente password, niente configurazioni), collaudi, foto e speedtest, `work_orders`, interventi e loro cronologia, `events` (Registro attività), tentativi di accesso e blocchi, notifiche, gruppi di lavoro, verifiche salvate, copie di ISP Billing (`crm_radius`, `crm_customers`, `crm_addresses`, magazzino), stato degli avvisi e `settings`. La retention `GDPR_AUDIT_RETENTION_DAYS` (Impostazioni server → Conservazione) si applica a installazioni, eventi e audit.

## Console web (`console/` e `web/`)

La console è un'applicazione React 19 in TypeScript (`console/`), compilata con Vite in `web/app` e servita dal server: `/` e ogni indirizzo della console rispondono con `web/app/index.html`, `/map-embed.html` (la mappa dentro l'app Android) con `web/app/map-embed.html`, i file con l'hash nel nome stanno sotto `/app/assets/` con cache di un anno. In `web/` restano solo i file serviti così come sono (`vendor/` con Leaflet, Protomaps e MapLibre, `assets/`, `wiki/`) e `web/index.html`, l'avviso mostrato quando la build manca (un checkout di sviluppo). La CSP ammette solo script del server (`script-src 'self'`).

- **Cornice** (`console/src/shell`): menu, barra in basso sul telefono, ricerca globale (Ctrl+K), tema chiaro/scuro, avviso quando UISP non risponde. Le pagine (`routes.ts`) si caricano quando si aprono, con le stesse regole di visibilità del server (admin, installatori, moduli).
- **Design system** (`console/src/styles/tokens.css`, `ui.css`, `console/src/ui`): colori, spaziature e tipografia come token, gli stessi nei due temi; componenti comuni (pulsanti, schede, tabelle che sul telefono diventano schede, pannelli laterali, segmenti, statistiche). Nessuna pagina definisce stili propri fuori da `ui.css`.
- **Dati**: TanStack Query, condivisi tra le pagine e rinfrescati dagli eventi del server (`/api/events`, Server-Sent Events) in `console/src/lib/live.ts`. Il client API è `console/src/lib/api.ts` (token, errori in italiano e neutri per gli installatori, scadenza della sessione).
- **Mappe** (`console/src/map/`): `MapView.tsx`, un solo componente per ogni pagina con mappa, sopra `leaflet.ts` (Leaflet, mappa di base locale, viste admin); la vista 3D in `map3d.tsx` (MapLibre, con barra e legenda in React). Le stesse funzioni disegnano la mappa dentro l'app Android (`console/src/map-embed.ts`, pagina `/map-embed.html`).
- Il testo passa sempre da React (o da `textContent` nei popup delle mappe), che lo protegge dall'inserimento di markup.

## App Android (`android/`)

Kotlin 2.0 e Compose Material 3, minSdk 26, targetSdk 35, un solo modulo `:app`. Il server è fisso nella build (`DEFAULT_BACKEND_URL`, di serie `https://app.cda-net.it`) con la radice della sua CA inclusa.

| Package | Contenuto |
|---|---|
| `core` | `AppContainer` (dipendenze e stato condiviso: sessione, moduli, campo, coda), blocco degli screenshot e segnalazione dei tentativi. |
| `data` | `ApiClient` (OkHttp + kotlinx.serialization, errori in italiano), `Session` (token in memoria, `isStaff`, `seesAll`, `doesCdaWork`), `ResultQueue` (coda persistente degli esiti, senza segreti), modelli, verifiche salvate, Specialist. |
| `security` | `SecureStore` (cifratura con il Keystore), sessione senza Internet (`OfflineSession`, `OfflineLog`), accesso rapido con impronta o volto. |
| `network` | `NetworkHelper.onWifi { … }` lega il traffico alla Wi-Fi della CPE anche senza Internet, mentre il server resta sulla rete mobile; GPS. |
| `install` | Il percorso guidato (`InstallController`, passi da Configurazione a Collaudo), consiglio degli AP, cambio AP. |
| `provisioning` | `DeviceCheck` e `DiscoveryCheck` (logica pura, testata), `CpeProvisioner`, configurazioni pronte offline, magazzino sul telefono. |
| `field` | «CPE collegata»: client airOS, puntamento con il bip, diagnosi, collaudo e sua coda, foto e loro controlli, realtà aumentata, bussola, CPE smontate. |
| `firmware` | Firmware sul telefono e aggiornamento della CPE. |
| `specialist` | Il flusso Nuova CPE dello Specialist. |
| `tools` | Discovery Ubiquiti (v1 e v2, riavvio con la sfida), scansione LAN e topologia, SNMP BER, Wi-Fi Analyzer, speedtest Ookla, RTSP (Media3). |
| `routeros` | Client SSH in sola lettura; il catalogo arriva dal server, con fallback locale. |
| `push`, `alerts`, `outages` | Notifiche: Firebase o collegamento proprio con il server, avvisi sul telefono, guasti Enel ad app chiusa. |
| `update` | Download dell'APK con verifica SHA-256, aggiornamento obbligatorio, installazione tramite FileProvider. |
| `ui` | Navigazione, schermate Compose, componenti e colori presi dai token della console (`console/src/styles/tokens.css` → `android/tools/console-tokens.mjs`), mappa nella WebView. |

I test (`testDebugUnitTest`) coprono la logica pura e i flussi dell'app contro un server di prova locale (installazione offline, collaudo dal tetto, foto, ripuntamento).

## Deploy

Vedi [DEPLOY.md](DEPLOY.md). L'immagine gira come utente `node`. L'entrypoint parte come root solo per:
- adottare i volumi creati dalla v0.5;
- passare la master key a `node`.

Capabilities: `CHOWN`, `SETUID`, `SETGID`, con `no-new-privileges` attivo.
