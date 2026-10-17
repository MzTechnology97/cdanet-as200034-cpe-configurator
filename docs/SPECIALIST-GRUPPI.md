# Specialist, gruppi di lavoro e direttore tecnico

Proposta per la issue #275. Uno Specialist può essere una persona esterna a CDA Net, quindi di default vede solo il proprio lavoro. Più Specialist possono lavorare insieme in un **gruppo di lavoro**. Un admin può nominare uno Specialist interno **direttore tecnico** dandogli la visibilità piena.

![Specialist e gruppi di lavoro: chi vede cosa](img/specialist-gruppi.png)

## La piramide

La visibilità scende dall'alto verso il basso, mai al contrario.

| Livello | Chi | Cosa vede e cosa fa |
|---|---|---|
| 1 | **Amministratori** | Tutta la piattaforma. Creano gli account e danno la visibilità piena. Gestiscono connettori, impostazioni, backup e Claude. |
| 2 | **Direttore tecnico** (Specialist con visibilità piena) | I dati di CDA Net (clienti, rete, interventi, statistiche, Registro) come un admin. Vede il lavoro di **tutti** gli Specialist e gestisce i gruppi di lavoro. **Non** gestisce account, connettori, impostazioni o backup. |
| 3 | **Gruppi di lavoro** | I membri condividono template delle CPE, storico provisioning e calendario. |
| 4 | **Specialist** | Il proprio lavoro, più quello dei membri dei suoi gruppi. Mai clienti, rete o lavoro di CDA Net. |

## Cosa si condivide in un gruppo

- **Template delle CPE**: i membri li vedono, li usano per installare e li modificano. Li elimina solo chi li ha creati.
- **Storico provisioning**: le installazioni dei membri, in sola lettura. Collaudo e autorizzazione in UISP restano a chi ha installato, con i suoi connettori. Il CSV ha la colonna «Specialist».
- **Calendario**: gli interventi assegnati ai membri.

## Cosa non passa mai

- **I connettori** delle aziende (UISP) e le loro credenziali: restano personali.
- **I dati di CDA Net**: solo gli admin e il direttore tecnico.
- **La visibilità piena del direttore**: non passa ai membri dei suoi gruppi.
- **La copia di un template CDA Net**: la vede solo chi può già usare l'originale. Così il direttore non passa al gruppo un template riservato.
- **Il lavoro da un gruppo all'altro**: i gruppi non si sommano. Se Luca è in due gruppi vede entrambi, ma Giulia, che sta solo nel primo, non vede Sara, che sta solo nel secondo.

## Regole

- Uno Specialist può far parte di più gruppi. Nei gruppi entrano solo gli Specialist.
- Creano e modificano i gruppi gli admin e il direttore tecnico. Uno Specialist non può aggiungersi da solo.
- La visibilità piena la dà solo un admin, da Account. È spenta per tutti, compresi gli Specialist che esistono già. Quando viene data o tolta, le sessioni dello Specialist si chiudono e arriva un avviso di sicurezza al NOC.
- Ogni template e ogni installazione restano del loro autore. Chi esce da un gruppo smette **subito** di vedere il lavoro degli altri, e gli altri il suo.
- Nel Registro finiscono `work_group.create`, `work_group.update` (chi è entrato e chi è uscito) e `work_group.delete`, oltre a `user.update` per la visibilità piena.

## Strumenti tecnici e dati di altri

Gli strumenti che non mostrano dati di altri restano aperti a tutti gli Specialist: modulo dei template, segnaposto, mappe, terreno, firmware, antenne, guida.

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
- precisione della copertura.

Nei controlli puntuali dei dati, `isStaff(role)` diventa `seesAll(user)`.

## Da decidere in revisione

- **Connettori condivisibili nel gruppo?** Oggi no.
- **Template condivisi modificabili da tutti i membri o solo dall'autore?** Oggi da tutti. Si cambia con `GROUP_EDITS_TEMPLATES` in `server/src/services/specialist.ts`.
- **App Android**:
  - il calendario dello Specialist ora riceve solo i propri interventi e quelli del gruppo, senza `installers`;
  - lo storico Specialist ha i campi `author`/`authorId`.

## In console

**Amministrazione → Gruppi di lavoro** mostra lo schema «Chi vede cosa», i gruppi e i loro membri. In **Account** c'è la casella «Visibilità piena · direttore tecnico».

![La pagina Gruppi di lavoro](img/gruppi-di-lavoro-console.png)
