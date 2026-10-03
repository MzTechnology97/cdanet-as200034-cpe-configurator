# Riferimento provisioning Ubiquiti legacy CDA Net

Questa nota deriva dal vecchio kit operativo fornito per il confronto. Non contiene password, PSK, hash utente o altri segreti del file originale.

## Flusso osservato

Il kit Windows:
1. porta temporaneamente il PC sulla rete di management della CPE;
2. verifica la raggiungibilità della CPE;
3. legge la versione via SSH;
4. trasferisce uno script in `/tmp` via SCP;
5. esegue lo script via SSH;
6. attende il reboot;
7. verifica l'indirizzo LAN finale.

Lo script airOS:
1. prepara un `system.cfg`;
2. imposta Router Mode e WAN wireless;
3. nel vecchio kit era presente una VLAN WAN, ma non viene usata nel provisioning CDA Net attuale;
4. configura LAN/DHCP;
5. imposta le porte HTTP/HTTPS di management;
6. abilita SSH e servizi di rete previsti dal profilo;
7. imposta NTP e watchdog;
8. persiste con `cfgmtd`;
9. esegue reboot.

## Baseline parametrica v0.4.2

La VLAN legacy è esclusa intenzionalmente: PPPoE usa direttamente la WAN wireless.

I valori storici sono diventati configurazione runtime del backend:
- `CPE_LAN_IP`, `CPE_LAN_NETMASK`
- `CPE_DHCP_START`, `CPE_DHCP_END`, `CPE_DHCP_LEASE`
- `CPE_PPPOE_MTU`, `CPE_PPPOE_MRU`
- `CPE_WATCHDOG_HOST`
- `CPE_NTP_SERVER`
- `CPE_SSH_PORT`
- `CPE_DISCOVERY_PORT`

Ogni modello continua a richiedere un export reale airOS 8.7.4 validato in laboratorio e un `boardMatch` specifico.

## Scelte di sicurezza

Non vengono importati dal kit legacy:
- password/PSK/hash utente hardcoded;
- credenziali PPPoE di esempio;
- callback che scaricano codice via HTTP e lo eseguono direttamente;
- board metadata di una singola LiteBeam;
- frequenza, tx power, antenna gain o parametri radio specifici di una singola installazione;
- regole DMZ legacy senza nuova validazione.

UISP, SNMP e credenziali restano segreti runtime protetti dal backend.

## Policy radio e identità attuale

- Calculate EIRP Limit: disattivato.
- Automatic Power Control lato Station: attivo.
- Watchdog: 8.8.8.8.
- SNMP: community public, contact 172.31.0.7, location derivata dallo username RADIUS.
- Device Name: COGNOME NOME derivato dallo username RADIUS prima di @cda-net.it.
