#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/cdanet-cpe-configurator; CFG_DIR=/etc/cdanet-cpe; SSH_DIR=$CFG_DIR/ssh
KEY=$SSH_DIR/github_deploy_ed25519; KNOWN=$SSH_DIR/known_hosts
REPO=${CDANET_REPO:-cdanet-as200034/cdanet-as200034-cpe-configurator}; BRANCH=${CDANET_BRANCH:-release/v0.1.0-admin-tester}
cleanup(){ unset ADMIN_PASSWORD ADMIN_PASSWORD2 2>/dev/null||true; rm -f "$APP_DIR/deploy/.env.bootstrap" 2>/dev/null||true; }; trap cleanup EXIT
[[ $EUID -eq 0 ]]||{ echo 'Eseguire come root.'>&2;exit 1; }; . /etc/os-release
[[ ${ID:-} == debian && ${VERSION_ID:-} =~ ^(12|13)$ ]]||{ echo 'Supportato solo Debian 12/13.'>&2;exit 1; }
apt-get update; apt-get install -y ca-certificates curl gnupg openssl openssh-client git
install -m0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update; apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; systemctl enable --now docker
install -d -m0750 "$APP_DIR" "$CFG_DIR" "$SSH_DIR" /srv/cdanet-private/firmware
[[ -f $KEY ]]||ssh-keygen -q -t ed25519 -N '' -C 'cdanet-cpe-deploy' -f "$KEY"; chmod 0600 "$KEY";chmod 0644 "$KEY.pub"
ssh-keyscan -t ed25519 github.com >"$KNOWN.tmp"; fp=$(ssh-keygen -lf "$KNOWN.tmp" -E sha256|awk '{print $2}'|head -1)
[[ "$fp" == 'SHA256:+DiY3wvvV6TuJJhbpZisF/zL+D7qKcLkGvQ5c5s1xAM' ]]||{ echo "Fingerprint GitHub inatteso: $fp" >&2;exit 1; }; mv "$KNOWN.tmp" "$KNOWN";chmod 0644 "$KNOWN"
echo;echo '=== DEPLOY KEY GITHUB READ-ONLY ===';cat "$KEY.pub";echo 'Aggiungila alla repository privata come Deploy key SENZA write access.';read -rp 'Premi INVIO dopo averla autorizzata... '
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes"
ssh -T git@github.com 2>&1|grep -Eq 'successfully authenticated|does not provide shell access'||{ echo 'Deploy key non autorizzata.'>&2;exit 1; }
git_url="git@github.com:${REPO}.git"; if [[ ! -d $APP_DIR/.git ]];then rm -rf "$APP_DIR";git clone --depth 1 --branch "$BRANCH" "$git_url" "$APP_DIR";else git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH";git -C "$APP_DIR" reset --hard FETCH_HEAD;fi
read -rp 'Dominio/FQDN HTTPS (es. cpe.cda-net.it): ' APP_DOMAIN; [[ "$APP_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]||{ echo 'Dominio non valido.'>&2;exit 1; }
read -rp 'Username amministratore piattaforma: ' ADMIN_USERNAME; [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{3,80}$ ]]||{ echo 'Username non valido.'>&2;exit 1; }
while :;do read -rsp 'Password Admin (min 14 caratteri): ' ADMIN_PASSWORD;echo;read -rsp 'Conferma password: ' ADMIN_PASSWORD2;echo;[[ ${#ADMIN_PASSWORD} -ge 14 ]]||{ echo 'Password troppo corta.';continue; };[[ "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD2" ]]&&break;echo 'Le password non coincidono.';done
ENV_FILE=$APP_DIR/deploy/.env; cp "$APP_DIR/deploy/.env.example" "$ENV_FILE";chmod 0600 "$ENV_FILE";JWT_SECRET=$(openssl rand -hex 48)
esc(){ printf '%s' "$1"|sed 's/\\/\\\\/g;s/"/\\"/g'; }
sed -i -e "s|^APP_DOMAIN=.*|APP_DOMAIN=\"$(esc "$APP_DOMAIN")\"|" -e "s|^ALLOWED_ORIGIN=.*|ALLOWED_ORIGIN=\"https://$(esc "$APP_DOMAIN")\"|" -e "s|^JWT_SECRET=.*|JWT_SECRET=\"$JWT_SECRET\"|" -e "s|^ADMIN_USERNAME=.*|ADMIN_USERNAME=\"$(esc "$ADMIN_USERNAME")\"|" -e '/^ADMIN_PASSWORD=/d' "$ENV_FILE"
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
APP_DIR=/opt/cdanet-cpe-configurator;source /etc/cdanet-cpe/deploy.env;exec 9>/run/lock/cdanet-cpe-update.lock;flock -n 9||exit 0
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes";cd "$APP_DIR";old=$(git rev-parse HEAD);git fetch --depth 1 origin "$BRANCH";new=$(git rev-parse FETCH_HEAD);[[ "$old" == "$new" ]]&&exit 0;git reset --hard "$new";cd deploy;docker compose --env-file .env build --pull;docker compose --env-file .env up -d --remove-orphans;docker image prune -f;logger -t cdanet-cpe-update "Aggiornato $old -> $new"
UPDATER
chmod 0750 /usr/local/sbin/cdanet-cpe-update
cat >/etc/systemd/system/cdanet-cpe-update.service <<'EOF'
[Unit]
Description=CDA Net Docker stack updater
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cdanet-cpe-update
EOF
cat >/etc/systemd/system/cdanet-cpe-update.timer <<'EOF'
[Unit]
Description=CDA Net Docker auto-update
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
RandomizedDelaySec=2min
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload;systemctl enable --now cdanet-cpe-update.timer
cd "$APP_DIR/deploy";docker compose --env-file .env build --pull;ADMIN_PASSWORD="$ADMIN_PASSWORD" docker compose --env-file .env up -d --remove-orphans
# Do not discard bootstrap credential until backend confirms successful DB initialization.
for i in $(seq 1 30);do state=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cdanet-cpe-configurator-app-1 2>/dev/null||true);[[ "$state" == healthy ]]&&break;sleep 2;done
[[ "${state:-}" == healthy ]]||{ echo 'Backend non healthy: credenziale bootstrap non salvata su disco; controllare docker compose logs app.'>&2;exit 1; }
unset ADMIN_PASSWORD ADMIN_PASSWORD2
# Prove restart without bootstrap password: existing admin DB must be sufficient.
docker compose --env-file .env up -d --force-recreate app
for i in $(seq 1 30);do state=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cdanet-cpe-configurator-app-1 2>/dev/null||true);[[ "$state" == healthy ]]&&break;sleep 2;done
[[ "${state:-}" == healthy ]]||{ echo 'Test restart senza password bootstrap FALLITO.'>&2;exit 1; }
echo;echo 'INSTALLER CONSOLIDATO: bootstrap Admin e restart senza password verificati.';echo "PWA: https://$APP_DOMAIN";echo "Admin: $ADMIN_USERNAME";echo 'La password Admin non è presente nel file .env. Deploy key privata solo sul server.'
