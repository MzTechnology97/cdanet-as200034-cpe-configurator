#!/usr/bin/env bash
set -euo pipefail
command -v node >/dev/null || { echo "Node.js 20+ non trovato."; exit 1; }
if [[ -z "${CDA_WEB_BRIDGE_ORIGIN:-}" ]]; then
  read -rp "URL PWA autorizzata (es. http://172.31.0.29 oppure https://cpe.cda-net.it): " CDA_WEB_BRIDGE_ORIGIN
  export CDA_WEB_BRIDGE_ORIGIN
fi
npm install --omit=dev
exec node server.mjs
