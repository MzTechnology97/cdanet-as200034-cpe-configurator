# App su Google Play (distribuzione privata)

L'app esce in due varianti, stesso pacchetto (`it.cdanet.cpeconfigurator`) e stessa chiave di firma:

| Variante | Comando | Chi la installa e la aggiorna |
|---|---|---|
| `server` | `assembleServerRelease` → APK | il server (`/api/mobile/apk`): l'app scarica e installa da sé, come finora |
| `play` | `bundlePlayRelease` → AAB | Google Play: niente permesso «Installa app sconosciute», gli aggiornamenti arrivano dal Play Store |

Con la stessa chiave le due varianti si sostituiscono a vicenda: chi ha l'APK del server può passare al Play Store senza disinstallare.

La distribuzione è **privata**: il canale **Test interno** di Google Play (fino a 100 tester, elencati per account Google). Non c'è revisione pubblica e l'app non compare nelle ricerche. Solo chi è in elenco e ha aperto il link di adesione la vede e la installa.

## Sviluppo e aggiornamenti

1. Si sviluppa come sempre: PR → CI → merge su `main`, con `VERSION` aumentata (il `versionCode` cresce da sé).
2. La CI (`.github/workflows/android.yml`) costruisce le due varianti firmate:
   - l'APK va nella GitHub Release, da cui il server lo prende;
   - l'AAB va su Google Play, canale Test interno (`tools/play-upload.mjs`), appena è configurato il secret `PLAY_SERVICE_ACCOUNT_JSON`.
3. Google Play aggiorna l'app sui telefoni dei tester: da sé con gli aggiornamenti automatici attivi, altrimenti con «Aggiorna» nel Play Store.

Google Play accetta solo AAB, non APK, e non si carica nulla a mano dopo la prima versione.

Nell'app installata da Play:
- il controllo aggiornamenti del server resta;
- un aggiornamento normale mostra «Aggiorna dal Play Store» invece di scaricare l'APK;
- un aggiornamento obbligatorio blocca l'app finché non viene aggiornata dal Play Store.

## Cosa serve una volta sola

### Account sviluppatore (titolare dell'azienda)

1. Un account Google aziendale dedicato, con la verifica in due passaggi.
2. Il numero **D-U-N-S** dell'azienda. È gratuito, da Dun & Bradstreet, e arriva in alcuni giorni. È obbligatorio per l'account di tipo organizzazione.
3. L'iscrizione su https://play.google.com/console/signup:
   - tipo **Organizzazione**;
   - 25 USD una tantum;
   - dati e sito dell'azienda;
   - email e telefono di contatto verificati;
   - verifica dell'identità con un documento;
   - verifica di un telefono Android con l'app Google Play Console.
4. In **Utenti e autorizzazioni**, invita l'account Google di chi gestisce i rilasci, con il ruolo di amministratore dell'app.

### L'app nella Play Console

1. **Crea app**:
   - nome «CDA Net CPE»;
   - lingua italiano;
   - App, Gratuita;
   - le due dichiarazioni (norme e leggi USA sull'esportazione).
2. **Firma dell'app**: si usa la **chiave esistente**. Con l'opzione «Esporta e carica una chiave da un archivio Java» e lo strumento PEPK, la cifra chi ha il keystore. Il keystore non va mai inviato a nessuno. Così le installazioni attuali si aggiornano senza disinstallare.
3. **Contenuti dell'app** (Norme → Contenuti dell'app):
   - **Norme sulla privacy**: `https://app.cda-net.it/privacy`. È l'informativa compilata in console (Informativa privacy), pubblicata senza accesso.
   - **Accesso all'app**: l'app richiede l'accesso, quindi va creato in console un utente di prova (installatore, nessun dato reale). Le sue credenziali si scrivono solo nella Play Console, mai in chat.
   - **Annunci**: no.
   - **Classificazione dei contenuti**: questionario, categoria Utilità/Produttività, nessun contenuto sensibile.
   - **Pubblico di destinazione**: 18 anni e oltre.
   - **Sicurezza dei dati**:
     - posizione precisa (funzionalità dell'app: puntamento e collaudo);
     - foto (collaudo);
     - nome utente ed email dell'account;
     - identificativo del dispositivo (sicurezza: blocco accessi);
     - log attività (sicurezza);
     - tutto cifrato in transito (HTTPS);
     - nulla condiviso con terzi né venduto;
     - cancellazione su richiesta all'amministratore.
   - **Servizi in primo piano**: `remoteMessaging`, cioè le notifiche del NOC senza Firebase. Serve una breve descrizione e un video dimostrativo (un link anche non in elenco).
   - **App per il governo, finanza, salute, notizie**: no.
4. **Scheda dello store** (richiesta anche per il test interno):
   - descrizione breve e completa;
   - icona 512×512;
   - grafica 1024×500;
   - almeno 2 screenshot del telefono, con dati di fantasia.
5. **Test → Test interno**:
   - crea l'elenco dei tester (gli account Google dei tecnici e dell'ufficio);
   - carica il primo AAB (dagli artifact della CI, `CDA-Net-CPE-x.y.z-play.aab`);
   - avvia il rilascio;
   - copia il **link di adesione** e mandalo ai tester. Lo aprono dal telefono, accettano e installano dal Play Store.

### Caricamento automatico dalla CI

Dopo il primo rilascio fatto a mano:

1. In Google Cloud Console, nello stesso account, fai queste tre cose:
   - crea un progetto;
   - abilita la **Google Play Android Developer API**;
   - crea un **service account** con una chiave JSON.
2. Nella Play Console, in **Utenti e autorizzazioni**, invita l'email del service account con il permesso «Rilascia nei canali di test», limitato a questa app.
3. Su GitHub, in Settings → Secrets → Actions, crea il secret `PLAY_SERVICE_ACCOUNT_JSON` con il contenuto del file JSON. Il file non va mai in chat, né nel repo, né per email.

Opzionali, come variabili del repo:
- `PLAY_TRACK`: `internal` per impostazione predefinita;
- `PLAY_RELEASE_STATUS`: `completed`, oppure `draft` finché l'app non ha avuto il primo rilascio dalla console.
