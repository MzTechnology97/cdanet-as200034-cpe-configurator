# CDA Net CPE Configurator — Debian 12/13

## Requisiti
- Debian 12 (Bookworm) o Debian 13 (Trixie), amd64/arm64 supportati da Docker.
- DNS del dominio PWA puntato all'IP del server; TCP 80/443 raggiungibili per Caddy/ACME.
- GitHub fine-grained PAT dedicato con accesso **read-only Contents** esclusivamente al repository privato.
- Firmware airOS 8.7.4 conservato fuori dal repository.

## Installazione
Scaricare `deploy/install-debian.sh` dal repository autenticandosi a GitHub e lanciarlo come root. Non inserire il PAT nella command line o nella shell history. L'installer chiede il token in modo non visibile, installa Docker Engine dal repository ufficiale Docker, clona il branch privato, genera un JWT secret iniziale e abilita il timer di aggiornamento.

Dopo l'installazione modificare `/opt/cdanet-cpe-configurator/deploy/.env`, impostando almeno dominio, password admin forte, URL/token bridge e percorso firmware. Copiare il firmware nel percorso privato indicato e avviare `docker compose --env-file .env up -d --build` dalla cartella `deploy`.

## Auto-update
`cdanet-cpe-update.timer` controlla il branch ogni circa 15 minuti. Se HEAD è cambiato, esegue fetch autenticato, reset al commit remoto, rebuild delle immagini e rolling restart Compose. Il token GitHub è conservato root-only in `/etc/cdanet-cpe/github.env` e non resta nell'URL `origin` del repository.

Comandi utili:
- `systemctl status cdanet-cpe-update.timer`
- `systemctl start cdanet-cpe-update.service`
- `journalctl -u cdanet-cpe-update.service`
- `docker compose --env-file /opt/cdanet-cpe-configurator/deploy/.env -f /opt/cdanet-cpe-configurator/deploy/docker-compose.yml ps`

## Sicurezza
Usare un PAT dedicato e read-only, ruotarlo periodicamente e revocarlo se il server viene dismesso o compromesso. `/etc/cdanet-cpe/github.env` e `deploy/.env` devono rimanere `0600`. Non committare questi file né il firmware. Per produzione è consigliato aggiornare da un branch/release stabile anziché da un branch di sviluppo.
