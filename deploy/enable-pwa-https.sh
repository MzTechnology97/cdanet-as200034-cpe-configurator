#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=${APP_DIR:-/opt/cdanet-cpe-configurator}
DEPLOY_DIR="$APP_DIR/deploy"
DOMAIN=${1:-}
[[ $EUID -eq 0 ]] || { echo "Eseguire come root." >&2; exit 1; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "Uso: $0 pwa.example.it" >&2; exit 2; }
[[ -f "$DEPLOY_DIR/.env" ]] || { echo ".env non trovato. Eseguire prima il bootstrap." >&2; exit 1; }

echo "=== CDA Net · abilita PWA HTTPS ==="
echo "Hostname: $DOMAIN"
echo "Prerequisiti: DNS del dominio verso questo server e porte TCP 80/443 raggiungibili da Caddy."

cp -a "$DEPLOY_DIR/.env" "$DEPLOY_DIR/.env.before-https-$(date +%Y%m%d-%H%M%S)"
python3 - "$DEPLOY_DIR/.env" "$DOMAIN" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); domain=sys.argv[2]
vals={
  "APP_DOMAIN":domain,
  "APP_SCHEME":"https",
  "APP_LISTEN":domain,
  "ALLOWED_ORIGIN":f"https://{domain}",
}
out=[];seen=set()
for line in p.read_text().splitlines():
  if "=" in line and not line.lstrip().startswith("#"):
    k=line.split("=",1)[0]
    if k in vals:
      line=f"{k}={vals[k]}";seen.add(k)
  out.append(line)
for k,v in vals.items():
  if k not in seen: out.append(f"{k}={v}")
p.write_text("\n".join(out)+"\n")
PY

cd "$DEPLOY_DIR"
docker compose --env-file .env config >/dev/null
docker compose --env-file .env up -d --force-recreate app caddy

echo "Attendo certificato TLS e health-check..."
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/tmp/cdanet-pwa-https-health.json 2>/dev/null; then
    cat /tmp/cdanet-pwa-https-health.json; echo
    echo "PWA HTTPS pronta: https://$DOMAIN"
    exit 0
  fi
  sleep 3
done

echo "HTTPS non ancora disponibile. Stato:"
docker compose --env-file .env ps || true
echo "--- Caddy ---"
docker compose --env-file .env logs --tail=120 caddy || true
echo "Verificare DNS, firewall/NAT TCP 80/443 e raggiungibilità pubblica/ACME del dominio."
exit 1
