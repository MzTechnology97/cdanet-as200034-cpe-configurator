#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/cdanet-cpe-configurator}
DEPLOY_DIR="$APP_DIR/deploy"
SERVER_IP=${CDANET_SERVER_IP:-172.31.0.29}
BACKUP_DIR="$APP_DIR/.deploy-backups"
STAMP=$(date +%Y%m%d-%H%M%S)

[[ $EUID -eq 0 ]] || { echo "ERRORE: eseguire come root." >&2; exit 1; }
[[ -d "$APP_DIR/.git" ]] || { echo "ERRORE: repository non trovato in $APP_DIR" >&2; exit 1; }
[[ -f "$DEPLOY_DIR/docker-compose.yml" ]] || { echo "ERRORE: docker-compose.yml non trovato." >&2; exit 1; }

echo "=== CDA Net PWA redeploy ==="
echo "Server: $SERVER_IP"
echo "Repository: $APP_DIR"

mkdir -p "$BACKUP_DIR"

cd "$APP_DIR"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "ERRORE: ci sono modifiche locali tracciate. Redeploy interrotto per non sovrascriverle." >&2
  git status --short
  exit 1
fi

if [[ -f "$DEPLOY_DIR/.env" ]]; then
  cp -a "$DEPLOY_DIR/.env" "$BACKUP_DIR/.env-$STAMP"
  chmod 0600 "$BACKUP_DIR/.env-$STAMP"
  echo "Backup .env: $BACKUP_DIR/.env-$STAMP"
fi

echo "[1/6] Aggiorno repository..."
git fetch --prune origin
git pull --ff-only

cd "$DEPLOY_DIR"
[[ -f .env ]] || cp .env.example .env
chmod 0600 .env

echo "[2/6] Imposto listener locale PWA..."
python3 - ".env" "$SERVER_IP" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); ip=sys.argv[2]
vals={
    "APP_DOMAIN": ip,
    "APP_SCHEME": "http",
    "APP_LISTEN": ":80",
    "ALLOWED_ORIGIN": f"http://{ip}",
    "ANDROID_RELEASE_HOST_PATH": "/srv/cdanet-private/releases",
    "ANDROID_RELEASE_DIR": "/opt/cdanet/releases",
}
lines=p.read_text().splitlines() if p.exists() else []
out=[]; seen=set()
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        k=line.split("=",1)[0]
        if k in vals:
            line=f"{k}={vals[k]}"
            seen.add(k)
    out.append(line)
for k,v in vals.items():
    if k not in seen:
        out.append(f"{k}={v}")
p.write_text("\n".join(out)+"\n")
PY

echo "[3/6] Verifico configurazione Docker..."
docker compose --env-file .env config >/dev/null

echo "[4/6] Rebuild applicazione..."
docker compose --env-file .env build --pull

echo "[5/6] Riavvio servizi..."
docker compose --env-file .env up -d --remove-orphans --force-recreate

echo "[6/6] Health-check..."
ok=0
for i in $(seq 1 60); do
  if curl -fsS --max-time 3 http://127.0.0.1/api/health >/tmp/cdanet-pwa-health.json 2>/dev/null; then
    ok=1
    break
  fi
  sleep 2
done

if [[ $ok -ne 1 ]]; then
  echo "ERRORE: health-check fallito."
  docker compose --env-file .env ps || true
  echo "--- LOG APP/CADDY ---"
  docker compose --env-file .env logs --tail=150 app caddy || true
  exit 1
fi

cat /tmp/cdanet-pwa-health.json
echo
echo "=== REDEPLOY COMPLETATO ==="
echo "PWA: http://$SERVER_IP"
echo "Health: http://$SERVER_IP/api/health"
docker compose --env-file .env ps
