#!/usr/bin/env bash
# Resets (or creates) an admin account in the running stack without touching other data.
set -Eeuo pipefail
DEPLOY_DIR="${DEPLOY_DIR:-/opt/cdanet-cpe}"
[[ $EUID -eq 0 ]] || { echo "Eseguire come root." >&2; exit 1; }
cd "$DEPLOY_DIR"
read -rp "Username admin: " u
read -rsp "Nuova password (min 14): " p; echo
read -rsp "Conferma: " p2; echo
[[ $p == "$p2" && ${#p} -ge 14 ]] || { echo "Password non valide" >&2; exit 1; }
printf '%s\n%s\n' "$u" "$p" | docker compose --env-file .env exec -T -u node app node src/cli/reset-admin.ts
unset p p2
