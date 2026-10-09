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
5. chiede se installare **OpenStreetMap locale** (vedi sotto);
6. avvia lo stack e verifica l'health-check.

Rieseguirlo è sicuro: `.env`, chiave e database restano intatti.

Dopo l'installazione completa in `.env` almeno `CPE_ADMIN_PASSWORD` e `UISP_ENROLLMENT`. Il comando apre l'editor e alla chiusura applica le modifiche:

```bash
sudo cdanet-cpe edit
```

> `/opt/cdanet-cpe` è leggibile solo da root, perché contiene `.env` con i segreti: `cd /opt/cdanet-cpe` da utente normale dà *Permission denied*, e `sudo cd` non esiste. Usa `sudo cdanet-cpe …`, che è `docker compose` già puntato alla cartella giusta, oppure `sudo -i`.

### OpenStreetMap locale (ricerca indirizzi)

La ricerca degli indirizzi (Copertura e posizione della CPE) può girare in un container **Nominatim** dello stesso stack: gli indirizzi non escono dal server e non c'è il limite di 1 richiesta al secondo del servizio pubblico.

Al primo avvio l'installer chiede se attivarlo e quale regione importare. Per farlo senza domande, ad esempio su un server di test:

```bash
sudo CDANET_GEOCODER=local CDANET_GEOCODER_REGION=sicilia ./deploy/install-debian.sh
```

| Regione | Contenuto | RAM | Disco libero | Primo import |
|---|---|---|---|---|
| `sicilia` (default) | solo Sicilia (estratto openstreetmap.fr) | 3 GB | 15 GB | ~20-60 min |
| `isole` | Sicilia + Sardegna (Geofabrik) | 4 GB | 25 GB | ~30-90 min |
| `sud`, `centro`, `nord-est`, `nord-ovest` | macro-area | 4-8 GB | 25-40 GB | 1-3 ore |
| `italia` | tutta Italia | 8+ GB | 90 GB | diverse ore |
| `custom` | qualsiasi estratto: `CDANET_GEOCODER_PBF_URL` (+ `CDANET_GEOCODER_REPLICATION_URL`) | | | |

Cosa succede:
- il container `nominatim` (immagine `mediagis/nominatim:5.3`) scarica l'estratto (Geofabrik o openstreetmap.fr), lo importa e poi si aggiorna da solo ogni giorno;
- PostgreSQL viene dimensionato sulla RAM del server; la password interna del DB è generata casualmente;
- il servizio non è esposto: lo raggiunge solo l'app, sulla rete interna;
- **durante l'import** la ricerca usa il servizio pubblico come riserva (`GEOCODER_FALLBACK_URL`), quindi l'app funziona da subito.

Comandi:

```bash
sudo cdanet-cpe geocoder          # stato: import in corso / pronto, data dei dati
sudo cdanet-cpe geocoder logs     # log dell'import
sudo cdanet-cpe geocoder reset    # cancella i dati e rifà l'import (es. cambio regione)
```

Lo stato si vede anche dalla console: **Connettori → OpenStreetMap → Verifica servizio**. Per tornare al servizio pubblico: `sudo CDANET_GEOCODER=public ./deploy/install-debian.sh`.

### HTTPS senza certificato pubblico

Oltre all'HTTP su `APP_LISTEN`, Caddy serve la console in **HTTPS con un certificato della propria CA locale** sugli indirizzi in `HTTPS_SITES` (l'installer ci mette gli IP del server; per aggiungere l'IP pubblico dietro NAT: `sudo CDANET_HTTPS_SITES="https://<ip pubblico> https://<ip lan>" ./deploy/install-debian.sh`). `HTTPS_DEFAULT_SNI` è il certificato usato quando ci si collega a un IP (i browser non inviano il nome).

I certificati durano 12 ore e Caddy li rinnova da solo. Per non vedere avvisi installa sui PC e sui telefoni la **CA radice** (valida 10 anni):

```bash
sudo cdanet-cpe https-ca > cdanet-root-ca.crt
```

Windows: doppio clic → Installa certificato → "Autorità di certificazione radice attendibili". Android: Impostazioni → Sicurezza → Crittografia e credenziali → Installa un certificato → Certificato CA. Senza la CA il browser chiede di accettare il certificato (e può richiederlo di nuovo dopo il rinnovo).

**App Android**: accetta la CA installata dall'utente sul telefono (consigliato). Solo per i test c'è anche Impostazioni → Server → **"Accetta certificato non verificato (solo test)"**: vale solo verso il server CDA Net (API, aggiornamenti, notifiche, mappa) e va spento appena possibile.

L'HTTPS serve anche per il GPS del browser (zone dei guasti da "Usa GPS di questo dispositivo").

### Mappe (Protomaps)

L'installer scarica anche la mappa della stessa regione (`CDANET_MAP=local`, default) e la aggiorna ogni mese; `CDANET_MAP=off` per non scaricarla (la console usa le mappe pubbliche). Comandi: `sudo cdanet-cpe map [update|remove]`. Dettagli in [MAPPE.md](MAPPE.md).

### Installazione senza domande

Per automatizzare la prima installazione (nessuna domanda a terminale):

```bash
sudo CDANET_ADMIN_USER=admin CDANET_ADMIN_PASSWORD='<min 14 caratteri>' CDANET_GEOCODER=local ./deploy/install-debian.sh
```

`CDANET_CHANNEL=1.0.9` fissa una versione dell'immagine al posto di `stable`. Lo stesso percorso è provato a ogni modifica dal workflow **Installer e2e**: Debian 12, installazione, login, Nominatim locale (estratto di prova) e seconda esecuzione dell'installer.

### Repository / pacchetto privato

Se rendi privati la repo o il pacchetto GHCR (consigliato):
- **Immagine**: `docker login ghcr.io` sul server con un token `read:packages`. L'updater usa le stesse credenziali (`REGISTRY_AUTH_DIR`, default `/root/.docker`). Puoi anche passare `GHCR_USER`/`GHCR_TOKEN` all'installer.
- **APK**: imposta `ANDROID_RELEASE_GITHUB_TOKEN` (fine-grained, Contents: read-only).
- **Installer via curl**: aggiungi `-H "Authorization: Bearer <token>"`, oppure eseguilo da un checkout.

## Impostazioni dal portale (senza SSH)

Console → **Amministrazione → Impostazioni server** (solo admin): i parametri che prima andavano scritti nel file `.env` si impostano dal web e hanno la precedenza sul `.env` (che resta il valore di partenza, ripristinabile con "Ripristina .env"):
- **Credenziali delle CPE**: utente e **password amministratore CPE** (`CPE_ADMIN_USERNAME`/`CPE_ADMIN_PASSWORD`), **chiave di adozione UISP** (`UISP_ENROLLMENT`), community e contatto SNMP;
- **Rete standard delle CPE**: IP di fabbrica e LAN, netmask, DHCP, MTU/MRU PPPoE, watchdog, NTP, porte SSH e discovery;
- **Provisioning e app**: validità di un provisioning, versione minima dell'app, durata delle sessioni, conservazione dello storico, indirizzo pubblico della console, RouterOS su IP pubblici;
- **Rilasci dell'app Android**: repository/token GitHub e frequenza di controllo.

I segreti sono cifrati con la chiave master del server e **non vengono mai mostrati** (solo "impostata/non impostata"); nel Registro attività compare quali parametri sono cambiati, mai i valori. Quasi tutto vale subito; durata delle sessioni e rilasci valgono dopo **Riavvia l'app ora** (pulsante nella stessa pagina). La nuova password CPE vale per le CPE configurate da quel momento: quelle già installate mantengono la loro (per quelle gli strumenti di campo permettono di inserirla a mano).

Restano nel `.env` i parametri dell'infrastruttura (indirizzo/HTTPS di Caddy, aggiornamenti automatici, regione di mappe e geocoder) e i segreti di base (`JWT_SECRET`, chiave master).

## Reti Wi-Fi (chiavi WPA2) in blocco

Nella console, in **Reti Wi-Fi**:
- **Importa da CSV**: carica un file con una riga per rete. Il modello si scarica dalla pagina (*Scarica CSV di esempio*):

  ```csv
  nodo;distretto;wpa2
  2;01;ChiaveWpa2DiEsempio
  ```

  In alternativa usa le colonne `ssid;wpa2` (es. `CDA-NET-N2-D01;Chiave…`). Il separatore può essere `;` (Excel in italiano) o `,`. I valori che contengono il separatore vanno tra virgolette.
- Prima di salvare compare un'anteprima: reti nuove, da aggiornare, invariate ed errori riga per riga. **Se anche una sola riga è errata non viene importato nulla.** Le reti già presenti vengono aggiornate con la nuova chiave.
- **Modifica WPA2** su una riga carica la rete nel modulo in alto: inserisci la nuova chiave e premi *Aggiorna chiave*.
- Con le caselle di selezione (o *seleziona tutte* nell'intestazione, che agisce sulle reti filtrate) puoi eliminare più reti con **Elimina selezionate**.

Ogni import ed eliminazione multipla compare nel **Registro attività**, senza le chiavi.

## HTTPS

Imposta `APP_LISTEN=cpe.example.it` in `.env`: Caddy ottiene il certificato automaticamente. Servono il DNS verso il server e le porte TCP 80/443 raggiungibili. Con `APP_LISTEN=:80` la console è in HTTP sulla LAN.

## Auto-update: controllo

| Variabile `.env` | Default | Significato |
|---|---|---|
| `AUTOUPDATE` | `1` | `0` = updater inattivo |
| `UPDATE_INTERVAL` | `300` | secondi tra i controlli |
| `UPDATE_WINDOW` | vuoto | es. `01-05`: aggiorna solo tra le 01:00 e le 04:59 |
| `CDANET_CHANNEL` | `stable` | tag dell'immagine (`stable`, `1.2.3` per bloccare una versione, `branch-…` per test) |

Il controllo avviene all'avvio dell'updater e poi ogni `UPDATE_INTERVAL` secondi. Dal merge su `main` all'aggiornamento del server passano circa 5–8 minuti (build CI + intervallo).

Comandi utili (da qualsiasi cartella):

```bash
sudo cdanet-cpe version                 # versione in esecuzione
sudo cdanet-cpe logs -f updater         # storico aggiornamenti/rollback
sudo cdanet-cpe restart updater         # controlla subito se c'è una nuova versione
sudo cdanet-cpe ps                      # stato dei container
sudo cdanet-cpe backup                  # backup manuale del database
sudo ls /var/lib/docker/volumes/cdanet-cpe-configurator_appdata/_data/backups
```

`cdanet-cpe` viene installato da `install-debian.sh`. Su un server installato prima che esistesse, rilancia l'installer da una copia aggiornata della repo: `.env` e i dati non vengono toccati.

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
