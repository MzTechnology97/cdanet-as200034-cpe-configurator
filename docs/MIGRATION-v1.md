# Migrazione da v0.5.x a v1

## Cosa resta compatibile

- **Database**: la v1 adotta il file SQLite della v0.5 nel volume `cdanet-cpe-configurator_appdata`:
  - account e password (scrypt), WPA2 e profili (cifrati con la stessa master key) restano validi;
  - gli audit diventano job con stato `success`/`failed` (id `legacy-N`).
- **Master key**: stesso percorso `/etc/cdanet-cpe/secrets/master.key`.
- **Variabili**: `JWT_SECRET`, `ADMIN_USERNAME`, `CPE_*`, `UISP_ENROLLMENT`, `SNMP_*`, `GDPR_AUDIT_RETENTION_DAYS`, `ROUTEROS_ALLOW_PUBLIC`, `ANDROID_RELEASE_HOST_PATH`. L'installer le importa da `/opt/cdanet-cpe-configurator/deploy/.env`.
- **Canale APK**: `/api/mobile/update` e `/api/mobile/apk` non cambiano e `/api/login` resta come alias. Un'app v0.5 può quindi scaricare la v1, purché sia firmata con la stessa chiave.

## Cosa cambia

| v0.5.x | v1 |
|---|---|
| PWA + Web Bridge locale per il campo | Console web solo Admin/NOC; il campo usa l'app Android |
| Template + segreti inviati all'app, rendering in Java | Il server invia il `system.cfg` già renderizzato, con SHA-256 |
| Lista `X-CDA-Client` hardcoded a ogni release | `X-CDA-Client: android/x.y.z` ≥ `MIN_ANDROID_VERSION` |
| Trasferimento SFTP | `cat > /tmp/system.cfg` via exec + verifica dimensione/MD5 (dropbear factory spesso non ha sftp-server) |
| Traffico su rete di default (spesso cellulare) | Processo legato alla Wi-Fi della CPE durante le operazioni locali |
| `${CPE_PASSWORD}` in `users.1.password` (errato: airOS vuole un hash) | `${CPE_PASSWORD_HASH}` (MD5-crypt); il server rifiuta l'uso in chiaro |
| Redazione delle password RouterOS del Web Bridge non funzionante (regex con `\\s`) | Redazione testata su server e app |
| Redeploy manuale `git pull && docker compose build` | Immagine CI + updater con backup e rollback |
| Container come root | Utente `node`, `cap_drop: ALL` + `CHOWN/SETUID/SETGID` |

Variabili rimosse: `ALLOWED_ORIGIN`, `PROVISIONING_MODE`, `BRIDGE_URL`, `BRIDGE_TOKEN`, `FIRMWARE_HOST_PATH`, `NATIVE_ORIGIN`.

## Procedura

1. Fai un backup di `/opt/cdanet-cpe-configurator/deploy/.env`, di `/etc/cdanet-cpe/secrets/master.key` e del volume dati.
2. Esegui `sudo ./deploy/install-debian.sh` dalla v1. Lo script:
   - importa le variabili dalla v0.5;
   - ferma lo stack v0.5;
   - avvia la v1 sullo stesso volume.
3. **Profili**: controlla in console che i template non usino `${CPE_PASSWORD}` in `users.N.password`. In quel caso, al primo provisioning il server risponde `users_password_requires_hash_placeholder`; ricarica il profilo con `${CPE_PASSWORD_HASH}`.
4. Configura i secrets di firma Android (vedi [DEPLOY.md](DEPLOY.md)) e fai merge su `main`.
5. Installa l'app v1 sui telefoni: via aggiornamento automatico se la chiave è la stessa, altrimenti a mano.
6. Esegui la checklist di collaudo in [PROVISIONING.md](PROVISIONING.md) per ogni modello.
