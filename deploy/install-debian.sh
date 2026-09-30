#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
APP_DIR=/opt/cdanet-cpe-configurator
CFG_DIR=/etc/cdanet-cpe
SSH_DIR=$CFG_DIR/ssh
SECRETS_DIR=$CFG_DIR/secrets
KEY=$SSH_DIR/github_deploy_ed25519
KNOWN=$SSH_DIR/known_hosts
MASTER_KEY=$SECRETS_DIR/master.key
REPO=${CDANET_REPO:-cdanet-as200034/cdanet-as200034-cpe-configurator}
BRANCH=${CDANET_BRANCH:-release/v0.1.0-admin-tester}
SERVER_IP=${CDANET_SERVER_IP:-172.31.0.29}
cleanup(){ unset ADMIN_PASSWORD ADMIN_PASSWORD2 2>/dev/null || true; }
trap cleanup EXIT
fail(){ echo "ERRORE: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'Eseguire come root.'
. /etc/os-release
[[ ${ID:-} == debian && ${VERSION_ID:-} =~ ^(12|13)$ ]] || fail 'Supportati solo Debian 12/13.'

echo '=== CDA Net CPE Configurator · Bootstrap Docker ==='
echo "Server iniziale: http://$SERVER_IP"
echo 'HTTPS pubblico non viene attivato in questa fase.'

apt-get update
apt-get install -y ca-certificates curl gnupg openssl openssh-client git flock || apt-get install -y ca-certificates curl gnupg openssl openssh-client git util-linux
install -m0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

docker version >/dev/null
docker compose version >/dev/null
install -d -m0750 "$APP_DIR" "$CFG_DIR" "$SSH_DIR" "$SECRETS_DIR" /srv/cdanet-private/firmware
[[ -f $MASTER_KEY ]] || { openssl rand -base64 32 >"$MASTER_KEY"; chmod 0400 "$MASTER_KEY"; }
[[ -f $KEY ]] || ssh-keygen -q -t ed25519 -N '' -C cdanet-cpe-deploy -f "$KEY"
chmod 0600 "$KEY"; chmod 0644 "$KEY.pub"
ssh-keyscan -t ed25519 github.com >"$KNOWN.tmp"
fp=$(ssh-keygen -lf "$KNOWN.tmp" -E sha256 | awk '{print $2}' | head -1)
[[ "$fp" == 'SHA256:+DiY3wvvV6TuJJhbpZisF/zL+D7qKcLkGvQ5c5s1xAM' ]] || fail 'Fingerprint SSH GitHub inatteso.'
mv "$KNOWN.tmp" "$KNOWN"; chmod 0644 "$KNOWN"

echo
echo '=== DEPLOY KEY GITHUB READ-ONLY ==='
cat "$KEY.pub"
echo
echo 'Aggiungi questa chiave come Deploy key READ-ONLY alla repository privata.'
read -rp 'Quando la deploy key è autorizzata, premi INVIO... '
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes"
ssh -T git@github.com 2>&1 | grep -Eq 'successfully authenticated|does not provide shell access' || fail 'Autenticazione GitHub non riuscita.'
git_url="git@github.com:${REPO}.git"
if [[ ! -d $APP_DIR/.git ]]; then
  rm -rf "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$git_url" "$APP_DIR"
else
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
fi

echo
echo '=== CREAZIONE ACCOUNT AMMINISTRATORE ==='
while :; do
  read -rp 'Username Admin: ' ADMIN_USERNAME
  [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{3,64}$ ]] && break
  echo 'Username non valido (3-64 caratteri: lettere, numeri, . _ -).'
done
while :; do
  read -rsp 'Password Admin (minimo 14 caratteri): ' ADMIN_PASSWORD; echo
  read -rsp 'Conferma Password Admin: ' ADMIN_PASSWORD2; echo
  [[ ${#ADMIN_PASSWORD} -ge 14 && "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD2" ]] && break
  echo 'Le password non coincidono oppure sono troppo corte.'
done

ENV_FILE=$APP_DIR/deploy/.env
cp "$APP_DIR/deploy/.env.example" "$ENV_FILE"
chmod 0600 "$ENV_FILE"
JWT_SECRET=$(openssl rand -hex 48)
BRIDGE_TOKEN=$(openssl rand -hex 48)
python3 - "$ENV_FILE" "$SERVER_IP" "$JWT_SECRET" "$BRIDGE_TOKEN" "$ADMIN_USERNAME" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); ip,jwt,bridge,user=sys.argv[2:]
vals={
 'APP_DOMAIN':ip,
 'APP_SCHEME':'http',
 'APP_LISTEN':':80',
 'JWT_SECRET':jwt,
 'ADMIN_USERNAME':user,
 'ALLOWED_ORIGIN':f'http://{ip}',
 'BRIDGE_TOKEN':bridge,
}
lines=[]; seen=set()
for line in p.read_text().splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        k=line.split('=',1)[0]
        if k=='ADMIN_PASSWORD': continue
        if k in vals:
            line=f'{k}={vals[k]}'; seen.add(k)
    lines.append(line)
for k,v in vals.items():
    if k not in seen: lines.append(f'{k}={v}')
p.write_text('\n'.join(lines)+'\n')
PY

cat >$CFG_DIR/deploy.env <<EOF
REPO=$REPO
BRANCH=$BRANCH
KEY=$KEY
KNOWN=$KNOWN
EOF
chmod 0600 $CFG_DIR/deploy.env

cat >/usr/local/sbin/cdanet-cpe-update <<'UPDATER'
#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/cdanet-cpe-configurator
source /etc/cdanet-cpe/deploy.env
exec 9>/run/lock/cdanet-cpe-update.lock
flock -n 9 || exit 0
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes"
cd "$APP_DIR"
old=$(git rev-parse HEAD)
git fetch --depth 1 origin "$BRANCH"
new=$(git rev-parse FETCH_HEAD)
[[ $old == $new ]] && exit 0
git reset --hard "$new"
cd deploy
docker compose --env-file .env build --pull
docker compose --env-file .env up -d --remove-orphans
docker image prune -f
UPDATER
chmod 0750 /usr/local/sbin/cdanet-cpe-update
cat >/etc/systemd/system/cdanet-cpe-update.service <<'EOF'
[Unit]
Description=CDA Net CPE Configurator updater
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cdanet-cpe-update
EOF
cat >/etc/systemd/system/cdanet-cpe-update.timer <<'EOF'
[Unit]
Description=CDA Net CPE Configurator auto-update every 60 seconds
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=1s
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now cdanet-cpe-update.timer

cd "$APP_DIR/deploy"
docker compose --env-file .env build --pull
ADMIN_PASSWORD="$ADMIN_PASSWORD" docker compose --env-file .env up -d --remove-orphans
state=''
for i in $(seq 1 45); do
  state=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cdanet-cpe-configurator-app-1 2>/dev/null || true)
  [[ $state == healthy ]] && break
  sleep 2
done
[[ ${state:-} == healthy ]] || { docker compose --env-file .env ps; docker compose --env-file .env logs --tail=100 app; fail 'Health-check applicazione fallito.'; }
unset ADMIN_PASSWORD ADMIN_PASSWORD2
docker compose --env-file .env up -d --force-recreate app

echo
echo '=== INSTALLAZIONE COMPLETATA ==='
echo "Piattaforma: http://$SERVER_IP"
echo "Admin: $ADMIN_USERNAME"
echo 'Password: quella inserita durante il bootstrap (non salvata nel file .env).'
echo 'MFA/2FA: predisposto lato piattaforma; non obbligatorio in questa fase.'
echo 'Master key dei secret AP: server-only in /etc/cdanet-cpe/secrets/master.key.'
echo 'Quando sarà disponibile il dominio, il deployment potrà essere migrato a HTTPS.'
