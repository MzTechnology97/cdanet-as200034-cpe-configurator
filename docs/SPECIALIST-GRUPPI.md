# Specialist, gruppi di lavoro e direttore tecnico

Issue #275 (v1.36.3). Uno Specialist può essere una persona esterna a CDA Net, quindi di default vede solo il proprio lavoro. Più Specialist possono lavorare insieme in un **gruppo di lavoro**. Un admin può nominare uno Specialist interno **direttore tecnico** dandogli la visibilità piena.

![Specialist e gruppi di lavoro: chi vede cosa](img/specialist-gruppi.png)

## La piramide

La visibilità scende dall'alto verso il basso, mai al contrario.

| Livello | Chi | Cosa vede e cosa fa |
|---|---|---|
| 1 | **Amministratori** | Tutta la piattaforma. Creano gli account e danno la visibilità piena. Gestiscono connettori, impostazioni, backup e Claude. |
| 2 | **Direttore tecnico** (Specialist con visibilità piena) | I dati di CDA Net (clienti, rete, interventi, statistiche, Registro) come un admin, e le installazioni CDA Net come un installatore. Vede il lavoro di **tutti** gli Specialist e gestisce i gruppi di lavoro. **Non** gestisce account, connettori, impostazioni o backup. |
| 3 | **Gruppi di lavoro** | I membri condividono template delle CPE, storico provisioning e calendario. |
| 4 | **Specialist** | Il proprio lavoro, più quello dei membri dei suoi gruppi. Mai clienti, rete o lavoro di CDA Net, né le sue chiavi. |

## Cosa si condivide in un gruppo

- **Template delle CPE**: i membri li vedono, li usano per installare e li modificano. Li elimina solo chi li ha creati. I **segreti del template** (la community SNMP) restano del suo autore: solo lui li imposta o li toglie (`template_secrets_author_only` per gli altri) e solo le sue installazioni li usano. Gli altri membri, e anche il direttore, li scrivono nel flusso per ogni CPE: il server li chiede (`asked`) come per le chiavi Wi-Fi.
- **Storico provisioning**: le installazioni dei membri, in sola lettura. Collaudo e autorizzazione in UISP restano a chi ha installato, con i suoi connettori. Il CSV ha la colonna «Specialist».
- **Calendario**: gli interventi assegnati ai membri.

## Cosa non passa mai

- **I connettori** delle aziende (UISP) e le loro credenziali: restano personali.
- **I segreti dei template** degli altri membri (vedi sopra).
- **I dati di CDA Net**: solo gli admin e il direttore tecnico.
- **Le chiavi di CDA Net**: chiavi Wi-Fi delle reti e password delle CPE. Senza visibilità piena lo Specialist non fa lavoro di campo per CDA Net (`requireCdaWork`, `doesCdaWork`): niente installazioni CDA Net (`/api/provisioning/plan`, `/jobs`, `/result`, `/templates`, `/api/wireless-networks`, sostituzione), niente strumenti di campo sulle CPE di CDA Net (`/api/field/access`, `/relink`, `/cpe`, `/cpe/claim`, `/cpe/register`), nessun template CDA Net, nemmeno quelli per tutti. Lavora per le sue aziende nella sezione Specialist, con le credenziali scritte nel flusso.
- **La visibilità piena del direttore**: non passa ai membri dei suoi gruppi.
- **La copia di un template CDA Net**: la vede solo chi può già usare l'originale. Così il direttore non passa al gruppo un template riservato.
- **Il lavoro da un gruppo all'altro**: i gruppi non si sommano. Se Luca è in due gruppi vede entrambi, ma Giulia, che sta solo nel primo, non vede Sara, che sta solo nel secondo.

## Regole

- Uno Specialist può far parte di più gruppi. Nei gruppi entrano solo gli Specialist.
- Creano e modificano i gruppi gli admin e il direttore tecnico. Uno Specialist non può aggiungersi da solo.
- Chi smette di essere Specialist esce dai suoi gruppi (avviso al NOC); se torna Specialist, un admin decide di nuovo.
- La visibilità piena la dà solo un admin, da Account. È spenta per tutti, compresi gli Specialist che esistono già. Quando viene data o tolta, le sessioni dello Specialist si chiudono e arriva un avviso di sicurezza al NOC.
- Ogni template e ogni installazione restano del loro autore. Chi esce da un gruppo smette **subito** di vedere il lavoro degli altri, e gli altri il suo.
- Nel Registro finiscono `work_group.create`, `work_group.update` (chi è entrato e chi è uscito) e `work_group.delete`, oltre a `user.update` per la visibilità piena. Gli stessi cambi (gruppo creato con i suoi membri, entrate, uscite, gruppo eliminato) arrivano come avviso di sicurezza al NOC.
- Nel Registro la creazione e la modifica di un template e ogni installazione riportano il gruppo («gruppo Squadra Sud») e, se il template è di un altro membro, il suo autore («template di spec.b»). Mai un segreto.

## Strumenti tecnici e dati di altri

Gli strumenti che non mostrano dati di altri restano aperti a tutti gli Specialist: modulo dei template, segnaposto, mappe, terreno, firmware, diagrammi delle antenne, guida.

Tutto quello che mostra dati di CDA Net o di altri richiede la visibilità piena (`requireSeesAll` sul server):
- stato e Registro;
- template CDA Net;
- statistiche;
- interventi dell'ufficio;
- UISP;
- CRM;
- guasti Enel;
- Victron;
- magazzino;
- IA-AP;
- fattibilità;
- salute piattaforma;
- precisione della copertura;
- antenne degli AP di CDA Net (nomi, clienti, azimut) e importazione dei diagrammi;
- copertura degli altri operatori con i loro nomi (MyWic, sull'abbonamento di CDA Net): gli altri Specialist hanno la risposta degli installatori, senza i nomi.

Nei controlli puntuali dei dati, `isStaff(role)` diventa `seesAll(user)`.

## Decisioni (Carmelo, 17/10/2026)

- **Connettori**: non si condividono nel gruppo.
- **Template condivisi**: li modificano tutti i membri (`GROUP_EDITS_TEMPLATES` in `server/src/services/specialist.ts`), ma i segreti solo l'autore.
- **Segreti di un template usato da un altro membro**: li scrive chi installa, mai quelli dell'autore.

## App Android

- La sessione ha `fullView`: `seesAll` per le viste del NOC (agenda di squadra in Oggi, Salute CPE, guasti, rete, copertura), `doesCdaWork` per il lavoro di campo di CDA Net.
- Senza visibilità piena le schermate di installazione e degli strumenti sulle CPE di CDA Net (Installazioni, Installazione CPE, CPE collegata, Puntamento, Diagnosi, Collaudo) mostrano che servono le chiavi di CDA Net e portano alla sezione Specialist; Oggi, scorciatoie e Strumenti non le propongono, e il telefono non tiene le credenziali delle CPE di CDA Net.
- Il calendario riceve dal server solo i propri interventi e quelli del gruppo, senza `installers`, e mostra di chi è ogni intervento del gruppo.
- Template e storico Specialist mostrano l'autore del lavoro di un collega; le installazioni dei colleghi sono in sola lettura; la community di un template altrui non si modifica; la copia di un template CDA Net c'è solo con la visibilità piena.

## In console

**Amministrazione → Gruppi di lavoro** mostra lo schema «Chi vede cosa», i gruppi e i loro membri. In **Account** c'è la casella «Visibilità piena · direttore tecnico». Nelle sue pagine (template e storico) lo Specialist vede i suoi gruppi e i colleghi; la copia di un template CDA Net c'è solo con la visibilità piena e la community di un template altrui non si modifica.

![La pagina Gruppi di lavoro](img/gruppi-di-lavoro-console.png)
