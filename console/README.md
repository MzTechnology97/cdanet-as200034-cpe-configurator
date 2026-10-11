# Console web (React + Vite)

La console degli admin e degli installatori. Il codice è in `console/`; la build finisce in `web/app/`, che il server serve sotto `/app/` con file a impronta (cache di un anno). `web/app/` non va nel repository: la costruisce l'immagine Docker.

| Comando | Cosa fa |
| --- | --- |
| `npm ci` | installa le dipendenze |
| `npm run dev` | console su http://localhost:5173 con ricaricamento immediato, API e mappe dal server demo su :8799 (`CONSOLE_API` per un altro server) |
| `npm run build` | controllo dei tipi e build in `web/app/` |
| `npm run typecheck` | solo il controllo dei tipi |

In sviluppo il server usa `web/app/` se esiste, altrimenti i file di `web/` così come sono. Dopo aver cambiato una pagina, rifai la build oppure cancella `web/app/`, altrimenti il server mostra la build vecchia.

Le pagine non ancora convertite sono i moduli di `web/js/`, inclusi così come sono nella build. Il piano di migrazione, con le fasi e l'ordine delle pagine, è nel documento "Piano nuovo frontend React CDA Net".
