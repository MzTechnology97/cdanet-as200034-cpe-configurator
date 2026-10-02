#!/usr/bin/env bash
set -u
APP_DIR=${APP_DIR:-/opt/cdanet-cpe-configurator}
DEPLOY_DIR="$APP_DIR/deploy"
echo "=== CDA Net PWA diagnostics ==="
date
echo
echo "[1] Host/network"
hostname -f 2>/dev/null || hostname
ip -br addr 2>/dev/null || true
echo
echo "[2] Listening ports"
ss -lntp 2>/dev/null | grep -E ':(80|443|8787)\b' || echo "Nessun listener su 80/443/8787"
echo
echo "[3] Docker"
docker version --format '{{.Server.Version}}' 2>/dev/null || echo "Docker non disponibile"
docker compose version 2>/dev/null || true
echo
if [[ -d "$DEPLOY_DIR" ]]; then
  cd "$DEPLOY_DIR"
  echo "[4] Compose status"
  docker compose --env-file .env ps 2>/dev/null || true
  echo
  echo "[5] App health from host"
  curl -fsS --max-time 3 http://127.0.0.1/api/health 2>/dev/null || echo "Health endpoint non raggiungibile via porta 80"
  echo
  echo
  echo "[6] App container health"
  docker compose --env-file .env exec -T app wget -qO- http://127.0.0.1:8787/api/health 2>/dev/null || echo "Backend non risponde dentro il container"
  echo
  echo
  echo "[7] Recent Caddy logs"
  docker compose --env-file .env logs --tail=40 caddy 2>/dev/null || true
  echo
  echo "[8] Recent app logs"
  docker compose --env-file .env logs --tail=40 app 2>/dev/null || true
else
  echo "Directory $DEPLOY_DIR non presente."
fi
echo
echo "=== Fine diagnostica ==="
