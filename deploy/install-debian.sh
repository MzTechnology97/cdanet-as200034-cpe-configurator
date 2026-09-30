#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
APP_DIR=/opt/cdanet-cpe-configurator; CFG_DIR=/etc/cdanet-cpe; SECRETS_DIR=$CFG_DIR/secrets
LOG_DIR=/var/log/cdanet-cpe; MASTER_KEY=$SECRETS_DIR/master.key
SERVER_IP=${CDANET_SERVER_IP:-172.31.0.29}
cleanup(){ unset ADMIN_PASSWORD ADMIN_PASSWORD2 2>/dev/null||true; };trap cleanup EXIT
fail(){ echo "ERRORE: $*" >&2;exit 1; }
[[ $EUID -eq 0 ]]||fail 'Eseguire come root.';. /etc/os-release;[[ ${ID:-} == debian && ${VERSION_ID:-} =~ ^(12|13)$ ]]||fail 'Supportati solo Debian 12/13.'
echo '=== CDA Net CPE Configurator · Bootstrap Docker ===';echo "Server iniziale: http://$SERVER_IP";echo 'HTTPS pubblico non viene attivato in questa fase.'
apt-get update;apt-get install -y ca-certificates curl gnupg openssl util-linux python3
install -m0755 -d /etc/apt/keyrings;curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc;chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update;apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin;systemctl enable --now docker
docker version >/dev/null;docker compose version >/dev/null
install -d -m0750 "$APP_DIR" "$CFG_DIR" "$SECRETS_DIR" "$LOG_DIR" "$LOG_DIR/errors" /srv/cdanet-private/firmware
[[ -f $MASTER_KEY ]]||{ openssl rand -base64 32 >"$MASTER_KEY";chmod 0400 "$MASTER_KEY"; }
# No GitHub SSH keys are generated or configured by this installer.
# Source deployment is expected to be present in APP_DIR before bootstrap/update.
[[ -f "$APP_DIR/deploy/docker-compose.yml" || -f "$APP_DIR/deploy/compose.yml" || -f "$APP_DIR/deploy/compose.yaml" ]] || fail "Codice applicativo non presente in $APP_DIR. Sincronizzare/copiare la release prima del bootstrap."
echo;echo '=== CREAZIONE ACCOUNT AMMINISTRATORE ===';while :;do read -rp 'Username Admin: ' ADMIN_USERNAME;[[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{3,64}$ ]]&&break;echo 'Username non valido.';done
while :;do read -rsp 'Password Admin (minimo 14 caratteri): ' ADMIN_PASSWORD;echo;read -rsp 'Conferma Password Admin: ' ADMIN_PASSWORD2;echo;[[ ${#ADMIN_PASSWORD} -ge 14 && "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD2" ]]&&break;echo 'Password non valide.';done
ENV_FILE=$APP_DIR/deploy/.env;cp "$APP_DIR/deploy/.env.example" "$ENV_FILE";chmod 0600 "$ENV_FILE";JWT_SECRET=$(openssl rand -hex 48);BRIDGE_TOKEN=$(openssl rand -hex 48)
python3 - "$ENV_FILE" "$SERVER_IP" "$JWT_SECRET" "$BRIDGE_TOKEN" "$ADMIN_USERNAME" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);ip,jwt,bridge,user=sys.argv[2:];vals={'APP_DOMAIN':ip,'APP_SCHEME':'http','APP_LISTEN':':80','JWT_SECRET':jwt,'ADMIN_USERNAME':user,'ALLOWED_ORIGIN':f'http://{ip}','BRIDGE_TOKEN':bridge}
lines=[];seen=set()
for line in p.read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  k=line.split('=',1)[0]
  if k=='ADMIN_PASSWORD':continue
  if k in vals:line=f'{k}={vals[k]}';seen.add(k)
 lines.append(line)
for k,v in vals.items():
 if k not in seen:lines.append(f'{k}={v}')
p.write_text('\n'.join(lines)+'\n')
PY
# Remove obsolete SSH updater state from installations created by older bootstrap versions.
rm -rf "$CFG_DIR/ssh"
rm -f "$CFG_DIR/deploy.env" /usr/local/sbin/cdanet-cpe-update /etc/systemd/system/cdanet-cpe-update.service /etc/systemd/system/cdanet-cpe-update.timer
systemctl disable --now cdanet-cpe-update.timer 2>/dev/null || true
systemctl daemon-reload
cd "$APP_DIR/deploy";docker compose --env-file .env build --pull;ADMIN_PASSWORD="$ADMIN_PASSWORD" docker compose --env-file .env up -d --remove-orphans
state='';for i in $(seq 1 45);do state=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cdanet-cpe-configurator-app-1 2>/dev/null||true);[[ $state == healthy ]]&&break;sleep 2;done
[[ ${state:-} == healthy ]]||{ docker compose --env-file .env logs --tail=100 app;fail 'Health-check iniziale fallito.'; };unset ADMIN_PASSWORD ADMIN_PASSWORD2;docker compose --env-file .env up -d --force-recreate app
echo;echo '=== INSTALLAZIONE COMPLETATA ===';echo "Piattaforma: http://$SERVER_IP";echo "Admin: $ADMIN_USERNAME";echo 'GitHub SSH/deploy key: non configurata.';echo 'Auto-update GitHub SSH: disattivato. Il nuovo meccanismo di distribuzione verrà configurato separatamente.';echo "Log applicativi: $LOG_DIR/"
