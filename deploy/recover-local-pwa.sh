#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=${APP_DIR:-/opt/cdanet-cpe-configurator}
DEPLOY_DIR="$APP_DIR/deploy"
SERVER_IP=${CDANET_SERVER_IP:-172.31.0.29}
[[ $EUID -eq 0 ]] || { echo "Eseguire come root." >&2; exit 1; }
[[ -f "$DEPLOY_DIR/docker-compose.yml" ]] || { echo "Repository non presente in $APP_DIR" >&2; exit 1; }
cd "$DEPLOY_DIR"
[[ -f .env ]] || cp .env.example .env
chmod 0600 .env
python3 - ".env" "$SERVER_IP" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); ip=sys.argv[2]
vals={"APP_DOMAIN":ip,"APP_SCHEME":"http","APP_LISTEN":":80","ALLOWED_ORIGIN":f"http://{ip}"}
lines=[];seen=set()
for line in p.read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k=line.split("=",1)[0]
        if k in vals:
            line=f"{k}={vals[k]}";seen.add(k)
    lines.append(line)
for k,v in vals.items():
    if k not in seen: lines.append(f"{k}={v}")
p.write_text("\n".join(lines)+"\n")
PY
echo "Configurazione locale: http://$SERVER_IP"
docker compose --env-file .env build --pull
docker compose --env-file .env up -d --remove-orphans
echo "Attendo health check..."
for i in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1/api/health >/tmp/cdanet-health.json 2>/dev/null; then
    cat /tmp/cdanet-health.json; echo
    echo "PWA disponibile su http://$SERVER_IP"
    exit 0
  fi
  sleep 2
done
echo "Avvio non riuscito. Stato e log:"
docker compose --env-file .env ps || true
docker compose --env-file .env logs --tail=120 app caddy || true
exit 1
