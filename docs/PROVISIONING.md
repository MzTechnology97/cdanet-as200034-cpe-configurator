# Provisioning airOS · profili e collaudo

## Modelli e firmware

NanoStation Loco 5AC, NanoStation 5AC, NanoBeam 5AC, LiteBeam 5AC, PowerBeam 5AC. Il firmware di produzione è **airOS 8.7.4**. 8.7.11 e 8.7.25 vengono rilevati, ma la scrittura è bloccata finché la normalizzazione a 8.7.4 non è collaudata al banco.

## Template airOS (più template con nome per ogni modello)

Il server non inventa chiavi `system.cfg`. Ogni modello usa il backup reale di una CPE di laboratorio su 8.7.4, e i placeholder vengono inseriti **in automatico**:

1. Fai il factory reset di una CPE di laboratorio, completa il primo avvio e portala a 8.7.4.
2. Configurala a mano in modo completo e funzionante: Station WPA2, Router Mode, PPPoE su WAN wireless senza VLAN, management 20080/20443, UISP, SNMP, NTP e watchdog.
3. Scarica il backup: **System → Back Up Configuration → Download**.
4. Nella console: **Profili airOS → modello → Importa backup**, e scegli il file così com'è.
5. Il server sostituisce i valori del cliente con i placeholder e mostra l'anteprima:
   - righe e chiavi sostituite, con i segreti oscurati;
   - avvisi su ciò che non ha trovato;
   - errori bloccanti, per esempio una VLAN presente.

   Nulla viene salvato finché non premi **Salva come profilo**. Con **Scarica template generato** puoi rileggerlo.
6. Controlla il **board match** proposto, cioè la regex applicata a `/etc/version`, `/etc/board.info` e `/proc/ubnthal/system.info`. Confrontalo con `cat /etc/board.info` sulla CPE (es. `board\.name=LiteBeam 5AC`), poi salva.
7. Prova il profilo su una seconda CPE di laboratorio prima dell'uso in campo.

Righe sostituite in automatico (nomi chiave di airOS 8):

| Chiave nel backup | Placeholder |
|---|---|
| `wireless.N.ssid`, `wpasupplicant.profile.N.network.N.ssid` | `${SSID}` |
| `wpasupplicant.profile.N.network.N.psk` | `${WPA2_PSK}` |
| `ppp.N.name` / `ppp.N.password` / `ppp.N.mtu` / `ppp.N.mru` | `${PPPOE_USER}` / `${PPPOE_PASSWORD}` / `${PPPOE_MTU}` / `${PPPOE_MRU}` |
| `users.1.name` / `users.1.password` | `${CPE_USERNAME}` / `${CPE_PASSWORD_HASH}` |
| qualsiasi valore `wss://…` (UISP) | `${UISP_ENROLLMENT}` |
| `snmp.community` / `snmp.contact` / `snmp.location` | `${SNMP_COMMUNITY}` / `${SNMP_CONTACT}` / `${SNMP_LOCATION}` |
| `resolv.host.1.name` | `${DEVICE_NAME}` |
| `httpd.port` / `httpd.https.port` / `sshd.port` | `${HTTP_PORT}` / `${HTTPS_PORT}` / `${SSH_PORT}` |
| `pwdog.host` / `ntpclient.N.server` | `${WATCHDOG_HOST}` / `${NTP_SERVER}` |
| `dhcpd.1.start` / `end` / `lease_time` / `netmask` | `${DHCP_START}` / `${DHCP_END}` / `${DHCP_LEASE}` / `${LAN_NETMASK}` |
| `netconf.N.ip` / `netmask` dell'interfaccia di `dhcpd.1.devname` | `${LAN_IP}` / `${LAN_NETMASK}` |

Le righe che contengono già un `${…}` restano invariate. Si può quindi caricare anche un template preparato a mano, o ricaricare quello scaricato dopo averlo ritoccato. Se dopo la sostituzione resta un valore che sembra un segreto (chiave che termina in `psk`, `password`, `secret`, `key`…), l'anteprima lo segnala.

### Più template per modello e modifica dalla console

Ogni modello può avere più template con nomi diversi, per esempio *Standard*, *Palo alto* o *Bassa potenza*:
- uno è il **predefinito**, usato quando nell'app non se ne sceglie un altro;
- nell'app Android, se il modello ha più template, compare il selettore **Template** nel passo "1 · CPE".

Nella console, in **Profili airOS**, per ciascun template:
- **Modifica**: editor del testo completo.
  - Un clic su un placeholder lo inserisce nel punto del cursore.
  - **Controlla** verifica il template senza salvarlo.
  - **Salva modifiche** rifiuta i template non validi, per esempio con una VLAN o un placeholder sconosciuto.
  - Puoi cambiare anche nome, board match e predefinito.
- **Duplica**: apre una copia da salvare con un altro nome. È il modo rapido per creare una variante.
- **Rendi predefinito**.
- **Elimina**: se elimini il predefinito, diventa predefinito il template modificato più di recente. Se elimini l'ultimo, il provisioning di quel modello resta bloccato finché non ne crei uno.

**Nuovo template** può partire da un backup della CPE, con i placeholder inseriti in automatico, e va poi rifinito nell'editor. I nomi sono unici per modello (senza distinzione maiuscole/minuscole). Ogni job registra nello storico il nome del template usato.

Ogni template viene cifrato (AES-256-GCM); nell'elenco se ne mostra solo lo SHA-256. Il testo è visibile solo agli admin, nell'editor.

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
