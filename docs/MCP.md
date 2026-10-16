# Connetti il tuo Claude (MCP, sola lettura)

Gli account admin possono collegare il proprio Claude alla piattaforma per il **monitoraggio**. Claude può leggere lo stato della rete, le interruzioni, le batterie dei POP, la salute della piattaforma, gli avvisi del NOC, gli interventi, il magazzino, le statistiche e la diagnosi di un cliente. Non può modificare nulla né inviare comandi alle CPE.

## Sicurezza

- Solo account **admin** con la **verifica in due passaggi** attiva. Il consenso si dà con utente, password e codice.
- OAuth 2.1 con PKCE (S256). Gli indirizzi di ritorno sono esatti: `https`, oppure `http` solo verso lo stesso computer.
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
