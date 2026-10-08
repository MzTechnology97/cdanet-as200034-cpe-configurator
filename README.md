# CDA Net CPE Configurator · v1

Piattaforma interna CDA Net (AS200034) per il provisioning delle CPE Ubiquiti airMAX AC e la diagnostica di campo.

| Componente | Cartella | Ruolo |
|---|---|---|
| **Server** | [`server/`](server) | Node.js 24 + TypeScript. Unica fonte della policy CDA Net: account, segreti cifrati, profili airOS, **generazione del `system.cfg` finale**, storico, tool NOC, canale aggiornamenti Android. |
| **Console web** | [`web/`](web) | Admin/NOC servita dal server: account, chiavi WPA2, profili airOS, storico, strumenti di rete e RouterOS lato server. |
| **App Android** | [`android/`](android) | Kotlin + Jetpack Compose. Client di campo: prepara il job online, applica la configurazione alla CPE offline via SSH, strumenti LAN (Wi-Fi, discovery, SNMP, TVCC/RTSP, RouterOS). |
| **Deploy** | [`deploy/`](deploy) | Docker Compose con immagine pubblicata dalla CI su GHCR, reverse proxy Caddy e **container updater con rollback automatico**. |

```
 Admin/NOC (browser) ──HTTPS──▶ ┌──────────────── server (Docker) ────────────────┐
                                │ policy · profili cifrati · WPA2 · job · audit    │
 App Android ──(online)──────▶  │ POST /api/provisioning/jobs → system.cfg finale  │
     │                          └──────────────────────────────────────────────────┘
     │ Wi-Fi management CPE (offline)
     ▼
 CPE airOS 8.7.4  ◀── SSH: verifica firmware/board/MAC → /tmp/system.cfg → cfgmtd → reboot
```

## Flusso di provisioning

1. **Online** — l'installatore compila modello, MAC/seriale (scansione etichetta), nodo/distretto e credenziali RADIUS. Il server valida, genera il `system.cfg` definitivo (template del modello + segreti + policy CDA Net) e lo consegna **solo all'app**, in memoria, con scadenza (30 min di default).
2. **Offline** — il telefono si collega alla Wi-Fi di management della CPE. L'app instrada il traffico su quella Wi-Fi anche con i dati mobili attivi, apre il primo avvio airOS dentro l'app, poi via SSH:
   - verifica firmware **8.7.4**, board (regex del profilo) e **MAC atteso**;
   - trasferisce `/tmp/system.cfg` e ne controlla dimensione e MD5;
   - salva con `cfgmtd -f /tmp/system.cfg -w -p /etc/ && sync`;
   - riavvia la CPE.
3. **Esito** — l'esito, senza password, viene messo in coda sul telefono e inviato al server appena torna la connettività.

Policy forzata dal server: WAN wireless in PPPoE **senza VLAN**, watchdog `8.8.8.8`, SNMP v2c (community/contact da configurazione, location `COGNOME NOME`), Device Name `COGNOME NOME`, Calculate EIRP Limit OFF, ATPC Station ON, management HTTP 20080 / HTTPS 20443. Dettagli in [docs/PROVISIONING.md](docs/PROVISIONING.md).

## Aggiornamenti automatici

- **Server**: ogni push su `main` con test verdi pubblica `ghcr.io/mztechnology97/cdanet-cpe-server:stable`. Ogni 5 minuti il container `updater` sul server:
  1. scarica la nuova immagine;
  2. fa il backup del database (`VACUUM INTO`);
  3. riavvia l'app;
  4. se l'health-check fallisce, torna alla versione precedente.
- **App Android**: a ogni nuova `VERSION` la CI firma l'APK e crea una GitHub Release. Il server la scarica e ne verifica lo SHA-256. All'avvio l'app trova l'aggiornamento, lo scarica, verifica lo SHA-256 e lo propone ad Android.

Per pubblicare una nuova versione:
1. incrementa [`VERSION`](VERSION) e `server/package.json`;
2. fai merge su `main`.

Guida completa: [docs/DEPLOY.md](docs/DEPLOY.md).

## Sviluppo

```bash
cd server && npm ci && npm test        # 28 test: dominio, API, migrazione DB v0.5, sync release
npm run typecheck
```

Server locale con la console:

```bash
JWT_SECRET=dev-secret-0123456789abcdefghijklmnop ADMIN_PASSWORD=Dev-Admin-Password-1 \
SECRETS_KEY_FILE=.dev/master.key DB_PATH=.dev/dev.sqlite STATIC_DIR=web node server/src/main.ts
```

Per l'app Android:
- apri `android/` in Android Studio (usa Gradle 8.11.1 da `gradle-wrapper.properties`);
- oppure, con Gradle installato: `gradle -p android testDebugUnitTest assembleDebug`.

## Documentazione

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — componenti, API, modello dati, scelte di sicurezza
- [docs/PROVISIONING.md](docs/PROVISIONING.md) — profili airOS, placeholder, collaudo
- [docs/DEPLOY.md](docs/DEPLOY.md) — installazione Debian, auto-update, firma APK, backup
- [docs/UISP.md](docs/UISP.md) — UISP, posizione GPS, AP vicini e copertura
- [docs/MIGRATION-v1.md](docs/MIGRATION-v1.md) — passaggio dalla v0.5.x
- [SECURITY.md](SECURITY.md)

## Limiti noti

La normalizzazione firmware (downgrade 8.7.11/8.7.25 → 8.7.4) non è automatizzata: la scrittura viene bloccata finché la CPE non è su 8.7.4. Il collaudo su hardware reale (5 modelli) resta un requisito prima della produzione: compilazione e test automatici non sostituiscono la prova al banco.
