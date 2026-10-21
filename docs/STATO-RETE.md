# Stato rete (modulo, spento di default)

Stato dei POP e degli AP letto da UISP, nella console (**Stato rete**) e nell'app (**Rete → Stato rete**). La pagina si aggiorna da sola: la console riceve gli eventi del server, l'app rilegge a ogni apertura e con «Aggiorna».

## Cosa mostra

Per ogni AP:
- **stato**:
  - **in funzione**;
  - **non raggiungibile**, con l'ultimo contatto;
  - **molte CPE offline**: almeno il 30% delle CPE dell'AP offline, con almeno 3 CPE. Indica un probabile problema di settore, non del singolo cliente;
- **CPE online e totali**. Agli installatori i numeri compaiono solo se l'amministratore lo consente; altrimenti vedono «alcune» o «molte CPE offline»;
- **guasto Enel vicino**, se l'utente ha anche il modulo Guasti Enel e un guasto tocca quel POP o AP (vedi [GUASTI-ENEL.md](GUASTI-ENEL.md)).

Un POP è «non raggiungibile» quando lo sono tutti i suoi AP. I problemi stanno in cima. I collegamenti punto-punto (SSID `CDA-NET-N…-D…` dei PtP) non sono contati come AP.

### Batterie dei POP (Victron)

Per i POP con un impianto Victron collegato (Connettori → Victron VRM, vedi [NOC.md](NOC.md#batterie-dei-pop-victron)) Stato rete mostra:
- lo stato della batteria: ok, bassa (sotto il 30% o con l'avviso di VRM), allarme, nessun dato da oltre un'ora;
- carica, tensione, potenza in carica o scarica, fotovoltaico e ultimo dato;
- **off-grid** per gli impianti senza rete sull'ingresso AC.

Il riepilogo conta i POP con la batteria in allarme o muta. Gli installatori vedono solo l'essenziale: stato, carica, se è in scarica, off-grid.

### Solo per gli amministratori

- **Mappa** di tutta la rete con POP, AP e il settore servito: quello dell'antenna vera, se in Antenne degli AP sono indicati antenna e azimut, altrimenti l'arco dei clienti. Vedi [MAPPE.md](MAPPE.md).
- **Sessioni PPPoE per AP** (con il CRM di ISP Billing): online, offline e account sospesi delle CPE di ogni AP, abbinate per MAC. Gli account cessati non contano.
- **Età dei dati**: se UISP è lento o non risponde la pagina mostra l'ultimo elenco salvato e da quanto tempo.

Nella console il riepilogo in alto è fatto di riquadri: «non raggiungibili», «con molte CPE offline» e «POP con batteria da controllare» fanno anche da filtro. Sotto ci sono i filtri per stato, la ricerca di POP, AP o SSID, la mappa e l'elenco.

## Chi vede cosa

- **Amministratori**, e Specialist con visibilità piena (direttore tecnico): tutti i POP e gli AP, con posizioni e dati.
- **Installatori**, e Specialist senza visibilità piena: solo i POP e gli AP assegnati (Account → «POP/AP assegnati agli installatori»; un POP include i suoi AP). Vedono solo nomi e stato: niente posizioni, indirizzi, mappa o riferimenti alla fonte dei dati.
- Gli **avvisi** di AP o POP giù arrivano solo agli amministratori (avvisi proattivi, vedi [NOC.md](NOC.md#avvisi-proattivi)); agli installatori nessuna notifica.

Il modulo si attiva da **Funzionalità**, anche solo per alcuni account (vedi [MODULI.md](MODULI.md)). L'API è `GET /api/network/status`.
