# Connetti il tuo Claude (MCP)

Gli account admin possono collegare il proprio Claude alla piattaforma. Di serie Claude legge soltanto: stato della rete, interruzioni, batterie dei POP, salute della piattaforma, avvisi del NOC, interventi, magazzino, statistiche, copertura e la diagnosi di un cliente. Con un consenso esplicito («Consenti anche le modifiche», vedi sotto) può anche fare alcune modifiche, sempre dopo una conferma dell'utente e una CPE alla volta. La pagina della console è Amministrazione → **Connetti il tuo Claude**, con gli strumenti divisi tra lettura e scrittura e le connessioni attive.

## Cosa legge

In sola lettura Claude ha a disposizione tutti i moduli:
- **rete:** stato della rete, salute della piattaforma, gestione rete, infrastruttura, salute e andamento delle CPE, consigli e proposte dell'ottimizzatore;
- **corrente:** interruzioni e mappa dei guasti, batterie dei POP;
- **copertura:**
  - copertura CDA Net;
  - **altri operatori (WIC)**, per punto o per indirizzo esatto con la ricerca guidata, e fattibilità;
  - ricerca di indirizzi e coordinate, puntamento, profilo del terreno e orizzonte, simulazione di un AP, precisione delle stime;
  - verifiche salvate e i clienti di ISP Billing da collegare a una verifica;
- **clienti:** clienti e account PPPoE del CRM, ricerca del cliente per un intervento;
- **installazioni:** installazioni, collaudi e storico, stato in UISP, KO, speedtest, diagnosi;
- **interventi:** interventi e loro cronologia;
- **magazzino:** giacenze, magazzini, movimenti, CPE smontate;
- **NOC:** avvisi, accessi bloccati e registro degli accessi, statistiche, report mensile, site e piani UISP, firmware, antenne, stato del server.

Fuori: connettori, impostazioni del server, privacy, chiavi Wi-Fi.

## Lettura e scrittura

Nella pagina di consenso si sceglie:
- **solo lettura**: il comportamento predefinito;
- **«Consenti anche le modifiche»**: serve un **secondo codice nuovo** (il successivo dell'app, oppure un codice di recupero), così il permesso di scrittura è una scelta esplicita. Per passare da lettura a scrittura serve sempre un nuovo consenso: il rinnovo del token non lo cambia.

Gli strumenti di scrittura:
- **interventi:** crea, modifica o sposta (anche rimandare o annullare), elimina;
- **NOC:** approva o rifiuta un collaudo, dichiara superato un collaudo con il motivo;
- **magazzino:** aggiorna lo stato di una CPE smontata (RMA);
- **copertura:** salva una verifica con il nome del cliente, rinominala;
- **rete:**
  - riavvia, rileggi e aggiorna il firmware di una CPE;
  - fai un backup o ripristinalo;
  - cambia la radio (mai le chiavi Wi-Fi);
  - modifica nome, note e manutenzione;
  - autorizza in UISP la CPE di un'installazione.

Restano fuori da Claude, per sicurezza:
- sblocco degli accessi bloccati;
- revoca delle connessioni;
- account e ruoli;
- connettori;
- impostazioni del server;
- privacy;
- ottimizzatore degli AP;
- nuovo subscriber nel CRM;
- password PPPoE e chiavi Wi-Fi.

Un Claude compromesso non può darsi altri permessi né togliere i blocchi.

Regole per le scritture:
- Claude chiede conferma all'utente prima di ogni modifica. Gli strumenti sono segnati come modifiche, e quelli sulla rete o di eliminazione come distruttivi.
- **Rete una CPE alla volta**: al massimo 5 azioni sulla rete all'ora per connessione; le altre si fanno dalla console.
- **Prompt injection.** Quello che restituiscono gli strumenti esce dentro `dati`, con l'avviso che il testo scritto dagli utenti è un dato e non un'istruzione: note, nomi, motivi dei KO, hostname delle CPE. Anche le istruzioni del server lo dicono a Claude.
- Ogni modifica finisce nel Registro come «modifica via Claude», con l'esito. Ogni modifica, non solo quelle sulla rete, manda anche un avviso al NOC su Telegram: chi, cosa, su cosa, se è riuscita.

Una connessione in sola lettura che prova una modifica riceve l'invito a ricollegarsi con le modifiche.

## Sicurezza

- Solo account **admin** con la **verifica in due passaggi** attiva. Il consenso si dà con utente, password e codice.
- OAuth 2.1 con PKCE (S256). Si torna solo alle app di Claude (`https://claude.ai`, `https://claude.com`) oppure a questo computer (`http://localhost`, `127.0.0.1`): un altro sito non può ricevere un consenso dato sulla nostra pagina. Il nome del client lo decide il server, e la pagina di consenso mostra in evidenza dove si tornerà.
- Token di accesso di un'ora; token di rinnovo di 30 giorni, che ruotano a ogni uso. Si salvano solo come impronta (SHA-256). Un token di rinnovo già usato che ricompare chiude la connessione.
- La connessione si chiude subito se l'admin viene disattivato, perde il ruolo, cambia password o toglie la verifica in due passaggi. Si revoca anche dalla console.
- Le risposte escono ripulite:
  - mai password, chiavi, token, segreti WPA/RADIUS;
  - mai telefoni, email o codici fiscali dei clienti (GDPR, minimizzazione);
  - elenchi limitati a 200 elementi.
- Ogni richiesta finisce nel Registro con il nome dello strumento, non con i dati.
- Massimo 120 richieste al minuto per connessione. La registrazione dei client è limitata e i client mai usati si cancellano dopo un giorno.

Nota GDPR: quello che Claude legge passa da Anthropic. Per i dati dei clienti serve un accordo sul trattamento dei dati (DPA) con Anthropic.

## Collegarsi

L'indirizzo del connettore è `https://<server>/mcp`. Il login apre la pagina «Connetti il tuo Claude» della piattaforma.

### A · Claude Desktop sul PC, server non esposto su Internet

Il PC deve raggiungere il server (ufficio o VPN). Serve Node.js sul PC.

1. Scarica il certificato della piattaforma: sul server `sudo cdanet-cpe https-ca`, salvato per esempio in `C:\cdanet\cdanet-ca.crt`.
2. In Claude Desktop → Impostazioni → Sviluppatore → «Modifica configurazione», aggiungi:

   ```json
   {
     "mcpServers": {
       "cdanet": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "https://<server>/mcp"],
         "env": { "NODE_EXTRA_CA_CERTS": "C:\\cdanet\\cdanet-ca.crt" }
       }
     }
   }
   ```

3. Riavvia Claude Desktop. Al primo uso si apre il browser con la pagina di consenso: utente, password, codice, «Consenti».

`mcp-remote` è un pacchetto open source di terze parti che fa da ponte tra Claude Desktop e un server MCP remoto. Funziona solo sul PC, non nell'app del telefono.

### B · Anche dal telefono, senza aprire porte

Un tunnel (per esempio Cloudflare Tunnel con un dominio dell'azienda) pubblica con un certificato valido solo `/mcp`, `/oauth/*` e `/.well-known/oauth-*`. Poi si usa come in C.

### C · Server con dominio e certificato

In Claude (Desktop o web) → Impostazioni → Connettori → «Aggiungi connettore personalizzato» → `https://<dominio>/mcp`. Il connettore resta legato all'account Claude e si trova anche nell'app del telefono. Serve un piano Claude a pagamento.

## Per la console

- `GET /api/admin/mcp` → `{ url, tools: [{name, title}], connections: [{ id, username, client, createdAt, lastUsedAt, calls, revokedAt, active }] }`
- `DELETE /api/admin/mcp/connections/:id` → revoca (evento `mcp.revoke`)
- Eventi nel Registro: `mcp.authorize` (collegamento), `mcp.call` (strumento usato), `mcp.revoke`.
