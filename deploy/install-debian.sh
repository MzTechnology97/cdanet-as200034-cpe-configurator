#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=/opt/cdanet-cpe-configurator
REPO=${CDANET_REPO:-cdanet-as200034/cdanet-as200034-cpe-configurator}
BRANCH=${CDANET_BRANCH:-develop/tc2-secure-provisioning}

if [[ $EUID -ne 0 ]]; then echo 'Eseguire come root.' >&2; exit 1; fi
. /etc/os-release
if [[ ${ID:-} != debian || ! ${VERSION_ID:-} =~ ^(12|13)$ ]]; then echo 'Supportato solo Debian 12/13.' >&2; exit 1; fi

apt-get update
apt-get install -y ca-certificates curl git gnupg openssl
install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; chmod a+r /etc/apt/keyrings/docker.asc; fi
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

install -d -m 0750 "$APP_DIR" /etc/cdanet-cpe /srv/cdanet-private/firmware
if [[ -z ${GITHUB_TOKEN:-} ]]; then read -rsp 'GitHub fine-grained token (read-only Contents del repository privato): ' GITHUB_TOKEN; echo; fi
if [[ -z $GITHUB_TOKEN ]]; then echo 'Token obbligatorio.' >&2; exit 1; fi
install -m 0600 /dev/null /etc/cdanet-cpe/github.env
printf 'GITHUB_TOKEN=%q\nREPO=%q\nBRANCH=%q\n' "$GITHUB_TOKEN" "$REPO" "$BRANCH" >/etc/cdanet-cpe/github.env

clone_url="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"
if [[ ! -d $APP_DIR/.git ]]; then git clone --depth 1 --branch "$BRANCH" "$clone_url" "$APP_DIR"; else git -C "$APP_DIR" remote set-url origin "$clone_url"; git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"; git -C "$APP_DIR" reset --hard "origin/$BRANCH"; fi
# Remove credential from git config; updater injects it only for fetch.
git -C "$APP_DIR" remote set-url origin "https://github.com/${REPO}.git"

if [[ ! -f $APP_DIR/deploy/.env ]]; then cp "$APP_DIR/deploy/.env.example" "$APP_DIR/deploy/.env"; chmod 0600 "$APP_DIR/deploy/.env"; sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" "$APP_DIR/deploy/.env"; echo; echo "IMPORTANTE: modifica $APP_DIR/deploy/.env (dominio, admin password, bridge token e firmware path)."; fi

cat >/usr/local/sbin/cdanet-cpe-update <<'UPDATER'
#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/cdanet-cpe-configurator
source /etc/cdanet-cpe/github.env
exec 9>/run/lock/cdanet-cpe-update.lock
flock -n 9 || exit 0
cd "$APP_DIR"
old=$(git rev-parse HEAD)
git -c http.extraHeader="Authorization: Bearer ${GITHUB_TOKEN}" fetch --depth 1 origin "$BRANCH"
new=$(git rev-parse FETCH_HEAD)
[[ "$old" == "$new" ]] && exit 0
git reset --hard "$new"
cd deploy
docker compose --env-file .env build --pull
docker compose --env-file .env up -d --remove-orphans
docker image prune -f
logger -t cdanet-cpe-update "Aggiornato $old -> $new"
UPDATER
chmod 0750 /usr/local/sbin/cdanet-cpe-update

cat >/etc/systemd/system/cdanet-cpe-update.service <<'EOF'
[Unit]
Description=CDA Net CPE Configurator secure updater
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cdanet-cpe-update
User=root
EOF
cat >/etc/systemd/system/cdanet-cpe-update.timer <<'EOF'
[Unit]
Description=Check CDA Net CPE Configurator updates
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
RandomizedDelaySec=2min
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now cdanet-cpe-update.timer

echo
echo 'Installer completato.'
echo "Configura: $APP_DIR/deploy/.env"
echo 'Copia il firmware 8.7.4 in /srv/cdanet-private/firmware/ con il nome previsto nel file .env.'
echo "Poi avvia: cd $APP_DIR/deploy && docker compose --env-file .env up -d --build"
echo 'Aggiornamenti automatici: ogni ~15 minuti dal branch configurato.'
