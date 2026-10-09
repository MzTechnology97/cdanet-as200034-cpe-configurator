# Stato rete (modulo, spento di default)

Stato di POP e AP, aggiornato ogni minuto, sul web (**Stato rete**) e nell'app (riquadro **Stato rete**).

Per ogni AP:
- **in funzione**, **non raggiungibile** (con l'ultimo contatto) o **molte CPE offline** (almeno il 30% delle CPE dell'AP, con almeno 3 CPE: probabile problema di settore, non del singolo cliente);
- CPE online / totali (per gli installatori solo se l'amministratore lo consente, altrimenti "alcune/molte CPE offline");
- **guasto Enel vicino**, se l'utente ha anche il modulo Guasti Enel e un guasto tocca quel POP/AP.

Il POP è "non raggiungibile" quando lo sono tutti i suoi AP. I problemi sono in cima all'elenco.

## Chi vede cosa

- **Amministratori**: tutti i POP e gli AP, con i dati da UISP.
- **Installatori**: solo i POP/AP assegnati (Account → "POP/AP assegnati agli installatori"; un POP include i suoi AP). Solo nomi e stato: niente posizioni, indirizzi o riferimenti alla fonte dei dati.
- **Nessuna notifica** agli installatori (per ora).

Il modulo si attiva da **Funzionalità**, anche solo per alcuni account.
