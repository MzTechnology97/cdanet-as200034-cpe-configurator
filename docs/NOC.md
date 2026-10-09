# Pagine NOC della console

## Salute rete (admin)

Elenca le CPE che richiedono attenzione, partendo dai dispositivi UISP (cache di un minuto: UISP non viene sovraccaricato). Non mostra la mappa della rete.

| Problema | Regola |
|---|---|
| Offline | stato UISP `disconnected`, `inactive` o `unknown` (con l'ultimo contatto) |
| Segnale debole | sotto la soglia minima (−75 dBm), solo per le CPE online |
| Porta LAN | velocità sotto 100 Mbit/s oppure half duplex (`mainInterfaceSpeed` UISP): quasi sempre cavo o connettore |
| Capacità bassa | capacità airMAX in download sotto 100 Mbit/s |
| Da accettare | CPE ancora in attesa in UISP |
| Firmware | diverso dallo standard CDA Net (8.7.4) |

L'ordine mette in cima i casi più gravi (offline, poi segnale debole e porta LAN). Per ogni CPE c'è il link allo storico, filtrato sul MAC.

La tabella **Settori (AP)** mostra per ogni AP: stato, CPE agganciate, segnale medio delle CPE online, CPE deboli e offline. Utile per capire se un problema riguarda una singola CPE o tutto il settore.

**Esporta CSV** produce lo stesso elenco per Excel.

Le soglie sono quelle degli strumenti di campo (`FIELD_THRESHOLDS` nel server).

## Statistiche (admin)

Per gli ultimi 3, 6, 12 o 24 mesi:
- **per mese**: provisioning riusciti e falliti (grafico), collaudi superati, con riserva e non superati, segnale e download medi dei collaudi, sostituzioni, CPE accettate in UISP;
- **per installatore**: riuscite, percentuale di fallimenti, quota di installazioni collaudate, collaudi con riserva, segnale medio, ultimo intervento;
- **per modello**: provisioning e percentuale di fallimenti.

I falliti sono **tentativi**: un'installazione riuscita al secondo tentativo conta un fallito e un riuscito.
