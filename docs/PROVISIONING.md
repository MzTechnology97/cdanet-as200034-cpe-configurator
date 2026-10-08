# Provisioning airOS · profili e collaudo

## Modelli e firmware

NanoStation Loco 5AC, NanoStation 5AC, NanoBeam 5AC, LiteBeam 5AC, PowerBeam 5AC. Il firmware di produzione è **airOS 8.7.4**. 8.7.11 e 8.7.25 vengono rilevati, ma la scrittura è bloccata finché la normalizzazione a 8.7.4 non è collaudata al banco.

## Profili (uno per modello)

Il server non inventa chiavi `system.cfg`. Ogni modello usa l'export reale di una CPE di laboratorio su 8.7.4:

1. Fai il factory reset di una CPE di laboratorio, completa il primo avvio e portala a 8.7.4.
2. Configurala a mano in modo completo e funzionante: Station WPA2, Router Mode, PPPoE su WAN wireless senza VLAN, management, UISP, SNMP.
3. Esporta `system.cfg` (System → Backup Configuration).
4. Sostituisci solo i valori variabili con i placeholder qui sotto.
5. Dalla console: **Profili airOS → modello → carica il file**. Il server mostra subito:
   - gli errori bloccanti (VLAN, placeholder sconosciuti, `${CPE_PASSWORD}` in chiaro in `users.N.password`);
   - gli avvisi (placeholder SSID/WPA2/PPPoE mancanti).
6. Imposta il **board match**: una regex applicata all'output di `/etc/version`, `/etc/board.info` e `/proc/ubnthal/system.info` (es. `board\.name=LiteBeam 5AC`).
7. Prova il profilo su una seconda CPE di laboratorio prima dell'uso in campo.

Il template viene cifrato (AES-256-GCM) e di lui si mostra solo lo SHA-256.

## Placeholder

| Placeholder | Valore |
|---|---|
| `${SSID}` / `${WPA2_PSK}` | SSID `CDA-NET-N{nodo}-D{distretto}` e la sua chiave (dal DB cifrato) |
| `${PPPOE_USER}` / `${PPPOE_PASSWORD}` | Credenziali RADIUS del cliente (la password non viene mai salvata) |
| `${CPE_USERNAME}` | `CPE_ADMIN_USERNAME` |
| `${CPE_PASSWORD_HASH}` | `CPE_ADMIN_PASSWORD` in MD5-crypt `$1$…`: **da usare in `users.1.password`** |
| `${CPE_PASSWORD}` | Password in chiaro: solo dove airOS la vuole in chiaro, mai in `users.N.password` |
| `${UISP_ENROLLMENT}` | Chiave UISP (runtime secret) |
| `${SNMP_COMMUNITY}` / `${SNMP_CONTACT}` / `${SNMP_LOCATION}` | Community, contact, `COGNOME NOME` |
| `${DEVICE_NAME}` | `COGNOME NOME` derivato dallo username RADIUS |
| `${HTTP_PORT}` / `${HTTPS_PORT}` | 20080 / 20443 |
| `${LAN_IP}` `${LAN_NETMASK}` `${DHCP_START}` `${DHCP_END}` `${DHCP_LEASE}` | Baseline LAN (`CPE_*` in `.env`) |
| `${PPPOE_MTU}` `${PPPOE_MRU}` `${WATCHDOG_HOST}` `${NTP_SERVER}` `${SSH_PORT}` `${DISCOVERY_PORT}` | Baseline (`CPE_*` in `.env`) |
| `${EXPECTED_MAC}` / `${EXPECTED_SERIAL}` | MAC e seriale indicati dall'installatore |

La sostituzione avviene in un solo passaggio: un valore che contiene `${…}` non viene ri-espanso. Valori con CR/LF/NUL vengono rifiutati.

## Policy sempre forzata dal server

Indipendentemente dal template:
- `pwdog.status=enabled`
- `pwdog.host=<CPE_WATCHDOG_HOST>`
- `snmp.status=enabled`
- `snmp.community`
- `snmp.contact`
- `snmp.location=COGNOME NOME`
- `system.eirp.status=disabled`
- `radio.1.obey=disabled` (Calculate EIRP Limit OFF)
- `radio.1.atpc.sta.status=enabled` (Automatic Power Control Station ON)
- `resolv.host.1.name=COGNOME NOME`
- `resolv.host.1.status=enabled`

Un profilo con `vlan.*`, `ebtables.sys.vlan.*` o `ppp.N.devname=ath0.X` viene rifiutato sia al caricamento sia al rendering.

## Controlli eseguiti dall'app prima di scrivere

1. Il pacchetto non è scaduto e lo SHA-256 della configurazione coincide.
2. Il target è un indirizzo privato (`192.168.172.1` di default).
3. La stringa di `/etc/version` contiene esattamente `v8.7.4` (non 8.7.41, 18.7.4…).
4. Il board match del profilo corrisponde.
5. `board.hwaddr` / `eth0.macaddr` coincidono con il MAC indicato.
6. Dopo il trasferimento, dimensione e MD5 di `/tmp/system.cfg` coincidono.

## Collaudo per ciascun modello (gate di produzione)

- [ ] factory reset → primo avvio nell'app → provisioning completo
- [ ] associazione al nodo previsto, PPPoE autenticato
- [ ] UISP connesso, SNMP risponde con location corretta
- [ ] management HTTP 20080 / HTTPS 20443
- [ ] CPE con firmware diverso da 8.7.4 → scrittura bloccata
- [ ] MAC errato → scrittura bloccata
- [ ] interruzione (Wi-Fi staccata) prima di `cfgmtd` → CPE invariata, nuovo tentativo riuscito
- [ ] esito sincronizzato sul server; nessuna password in storico, log o cache
