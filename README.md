# CDA Net CPE Configurator · v1

Piattaforma CDA Net (AS200034) per installare, collaudare e seguire le CPE Ubiquiti airMAX AC dei clienti: provisioning, strumenti di campo, NOC, copertura e monitoraggio della rete.

| Componente | Cartella | Ruolo |
|---|---|---|
| **Server** | [`server/`](server) | Node.js 24 + TypeScript. Unica fonte della policy CDA Net: account e ruoli, segreti cifrati, template airOS, **generazione del `system.cfg` finale**, storico e collaudi, interventi, copertura, integrazioni (UISP, ISP Billing, Victron, MyWic, Telegram, Firebase), connettore MCP per Claude, canale aggiornamenti Android. |
| **Console web** | [`console/`](console) → `web/app` | React 19 + Vite, servita dal server: NOC, amministrazione, copertura e le pagine degli installatori e degli Specialist. In [`web/`](web) restano i file serviti così come sono e la guida installatore (`web/wiki`). |
| **App Android** | [`android/`](android) | Kotlin + Jetpack Compose. Client di campo: interventi del giorno, installazione guidata con discovery Ubiquiti, scrittura sulla CPE anche senza Internet, puntamento, collaudo con speedtest e foto, copertura e realtà aumentata, strumenti LAN (Wi-Fi, scansione, SNMP, TVCC, RouterOS). |
| **Deploy** | [`deploy/`](deploy) | Docker Compose con immagine pubblicata dalla CI su GHCR, reverse proxy Caddy e **container updater con rollback automatico**. |
| **Strumenti** | [`tools/`](tools), [`scripts/`](scripts) | Ponte Telegram del team, logo, controllo della versione in CI. |

```
 Admin/NOC, Specialist (browser) ──HTTPS──▶ ┌──────────── server (Docker) ────────────┐
                                            │ policy · template cifrati · WPA2 · job    │
 App Android ──(online)───────────────────▶ │ POST /api/provisioning/jobs → system.cfg  │
     │                                      └───────────────────────────────────────────┘
     │ Wi-Fi della CPE (anche senza Internet)
     ▼
 CPE airOS 8.7.4  ◀── discovery · SSH: firmware/board/MAC → /tmp/system.cfg → cfgmtd → reboot
```

## Flusso di installazione

1. **Online**, di solito in anticipo: l'intervento arriva in Oggi con cliente, indirizzo e PPPoE; l'installatore sceglie la CPE dal suo magazzino. Il server genera il `system.cfg` definitivo (template del modello + segreti + policy CDA Net) e lo consegna **solo all'app**, cifrato sul telefono, con scadenza. Per le installazioni del giorno l'app lo prepara da sola per gli AP migliori («pronto offline»).
2. **Sul tetto, anche senza Internet**: il telefono si collega alla Wi-Fi di management della CPE dall'app, mentre resta su Internet con la rete mobile. La discovery Ubiquiti trova la CPE qualunque IP abbia; poi via SSH l'app:
   - controlla modello, MAC e firmware, e se serve porta la CPE alla **8.7.4**;
   - trasferisce `/tmp/system.cfg` e ne controlla dimensione e MD5;
   - salva con `cfgmtd -f /tmp/system.cfg -w -p /etc/ && sync` e riavvia la CPE.
3. **Aggancio, puntamento e collaudo**: aggancio all'AP (o cambio AP), puntamento con bip e realtà aumentata, misure e foto dal tetto, speedtest sulla Wi-Fi del cliente confrontato con il suo profilo, collaudo con il rapporto in PDF.
4. **Esito**: esiti, collaudi e foto, senza password, restano in coda sul telefono e partono appena torna la rete. Il NOC accetta la CPE in UISP, con il nuovo subscriber se c'è il CRM di UISP.

Ogni template airOS contiene la configurazione completa della CPE e si imposta da un modulo come l'interfaccia web della CPE. Il server forza solo nome di sistema, posizione e poche chiavi di policy. Dettagli in [docs/PROVISIONING.md](docs/PROVISIONING.md).

## Aggiornamenti automatici

- **Server**: ogni push su `main` con test verdi pubblica `ghcr.io/mztechnology97/cdanet-cpe-server:stable`. Ogni 5 minuti il container `updater` sul server:
  1. scarica la nuova immagine;
  2. fa il backup del database (`VACUUM INTO`);
  3. riavvia l'app;
  4. se l'health-check fallisce, torna alla versione precedente.
- **App Android**: a ogni nuova `VERSION` la CI firma l'APK e crea una GitHub Release. Il server la scarica e ne verifica lo SHA-256. L'app trova l'aggiornamento all'avvio e ogni 15 minuti, lo scarica, verifica lo SHA-256 e lo installa; con l'aggiornamento obbligatorio (di serie) una versione vecchia non entra.

Per pubblicare una nuova versione:
1. incrementa [`VERSION`](VERSION) e `server/package.json` (con `package-lock.json`); la patch non supera mai 99 (dopo 1.32.99 viene 1.33.0);
2. aggiungi la riga in [docs/ROADMAP.md](docs/ROADMAP.md);
3. fai merge su `main` con la CI verde. Ogni PR deve toccare `VERSION` o `android/`: la build Android è un controllo obbligatorio.

Guida completa: [docs/DEPLOY.md](docs/DEPLOY.md).

## Sviluppo

```bash
cd server && npm ci && npm test        # oltre 330 test: dominio, API, flussi con servizi finti
npm run typecheck
cd ../console && npm ci && npm run build   # console in web/app
```

Server locale con la console:

```bash
JWT_SECRET=dev-secret-0123456789abcdefghijklmnop ADMIN_PASSWORD=Dev-Admin-Password-1 \
SECRETS_KEY_FILE=.dev/master.key DB_PATH=.dev/dev.sqlite STATIC_DIR=web node server/src/main.ts
```

Per la console con il ricaricamento immediato: `cd console && npm run dev` (vedi [console/README.md](console/README.md)).

Per l'app Android:
- apri `android/` in Android Studio (Gradle 8.11.1 da `gradle-wrapper.properties`);
- oppure, con Gradle installato: `gradle -p android testDebugUnitTest assembleDebug lintRelease`. Con `CDA_DEFAULT_BACKEND=http://10.0.2.2:<porta>` la build di debug parla con un server locale dall'emulatore.

## Documentazione

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): componenti, API, modello dati
- [docs/PROVISIONING.md](docs/PROVISIONING.md): template airOS, segnaposto, firmware, collaudo al banco
- [docs/FIELD-TOOLS.md](docs/FIELD-TOOLS.md): l'app sul campo, dall'intervento al collaudo, e gli strumenti
- [docs/COPERTURA.md](docs/COPERTURA.md): verifica di copertura, stima del segnale, simulazioni, altri operatori, fattibilità
- [docs/NOC.md](docs/NOC.md): interventi, collaudi, Salute CPE, diagnosi, magazzino, avvisi, IA-AP, report, backup
- [docs/SPECIALIST-GRUPPI.md](docs/SPECIALIST-GRUPPI.md): Specialist, gruppi di lavoro e direttore tecnico
- [docs/UISP.md](docs/UISP.md), [docs/CRM.md](docs/CRM.md): integrazioni con UISP e ISP Billing
- [docs/STATO-RETE.md](docs/STATO-RETE.md), [docs/GUASTI-ENEL.md](docs/GUASTI-ENEL.md), [docs/MAPPE.md](docs/MAPPE.md)
- [docs/NOTIFICHE.md](docs/NOTIFICHE.md), [docs/MODULI.md](docs/MODULI.md)
- [docs/MCP.md](docs/MCP.md): Connetti il tuo Claude
- [docs/ACCESSI-BLOCCATI.md](docs/ACCESSI-BLOCCATI.md), [SECURITY.md](SECURITY.md)
- [docs/DEPLOY.md](docs/DEPLOY.md): installazione Debian, auto-update, firma APK, backup
- [docs/ROADMAP.md](docs/ROADMAP.md): cosa è uscito, cosa resta da fare e da verificare sul campo
- [docs/MIGRATION-v1.md](docs/MIGRATION-v1.md): passaggio dalla v0.5.x (storico)
- Guide d'uso: guida installatore (`/wiki/` del server, anche dall'app) e guida amministratore (nella console)

## Limiti noti

Le funzioni scritte e provate senza l'apparato reale vanno verificate su una CPE di laboratorio prima dell'uso in produzione: l'elenco è in [docs/ROADMAP.md](docs/ROADMAP.md#da-verificare-sul-campo). Compilazione e test automatici non sostituiscono la prova al banco sui 5 modelli.
