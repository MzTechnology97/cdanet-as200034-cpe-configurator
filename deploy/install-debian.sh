#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/cdanet-cpe-configurator; CFG_DIR=/etc/cdanet-cpe; SSH_DIR=$CFG_DIR/ssh; SECRETS_DIR=$CFG_DIR/secrets
KEY=$SSH_DIR/github_deploy_ed25519; KNOWN=$SSH_DIR/known_hosts; MASTER_KEY=$SECRETS_DIR/master.key
REPO=${CDANET_REPO:-cdanet-as200034/cdanet-as200034-cpe-configurator}; BRANCH=${CDANET_BRANCH:-release/v0.1.0-admin-tester}
cleanup(){ unset ADMIN_PASSWORD ADMIN_PASSWORD2 2>/dev/null||true; };trap cleanup EXIT
[[ $EUID -eq 0 ]]||{ echo 'Eseguire come root.'>&2;exit 1; };. /etc/os-release;[[ ${ID:-} == debian && ${VERSION_ID:-} =~ ^(12|13)$ ]]||exit 1
apt-get update;apt-get install -y ca-certificates curl gnupg openssl openssh-client git
install -m0755 -d /etc/apt/keyrings;curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc;chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update;apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin;systemctl enable --now docker
install -d -m0750 "$APP_DIR" "$CFG_DIR" "$SSH_DIR" "$SECRETS_DIR" /srv/cdanet-private/firmware
[[ -f $MASTER_KEY ]]||{ openssl rand -base64 32 >"$MASTER_KEY";chmod 0400 "$MASTER_KEY"; };[[ -f $KEY ]]||ssh-keygen -q -t ed25519 -N '' -C cdanet-cpe-deploy -f "$KEY";chmod 0600 "$KEY";chmod 0644 "$KEY.pub"
ssh-keyscan -t ed25519 github.com >"$KNOWN.tmp";fp=$(ssh-keygen -lf "$KNOWN.tmp" -E sha256|awk '{print $2}'|head -1);[[ "$fp" == 'SHA256:+DiY3wvvV6TuJJhbpZisF/zL+D7qKcLkGvQ5c5s1xAM' ]]||exit 1;mv "$KNOWN.tmp" "$KNOWN"
echo '=== DEPLOY KEY GITHUB READ-ONLY ===';cat "$KEY.pub";read -rp 'Autorizzala nella repo privata e premi INVIO... '
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes";ssh -T git@github.com 2>&1|grep -Eq 'successfully authenticated|does not provide shell access'||exit 1
git_url="git@github.com:${REPO}.git";if [[ ! -d $APP_DIR/.git ]];then rm -rf "$APP_DIR";git clone --depth 1 --branch "$BRANCH" "$git_url" "$APP_DIR";else git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH";git -C "$APP_DIR" reset --hard FETCH_HEAD;fi
read -rp 'Dominio/FQDN HTTPS: ' APP_DOMAIN;read -rp 'Username Admin: ' ADMIN_USERNAME;while :;do read -rsp 'Password Admin (min 14): ' ADMIN_PASSWORD;echo;read -rsp 'Conferma: ' ADMIN_PASSWORD2;echo;[[ ${#ADMIN_PASSWORD} -ge 14 && "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD2" ]]&&break;done
ENV_FILE=$APP_DIR/deploy/.env;cp "$APP_DIR/deploy/.env.example" "$ENV_FILE";chmod 0600 "$ENV_FILE";JWT_SECRET=$(openssl rand -hex 48);sed -i -e "s|^APP_DOMAIN=.*|APP_DOMAIN=$APP_DOMAIN|" -e "s|^ALLOWED_ORIGIN=.*|ALLOWED_ORIGIN=https://$APP_DOMAIN|" -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" -e "s|^ADMIN_USERNAME=.*|ADMIN_USERNAME=$ADMIN_USERNAME|" -e '/^ADMIN_PASSWORD=/d' "$ENV_FILE"
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
APP_DIR=/opt/cdanet-cpe-configurator;source /etc/cdanet-cpe/deploy.env;exec 9>/run/lock/cdanet-cpe-update.lock;flock -n 9||exit 0;export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes";cd "$APP_DIR";old=$(git rev-parse HEAD);git fetch --depth 1 origin "$BRANCH";new=$(git rev-parse FETCH_HEAD);[[ $old == $new ]]&&exit 0;git reset --hard "$new";cd deploy;docker compose --env-file .env build --pull;docker compose --env-file .env up -d --remove-orphans;docker image prune -f
UPDATER
chmod 0750 /usr/local/sbin/cdanet-cpe-update
cat >/etc/systemd/system/cdanet-cpe-update.service <<'EOF'
[Unit]
Description=CDA Net updater
After=network-online.target docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cdanet-cpe-update
EOF
cat >/etc/systemd/system/cdanet-cpe-update.timer <<'EOF'
[Unit]
Description=CDA Net auto-update every 60 seconds
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=1s
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload;systemctl enable --now cdanet-cpe-update.timer
cd "$APP_DIR/deploy";docker compose --env-file .env build --pull;ADMIN_PASSWORD="$ADMIN_PASSWORD" docker compose --env-file .env up -d --remove-orphans
for i in $(seq 1 30);do state=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cdanet-cpe-configurator-app-1 2>/dev/null||true);[[ $state == healthy ]]&&break;sleep 2;done;[[ ${state:-} == healthy ]]||exit 1
unset ADMIN_PASSWORD ADMIN_PASSWORD2;docker compose --env-file .env up -d --force-recreate app
echo "Installazione completata: https://$APP_DOMAIN";echo 'Master key AP secrets: server-only, fuori dalla repository e dal .env.'
