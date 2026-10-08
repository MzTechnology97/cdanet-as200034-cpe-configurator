# Architettura v1

## Perché la riscrittura

La v0.5.x aveva:
- il codice Android generato in CI da heredoc dentro `android-apk.yml`;
- un backend minificato a mano;
- la stessa logica (rendering `system.cfg`, policy, RouterOS, SNMP) copiata in Java, nel Web Bridge e nel backend.

La PWA senza APK o Web Bridge non poteva fare quasi nulla. La v1 concentra la logica nel server e lascia ai client solo ciò che deve per forza essere eseguito in LAN.

## Server (`server/`)

Node.js 24 esegue TypeScript direttamente (type stripping): non c'è uno step di build e `tsc` serve solo come typecheck. Componenti: Fastify 5, `node:sqlite` (nessuna dipendenza nativa), zod, jose (JWT HS256), ssh2.

| Modulo | Contenuto |
|---|---|
| `config.ts` | Validazione dell'ambiente (zod). Fallisce all'avvio con un messaggio chiaro. |
| `db.ts` | Migrazioni con `PRAGMA user_version`. La migrazione 1 adotta lo schema v0.5.x; la 2 aggiunge job, eventi e revoca delle sessioni. |
| `crypto.ts` | AES-256-GCM (formato compatibile con v0.5), scrypt per le password, MD5-crypt per `users.N.password`. |
| `auth.ts` | JWT con `token_version`: disabilitare un account, resettarne la password o cambiarne il ruolo revoca subito le sessioni. Include il rate limit sul login. |
| `domain/policy.ts` | Modelli supportati, firmware target, regole SSID e RADIUS, versione minima del client. |
| `domain/systemcfg.ts` | Ispezione e rendering del template (sostituzione in un solo passaggio, chiavi di policy forzate, blocco VLAN). |
| `domain/routeros.ts` | Catalogo dei comandi in sola lettura, validazione del terminale, redazione dei segreti (servito anche all'app). |
| `services/provisioning.ts` | Piano, creazione job con config renderizzata, esiti idempotenti, retention. |
| `services/releases.ts` | Canale APK e sincronizzazione dalla GitHub Release più recente, con verifica SHA-256. |
| `net/*` | Tool lato server: ping, traceroute, DNS, scan /24, SNMP BER, NetBIOS, ONVIF/SADP, porte, BGP, MAC vendor, RouterOS SSH. |

### API

| Metodo | Percorso | Ruolo |
|---|---|---|
| GET | `/api/health` | pubblico |
| POST | `/api/auth/login` (alias `/api/login` per APK v0.5) | pubblico, rate-limited |
| GET | `/api/mobile/update`, `/api/mobile/apk` | pubblico (recupero app rotta) |
| GET | `/api/auth/me`, `/api/meta`, `/api/wireless-networks` | utente |
| POST | `/api/provisioning/plan` | utente: dry-run senza segreti |
| POST | `/api/provisioning/jobs` | utente + `X-CDA-Client: android/x.y.z` ≥ `MIN_ANDROID_VERSION` |
| POST | `/api/provisioning/jobs/:id/result` | proprietario o admin, idempotente |
| GET | `/api/provisioning/jobs` | i propri job (admin: tutti), con filtri |
| * | `/api/tools/*`, `/api/routeros/*` | utente |
| GET | `/api/provisioning/templates` | utente: nomi dei template per modello (senza contenuto) |
| * | `/api/admin/users`, `/wireless-networks` (+ `/import`, `/bulk-delete`), `/profiles`, `/profiles/:model/templates`, `/templates/:id`, `/status`, `/events`, `/placeholders` | admin |

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

Il client non esegue comandi forniti dal server: lettura, scrittura e `cfgmtd` sono costanti nell'app.

### Dati

`users`, `wireless_secrets` (cifrate), `provision_profiles` (template cifrati), `provisioning_jobs` (solo metadati: niente password, niente config), `events` (registro delle attività admin), `audits` (tabella v0.5 mantenuta in sola lettura e migrata nei job). La retention `GDPR_AUDIT_RETENTION_DAYS` si applica a job, eventi e audits.

## App Android (`android/`)

Kotlin 2.0 e Compose Material 3, minSdk 26, un solo modulo `:app`.

| Package | Contenuto |
|---|---|
| `data` | `ApiClient` (OkHttp + kotlinx.serialization). `Session` tiene il token solo in memoria. `ResultQueue` è la coda persistente degli esiti, senza segreti. `Settings` è una DataStore che contiene solo l'URL del server. |
| `network` | `NetworkHelper.onWifi { … }` lega temporaneamente il processo alla Wi-Fi (socket, DNS, WebView). Serve quando la Wi-Fi della CPE non ha Internet e Android preferisce la rete cellulare. |
| `ssh` | Wrapper JSch con algoritmi legacy *aggiunti* (dropbear factory). |
| `provisioning` | `DeviceCheck` (logica pura, testata), `CpeProvisioner`, `ProvisioningController` (stato del flusso, il pacchetto vive solo in memoria). |
| `tools` | Tool LAN, SNMP BER, player RTSP (Media3). |
| `routeros` | Client SSH in sola lettura; il catalogo arriva dal server, con fallback locale. |
| `update` | Download dell'APK con verifica SHA-256 e installazione tramite FileProvider. |
| `ui` | Navigazione a stack, schermate Compose. |

## Deploy

Vedi [DEPLOY.md](DEPLOY.md). L'immagine gira come utente `node`. L'entrypoint parte come root solo per:
- adottare i volumi creati dalla v0.5;
- passare la master key a `node`.

Capabilities: `CHOWN`, `SETUID`, `SETGID`, con `no-new-privileges` attivo.
