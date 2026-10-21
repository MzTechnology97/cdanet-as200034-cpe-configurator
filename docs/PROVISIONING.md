# Provisioning airOS · profili e collaudo

## Modelli e firmware

NanoStation Loco 5AC, NanoStation 5AC, NanoBeam 5AC, LiteBeam 5AC, PowerBeam 5AC. Il firmware di produzione è **airOS 8.7.4**.

Con il modulo **Aggiornamento firmware** l'amministratore carica i firmware di riferimento (Amministrazione → Firmware airOS); l'app li scarica sul telefono finché c'è Internet. Una CPE con un firmware diverso (8.7.11, 8.7.25 o anche più vecchio) viene portata alla 8.7.4 dall'app prima della scrittura, nell'installazione e nella scheda Firmware di «CPE collegata»: invio, controllo MD5, scrittura, attesa del riavvio e rilettura della versione. Dopo 2 aggiornamenti non riusciti l'installatore può scrivere comunque con il firmware che ha la CPE, se Impostazioni server → «Provisioning con firmware diverso dopo 2 aggiornamenti non riusciti» lo consente (acceso di serie): resta annotato nell'esito. La versione si legge anche dalle CPE che scrivono solo «WA.v8.7.11» in `/etc/version`.

## Template airOS (più template con nome per ogni modello)

Ogni template contiene la configurazione **completa** della CPE, con i suoi valori. Il server non ha più impostazioni CPE uguali per tutti (fino alla v1.35.10 rete, DHCP, PPPoE, porte, NTP, watchdog, SNMP e UISP stavano in Impostazioni server). Restano del server solo l'**utente e la password admin** delle CPE (Impostazioni server → Credenziali delle CPE), che servono anche a puntamento, diagnosi e collaudo, e l'IP di fabbrica.

### Il modulo: come dall'interfaccia web della CPE

Console → **Profili airOS** → modello → **Nuovo template** oppure **Modifica**. Le schede sono le stesse di airOS:

| Scheda | Cosa si imposta |
|---|---|
| **Wireless** | modalità **Station / Access Point**, **PtMP airMAX / PtP**, codice paese, larghezza di canale, frequenza (AP), limite delle frequenze di scansione (Station), DFS, potenza, guadagno antenna e perdita cavo, distanza (ACK), airMAX, SSID nascosto e isolamento client (AP), WDS |
| **Rete** | **Router / Bridge**, IP e netmask della CPE (LAN), server DHCP (intervallo, lease, DNS proxy), PPPoE (MTU/MRU), NAT, MSS clamping, firewall, port forwarding, UPnP, proxy IGMP, STP. In **bridge**: **Gateway**, **DNS primario** e **DNS secondario** (`route.1.*`, `resolv.nameserver.*`); passando in bridge i DNS predefiniti sono 1.1.1.1 e 8.8.8.8, e un gateway vuoto vuol dire nessun gateway |
| **Servizi** | porte HTTP/HTTPS, SSH (porta, password), Telnet, NTP, ping watchdog (indirizzo, intervallo, attesa, tentativi), contatto e **community SNMP**, UISP e **chiave UISP**, discovery, CDP, syslog remoto |
| **Sistema** | fuso orario, LED (notte, segnale), pulsante di reset, airView, controllo aggiornamenti, invio crash, lingua |
| **Accesso** | chi può usarlo e predefinito (vedi sotto) |
| **Avanzate** | il testo completo del `system.cfg`: le modifiche tornano nel modulo cambiando scheda |

Ogni campo legge e scrive le chiavi reali di airOS 8.7.4. Del testo cambia **solo** ciò che si modifica nel modulo: un template salvato senza cambiare nulla resta identico byte per byte. Un campo che non c'è nel template è mostrato con il suo valore predefinito e viene scritto solo se lo si cambia.

Il riepilogo in alto (es. *Station PtMP · Router · LAN 192.168.1.254*) e i numeri sulle schede mostrano i valori **fuori dalle regole della rete CDA Net**: DFS spento, codice paese 511, banda di scansione 5120-5800 MHz, porte di management 20080/20443, SSH attivo. Sono avvisi, non blocchi.

**Da collaudare al banco**: le chiavi delle modalità *Access Point* e *Bridge* non vengono da un backup di laboratorio. Prima dell'uso in campo prova il template su una CPE di laboratorio, oppure crea il template dal backup di una CPE già configurata così. Lo stesso vale per un template nuovo creato dal solo modulo su un modello mai provato: il server parte dalla struttura di un export reale di airOS 8.7.4 (Station, Router, PPPoE sulla WAN wireless) senza le righe che descrivono la singola CPE (board, capacità radio, MAC), che airOS ricava dall'hardware.

**Segreti**: la community SNMP e la chiave UISP del template sono cifrate (AES-256-GCM), separate dal testo, e non vengono mai mostrate né scritte nel Registro. Nel modulo c'è solo «Impostata: lascia vuoto per non cambiarla». **Duplica** copia anche i segreti senza mostrarli.

### Partire da un backup della CPE

Con **Parti da un backup della CPE (.cfg)** il server prende la configurazione reale di una CPE di laboratorio su 8.7.4 (*System → Back Up Configuration → Download*):
- sostituisce con un placeholder solo i dati del cliente e i segreti;
- tutto il resto diventa il valore del template (LAN, DHCP, porte, radio, servizi…) e si può modificare dal modulo.

Nulla viene salvato finché non premi **Salva nuovo template**. Controlla il **board match** proposto, cioè la regex applicata a `/etc/version`, `/etc/board.info` e `/proc/ubnthal/system.info`, con `cat /etc/board.info` sulla CPE (es. `board\.name=LiteBeam 5AC`).

Righe sostituite in automatico (nomi chiave di airOS 8):

| Chiave nel backup | Placeholder |
|---|---|
| `wireless.N.ssid`, `wpasupplicant.profile.N.network.N.ssid`, `aaa.N.ssid` | `${SSID}` |
| `wpasupplicant.profile.N.network.N.psk`, `aaa.N.wpa.psk` | `${WPA2_PSK}` |
| `ppp.N.name` / `ppp.N.password` | `${PPPOE_USER}` / `${PPPOE_PASSWORD}` |
| `users.1.name` / `users.1.password` | `${CPE_USERNAME}` / `${CPE_PASSWORD_HASH}` |
| qualsiasi valore `wss://…` (UISP) | `${UISP_ENROLLMENT}` |
| `snmp.community` / `snmp.location` | `${SNMP_COMMUNITY}` / `${SNMP_LOCATION}` |
| `resolv.host.1.name` | `${DEVICE_NAME}` |

Se dopo la sostituzione resta un valore che sembra un segreto (chiave che termina in `psk`, `password`, `secret`, `key`…), l'anteprima lo segnala.

### Template degli Specialist

Gli Specialist hanno i propri template (**I miei template**, nella console e nell'app), con lo stesso modulo e un testo tutto loro: possono usare le VLAN e segnaposto propri (`${VLAN_ID}`, `${LAN_IP}`, `${GATEWAY}`, `${DEVICE_NAME}`…), che il flusso chiede per ogni CPE. In più, nella scheda Wireless, l'**SSID** (fisso o da scrivere per ogni CPE) e la **chiave Wi-Fi** (tenuta nel template, cifrata, o scritta per ogni CPE). Con un template in bridge, o con il PPPoE spento, utente e password PPPoE non si chiedono; un gateway vuoto diventa `${GATEWAY}` e si chiede per ogni CPE («Gateway della CPE (IP)», controllato come IPv4). Un template si crea anche dall'app, pure dalla CPE collegata, o come copia di un template CDA Net, che resta com'è. Dettagli in [SPECIALIST-GRUPPI.md](SPECIALIST-GRUPPI.md).

### Template salvati prima della v1.35.11

All'avvio della v1.35.11 ogni template già salvato riceve, una volta sola, i valori che fino ad allora stavano nelle impostazioni del server (LAN, DHCP, MTU/MRU, porte, NTP, watchdog, contatto e community SNMP, chiave UISP). Il server controlla che la configurazione prodotta per lo stesso job sia **identica byte per byte** a prima. Solo allora salva il template convertito e lo registra nel Registro (`template.convert`). Un template che non passa il controllo resta com'era e viene segnalato (`template.convert_failed`). Le CPE già installate e i job in corso non cambiano.

### Più template per modello

Ogni modello può avere più template con nomi diversi, per esempio *Standard*, *Palo alto* o *Ponte PtP*:
- uno è il **predefinito**, usato quando nell'app non se ne sceglie un altro;
- nell'app Android, se il modello ha più template, compare il selettore **Template** nel passo "1 · CPE".

Azioni nell'elenco:
- **Modifica**;
- **Duplica**: è il modo rapido per creare una variante;
- **Rendi predefinito**;
- **Elimina**: se elimini il predefinito, diventa predefinito il template modificato più di recente. Se elimini l'ultimo, il provisioning di quel modello resta bloccato finché non ne crei uno.

I nomi sono unici per modello (senza distinzione maiuscole/minuscole). Ogni job registra nello storico il nome del template usato.

### Chi può usare un template (permessi e template personali)

Nella scheda **Accesso** ci sono due scelte:
- **Tutti gli installatori**;
- **Solo gli installatori selezionati**: con un solo installatore è il suo **template personale**, con più installatori è un template di squadra.
  - **Predefinito per gli installatori selezionati**: nell'app lo trovano già selezionato al posto del predefinito generale.

Regole applicate dal server, sia nell'app sia nel web:
- un installatore vede (nell'app e nella pagina web **Template disponibili**) e può usare **solo** i template a cui ha accesso; un job con un template non consentito viene rifiutato (`template_not_allowed`);
- senza scelta esplicita si usa il suo predefinito personale, se esiste, altrimenti il predefinito generale del modello;
- il predefinito generale deve essere visibile a tutti; per riservarlo, prima rendi predefinito un altro template;
- gli admin vedono e possono usare tutti i template.

Scorciatoia: **Account → installatore → Crea template personale**. Scegli il modello e il punto di partenza (copia di un template esistente, segreti compresi, o modulo nuovo); l'editor si apre con la visibilità già impostata su quell'installatore.

Ogni template viene cifrato (AES-256-GCM); il testo è visibile solo agli admin, nell'editor.

## Placeholder

Sono rimasti solo i valori che cambiano per ogni cliente e i segreti:

| Placeholder | Valore |
|---|---|
| `${SSID}` / `${WPA2_PSK}` | SSID `CDA-NET-N{nodo}-D{distretto}` e la sua chiave (dal DB cifrato) |
| `${PPPOE_USER}` / `${PPPOE_PASSWORD}` | Credenziali RADIUS del cliente (la password non viene mai salvata) |
| `${CPE_USERNAME}` | `CPE_ADMIN_USERNAME` (server) |
| `${CPE_PASSWORD_HASH}` | `CPE_ADMIN_PASSWORD` (server) in MD5-crypt `$1$…`: **da usare in `users.1.password`** |
| `${CPE_PASSWORD}` | Password in chiaro: solo dove airOS la vuole in chiaro, mai in `users.N.password` |
| `${UISP_ENROLLMENT}` | Chiave UISP **del template** |
| `${SNMP_COMMUNITY}` | Community SNMP **del template** |
| `${SNMP_LOCATION}` / `${DEVICE_NAME}` | nome di sistema: «COGNOME NOME» o la ragione sociale dal CRM, poi dal cliente dell'intervento, per ultimo dall'utente PPPoE; maiuscolo, solo lettere, cifre e spazi |
| `${EXPECTED_MAC}` / `${EXPECTED_SERIAL}` | MAC e seriale indicati dall'installatore |

I placeholder che erano valori del server (`${LAN_IP}`, `${LAN_NETMASK}`, `${DHCP_START}`, `${DHCP_END}`, `${DHCP_LEASE}`, `${PPPOE_MTU}`, `${PPPOE_MRU}`, `${HTTP_PORT}`, `${HTTPS_PORT}`, `${SSH_PORT}`, `${DISCOVERY_PORT}`, `${NTP_SERVER}`, `${WATCHDOG_HOST}`, `${SNMP_CONTACT}`) non sono più accettati (`retired_placeholders`): al loro posto si scrive il valore o si usa il modulo.

La sostituzione avviene in un solo passaggio: un valore che contiene `${…}` non viene ri-espanso. Valori con CR/LF/NUL vengono rifiutati.

## Policy sempre forzata dal server

Indipendentemente dal testo del template, con i valori **del template**:
- `pwdog.status=enabled`
- `pwdog.host` = indirizzo del ping watchdog del template
- `snmp.status=enabled`
- `snmp.community` = community del template
- `snmp.contact` = contatto SNMP del template
- `snmp.location=COGNOME NOME`
- `system.eirp.status=disabled`
- `radio.1.obey=disabled` (Calculate EIRP Limit OFF)
- `radio.1.atpc.sta.status=enabled` (Automatic Power Control Station ON)
- `resolv.host.1.name=COGNOME NOME`
- `resolv.host.1.status=enabled`
- `system.latitude` / `system.longitude` = posizione della CPE

Un template CDA Net con `vlan.*`, `ebtables.sys.vlan.*` o `ppp.N.devname=ath0.X` viene rifiutato sia al caricamento sia al rendering (WAN wireless in PPPoE senza VLAN). I template degli Specialist possono usare le VLAN.

## Controlli eseguiti dall'app prima di scrivere

1. Il pacchetto non è scaduto e lo SHA-256 della configurazione coincide.
2. Il target è un indirizzo privato: quello trovato dalla discovery, altrimenti gli indirizzi abituali (vedi [FIELD-TOOLS.md](FIELD-TOOLS.md#come-il-telefono-raggiunge-la-cpe)).
3. La stringa di `/etc/version` contiene esattamente `v8.7.4` (non 8.7.41, 18.7.4…); altrimenti l'app aggiorna il firmware, o scrive con il firmware della CPE se l'installatore lo sceglie dopo 2 aggiornamenti non riusciti.
4. Il board match del profilo corrisponde.
5. `board.hwaddr` / `eth0.macaddr` coincidono con il MAC indicato.
6. Dopo il trasferimento, dimensione e MD5 di `/tmp/system.cfg` coincidono.

## Collaudo per ciascun modello (gate di produzione)

- [ ] factory reset → primo avvio nell'app → provisioning completo
- [ ] associazione al nodo previsto, PPPoE autenticato
- [ ] UISP connesso, SNMP risponde con location corretta
- [ ] management HTTP 20080 / HTTPS 20443
- [ ] CPE con firmware diverso da 8.7.4 → aggiornamento alla 8.7.4 dall'app, poi scrittura
- [ ] template in Access Point, PtP e Bridge (con gateway e DNS) su una CPE di laboratorio
- [ ] MAC errato → scrittura bloccata
- [ ] interruzione (Wi-Fi staccata) prima di `cfgmtd` → CPE invariata, nuovo tentativo riuscito
- [ ] esito sincronizzato sul server; nessuna password in storico, log o cache
