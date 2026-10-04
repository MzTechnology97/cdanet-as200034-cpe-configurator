# CDA Net Web Bridge

Companion locale per usare dalla PWA le funzioni che i browser non espongono direttamente: Wi-Fi scan, ARP/neighbor, discovery LAN, SNMP locale, ONVIF/SADP, apertura SSH/RDP/RTSP e provisioning della CPE.

## Avvio rapido

Richiede Node.js 20+.

```bash
cd web-agent
npm install
CDA_WEB_BRIDGE_ORIGIN=http://172.31.0.29 npm start
```

Il bridge ascolta **solo su 127.0.0.1:18990** e stampa un pairing token. Inserire quel token nella PWA. Non pubblicare la porta in LAN/WAN.

Per HTTPS pubblico impostare `CDA_WEB_BRIDGE_ORIGIN=https://cpe.cda-net.it`.

## Sicurezza

- loopback only;
- pairing token obbligatorio per tutte le operazioni tranne /health;
- credenziali CPE/PPPoE/WPA2 restano in memoria e non vengono scritte su disco;
- provisioning recupera il pacchetto direttamente dal backend autenticato;
- scansione limitata a reti private/CGNAT /24 o più piccole.

## Nota SSH

Il bridge accetta la host key al primo collegamento per supportare apparati factory/non pre-enrolled. Usarlo solo su reti di management controllate; per RouterOS gestiti è raccomandata una futura modalità di fingerprint pinning.
