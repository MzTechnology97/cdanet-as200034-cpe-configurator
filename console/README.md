# Console web (React + Vite)

La console degli admin e degli installatori. Il codice è in `console/`; la build finisce in `web/app/`, che il server serve sotto `/app/` con file a impronta (cache di un anno). `web/app/` non va nel repository: la costruisce l'immagine Docker.

| Comando | Cosa fa |
| --- | --- |
| `npm ci` | installa le dipendenze |
| `npm run dev` | console su http://localhost:5173 con ricaricamento immediato, API e mappe dal server demo su :8799 (`CONSOLE_API` per un altro server) |
| `npm run build` | controllo dei tipi e build in `web/app/` |
| `npm run typecheck` | solo il controllo dei tipi |

In sviluppo il server usa `web/app/` se esiste, altrimenti i file di `web/` così come sono. Dopo aver cambiato una pagina, rifai la build oppure cancella `web/app/`, altrimenti il server mostra la build vecchia.

## Struttura

| Cartella | Cosa contiene |
| --- | --- |
| `src/shell/` | la cornice: barra in alto (Ctrl+K per andare a una pagina, tema, notifiche, account), menu (stretto a sole icone su richiesta), barra in basso sul telefono, elenco delle pagine con chi le vede (`routes.ts`) |
| `src/ui/` | i componenti (pulsanti, schede, badge, avvisi, numeri-filtro, campi, scelte, stati vuoti, caricamento): ogni pagina convertita usa solo questi |
| `src/styles/tokens.css` | colori, spazi, raggi, tipografia e ombre nei due temi: unica fonte, letta anche dalle pagine di `web/js` e riferimento per l'app Android |
| `src/pages/` | le pagine convertite (`#/ui`, solo admin: tutti i componenti nei due temi) |
| `src/lib/api.ts` | il client delle API con i tipi |

Una pagina nuova si aggiunge in `src/shell/routes.ts` (con `admin`, `installer` o `module` come le altre: il server applica le stesse regole). `web/js/main.js` resta solo per il funzionamento senza build: le pagine nuove non vanno aggiunte lì.

Le pagine non ancora convertite sono i moduli di `web/js/`, inclusi così come sono nella build. Il piano di migrazione, con le fasi e l'ordine delle pagine, è nel documento "Piano nuovo frontend React CDA Net".
