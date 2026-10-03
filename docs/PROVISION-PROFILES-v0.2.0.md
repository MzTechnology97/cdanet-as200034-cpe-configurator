# Profili airOS per provisioning CDA Net v0.4.2

## Scopo

Il provisioning Android non inventa o genera da zero chiavi `system.cfg`. Ogni modello deve usare un export di configurazione reale, preparato e validato in laboratorio su **airOS 8.7.4**. Il profilo viene caricato da un Admin tramite la PWA, cifrato dal backend e non viene salvato nel repository Git.

## Modelli supportati

- NanoStation Loco 5AC
- NanoStation 5AC
- NanoBeam 5AC
- LiteBeam 5AC
- PowerBeam 5AC

Il backend accetta profili di provisioning solamente per firmware target 8.7.4.

## Procedura di creazione profilo

1. Factory-reset di una CPE da laboratorio.
2. Completare il primo avvio usando esclusivamente impostazioni consentite per la rete CDA Net.
3. Portare la CPE a firmware 8.7.4.
4. Configurare manualmente una configurazione campione completa e funzionante: Station, Router/PPPoE, management, UISP/SNMP secondo policy aziendale.
5. Esportare `system.cfg`.
6. Sostituire esclusivamente i valori variabili con i placeholder elencati sotto.
7. Caricare il file dalla sezione **Backend / Admin**.
8. Impostare obbligatoriamente una regex `boardMatch` che identifichi la board attesa da `/etc/board.info`.
9. Provare il profilo su una seconda CPE da laboratorio prima dell'uso in campo.

## Placeholder supportati

- `${SSID}`
- `${WPA2_PSK}`
- `${PPPOE_USER}`
- `${PPPOE_PASSWORD}`
- `${HTTP_PORT}`
- `${HTTPS_PORT}`
- `${UISP_ENROLLMENT}`
- `${SNMP_COMMUNITY}`
- `${SNMP_CONTACT}`
- `${SNMP_LOCATION}`
- `${DEVICE_NAME}`
- `${CPE_USERNAME}`
- `${CPE_PASSWORD}`
- `${EXPECTED_MAC}`
- `${EXPECTED_SERIAL}`
- `${LAN_IP}`
- `${LAN_NETMASK}`
- `${DHCP_START}`
- `${DHCP_END}`
- `${DHCP_LEASE}`
- `${PPPOE_MTU}`
- `${PPPOE_MRU}`
- `${WATCHDOG_HOST}`
- `${NTP_SERVER}`
- `${SSH_PORT}`
- `${DISCOVERY_PORT}`

Il plugin Android rifiuta valori contenenti CR/LF/NUL e rifiuta il profilo se, dopo la sostituzione, rimane un placeholder non valorizzato.

La v0.4.2 forza inoltre, indipendentemente dal template:
- `pwdog.host=8.8.8.8` e watchdog attivo;
- `snmp.status=enabled`, community `public`, contact `172.31.0.7`;
- `snmp.location=COGNOME NOME`, derivato dallo username RADIUS/PPPoE prima di `@cda-net.it`;
- Calculate EIRP Limit disattivato tramite i flag airOS previsti;
- Automatic Power Control lato Station attivo;
- Device Name `COGNOME NOME`;
- nessuna VLAN nel provisioning CDA Net attuale.

## Segreti

I segreti runtime sono forniti al backend tramite environment/secrets e non devono essere inseriti in Git:

- `CPE_ADMIN_USERNAME`
- `CPE_ADMIN_PASSWORD`
- `UISP_ENROLLMENT`
- `SNMP_COMMUNITY`
- WPA2 per singolo SSID, gestita dal database cifrato
- password PPPoE, transitoria e mai inserita nell'audit

Il pacchetto mobile ha TTL breve, viene richiesto dall'APK autenticato e resta solamente nella memoria del processo Android. Alla chiusura del processo o dopo il provisioning deve essere preparato nuovamente.

## Primo avvio

La v0.2.0 apre l'interfaccia locale ufficiale della CPE per il primo avvio/attivazione. Dopo l'attivazione e la disponibilità SSH, il plugin nativo verifica firmware e board prima di trasferire il profilo.

Non vengono automatizzati endpoint web airOS non documentati. Questo evita dipendenze fragili e cambiamenti distruttivi tra build firmware.

## Firmware

Se la CPE non risulta già in 8.7.4 il plugin **blocca la scrittura** con `firmware_normalization_required`. La procedura automatica di downgrade deve essere aggiunta solo dopo prova da banco della specifica procedura/immagine sui cinque modelli supportati.

## Applicazione

Il plugin:

1. verifica che il pacchetto non sia scaduto;
2. limita il target a rete locale e al management IP previsto;
3. apre SSH con le credenziali runtime;
4. legge `/etc/version` e `/etc/board.info`;
5. verifica firmware 8.7.4, `boardMatch` e MAC della CPE;
6. sostituisce i placeholder in memoria;
7. trasferisce `/tmp/system.cfg` via SFTP;
8. persiste la configurazione con `cfgmtd -f /tmp/system.cfg -w -p /etc/` e `sync`;
9. richiede il reboot;
10. elimina il pacchetto preparato dalla memoria.

## Collaudo necessario prima della produzione

Per ogni modello effettuare almeno:

- factory reset;
- primo avvio;
- caricamento profilo;
- associazione al nodo previsto;
- autenticazione PPPoE;
- verifica UISP;
- verifica SNMP;
- HTTP su 20080;
- HTTPS su 20443;
- interruzione volontaria prima del save;
- recupero dopo configurazione errata;
- verifica che nessuna password sia presente in audit/log/cache.
