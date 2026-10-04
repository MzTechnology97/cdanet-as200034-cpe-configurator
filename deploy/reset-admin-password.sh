#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=${APP_DIR:-/opt/cdanet-cpe-configurator}
cd "$APP_DIR/deploy"
[[ $EUID -eq 0 ]] || { echo "Eseguire come root." >&2; exit 1; }
read -rp "Username Admin: " USERNAME
while :; do
  read -rsp "Nuova password Admin (min 14): " PASSWORD; echo
  read -rsp "Conferma password: " PASSWORD2; echo
  [[ ${#PASSWORD} -ge 14 && "$PASSWORD" == "$PASSWORD2" ]] && break
  echo "Password non valide."
done
printf '%s\n%s\n' "$USERNAME" "$PASSWORD" | docker compose --env-file .env exec -T app node src/reset-admin-password.js
unset PASSWORD PASSWORD2
echo "Password Admin aggiornata. Verificare il login dalla PWA/APK."
