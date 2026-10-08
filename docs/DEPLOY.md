# Deploy e aggiornamenti automatici

## Come funziona

```
push su main ──▶ GitHub Actions: test + typecheck + smoke test immagine
                   └─▶ ghcr.io/mztechnology97/cdanet-cpe-server:stable (+ :x.y.z, :sha-…)
                                   │
server Debian ── updater (ogni 5 min) ──▶ pull ──▶ backup DB ──▶ restart app ──▶ healthy?
                                                                    └─ no ─▶ rollback + immagine marcata "bad"
```

L'immagine contiene server e console web. Sul server **non serve il codice sorgente**: bastano `/opt/cdanet-cpe/{docker-compose.yml, Caddyfile, .env, updater/}`.

## Installazione (Debian 12/13)

```bash
sudo ./deploy/install-debian.sh
```

Senza checkout, scaricando lo script dalla repo:

```bash
curl -fsSL -H "Accept: application/vnd.github.raw" https://api.github.com/repos/MzTechnology97/cdanet-as200034-cpe-configurator/contents/deploy/install-debian.sh?ref=main | sudo bash
```

Lo script:
1. installa Docker;
2. crea la master key `/etc/cdanet-cpe/secrets/master.key`;
3. prepara `/opt/cdanet-cpe/.env`;
4. chiede le credenziali del primo admin (la password non viene salvata nel file);
5. avvia lo stack e verifica l'health-check.

Rieseguirlo è sicuro: `.env`, chiave e database restano intatti.

Dopo l'installazione completa in `.env` almeno `CPE_ADMIN_PASSWORD` e `UISP_ENROLLMENT`, poi:

```bash
cd /opt/cdanet-cpe && sudo docker compose up -d
```

### Repository / pacchetto privato

Se rendi privati la repo o il pacchetto GHCR (consigliato):
- **Immagine**: `docker login ghcr.io` sul server con un token `read:packages`. L'updater usa le stesse credenziali (`REGISTRY_AUTH_DIR`, default `/root/.docker`). Puoi anche passare `GHCR_USER`/`GHCR_TOKEN` all'installer.
- **APK**: imposta `ANDROID_RELEASE_GITHUB_TOKEN` (fine-grained, Contents: read-only).
- **Installer via curl**: aggiungi `-H "Authorization: Bearer <token>"`, oppure eseguilo da un checkout.

## HTTPS

Imposta `APP_LISTEN=cpe.example.it` in `.env`: Caddy ottiene il certificato automaticamente. Servono il DNS verso il server e le porte TCP 80/443 raggiungibili. Con `APP_LISTEN=:80` la console è in HTTP sulla LAN.

## Auto-update: controllo

| Variabile `.env` | Default | Significato |
|---|---|---|
| `AUTOUPDATE` | `1` | `0` = updater inattivo |
| `UPDATE_INTERVAL` | `300` | secondi tra i controlli |
| `UPDATE_WINDOW` | vuoto | es. `01-05`: aggiorna solo tra le 01:00 e le 04:59 |
| `CDANET_CHANNEL` | `stable` | tag dell'immagine (`stable`, `1.2.3` per bloccare una versione, `branch-…` per test) |

Comandi utili:

```bash
cd /opt/cdanet-cpe
sudo docker compose logs -f updater          # storico aggiornamenti/rollback
sudo docker compose exec -u node app node src/cli/backup.ts manual   # backup manuale
sudo ls /var/lib/docker/volumes/cdanet-cpe-configurator_appdata/_data/backups
```

I backup (`VACUUM INTO`, ultimi 20) si trovano nel volume dati, in `backups/`. Se un'immagine fallisce l'health-check:
- viene scritta in `bad-images` (volume `updater_state`) e non viene più riprovata;
- serve una nuova build per sbloccare l'aggiornamento.

## App Android: firma e canale aggiornamenti

Gli aggiornamenti in-place richiedono **sempre la stessa chiave di firma**. Crea il keystore una sola volta e conservalo offline:

```bash
keytool -genkeypair -v -keystore cdanet-release.jks -alias cdanet -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 cdanet-release.jks   # → secret ANDROID_KEYSTORE_BASE64
```

Secrets da impostare nella repo:
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Con i secrets presenti, ogni push su `main` con una `VERSION` nuova:
- crea la release `vX.Y.Z` con APK firmato e `latest.json`;
- il server la scarica entro `ANDROID_RELEASE_SYNC_MINUTES` minuti, verificandone lo SHA-256;
- le app la propongono al successivo avvio.

Senza secrets la CI produce solo l'APK debug (`it.cdanet.cpeconfigurator.debug`), da installare a mano.

> L'APK v0.5.x era firmato con una chiave diversa (o di debug)? Allora l'aggiornamento automatico verso la v1 viene rifiutato da Android: va disinstallata la vecchia app e installata la v1 una volta a mano. Dalla v1 in poi l'aggiornamento è automatico.

## Recupero password admin

```bash
sudo /opt/cdanet-cpe/reset-admin-password.sh
```
