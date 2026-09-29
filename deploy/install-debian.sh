#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/cdanet-cpe-configurator
REPO=${CDANET_REPO:-cdanet-as200034/cdanet-as200034-cpe-configurator}
BRANCH=${CDANET_BRANCH:-develop/tc2-secure-provisioning}
if [[ $EUID -ne 0 ]];then echo 'Eseguire come root.'>&2;exit 1;fi
. /etc/os-release
if [[ ${ID:-} != debian || ! ${VERSION_ID:-} =~ ^(12|13)$ ]];then echo 'Supportato solo Debian 12/13.'>&2;exit 1;fi
# Host prerequisites only: Docker + curl/CA. Node/npm/database/web server never run natively.
apt-get update;apt-get install -y ca-certificates curl gnupg openssl
install -m0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc;chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update;apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
install -d -m0750 "$APP_DIR" /etc/cdanet-cpe /srv/cdanet-private/firmware
if [[ -z ${GITHUB_TOKEN:-} ]];then read -rsp 'GitHub fine-grained token read-only: ' GITHUB_TOKEN;echo;fi
[[ -n $GITHUB_TOKEN ]]||{ echo 'Token obbligatorio.'>&2;exit 1; }
install -m0600 /dev/null /etc/cdanet-cpe/github.env
printf 'GITHUB_TOKEN=%q\nREPO=%q\nBRANCH=%q\n' "$GITHUB_TOKEN" "$REPO" "$BRANCH">/etc/cdanet-cpe/github.env
# Source retrieval uses an ephemeral utility container: no native git dependency.
docker run --rm -e GITHUB_TOKEN="$GITHUB_TOKEN" -e REPO="$REPO" -e BRANCH="$BRANCH" -v "$APP_DIR:/work" alpine:3.21 sh -ec 'apk add --no-cache git ca-certificates >/dev/null; rm -rf /tmp/repo; git clone --depth 1 --branch "$BRANCH" "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" /tmp/repo; rm -rf /work/* /work/.[!.]* /work/..?* 2>/dev/null || true; cp -a /tmp/repo/. /work/; git -C /work remote set-url origin "https://github.com/${REPO}.git"'
if [[ ! -f $APP_DIR/deploy/.env ]];then cp "$APP_DIR/deploy/.env.example" "$APP_DIR/deploy/.env";chmod 0600 "$APP_DIR/deploy/.env";sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" "$APP_DIR/deploy/.env";fi
cat >/usr/local/sbin/cdanet-cpe-update <<'UPDATER'
#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/cdanet-cpe-configurator;source /etc/cdanet-cpe/github.env
exec 9>/run/lock/cdanet-cpe-update.lock;flock -n 9||exit 0
old=$(docker run --rm -v "$APP_DIR:/repo:ro" alpine/git rev-parse --git-dir=/repo/.git --work-tree=/repo HEAD)
docker run --rm -e GITHUB_TOKEN="$GITHUB_TOKEN" -e BRANCH="$BRANCH" -v "$APP_DIR:/repo" alpine/git sh -ec 'git -C /repo -c http.extraHeader="Authorization: Bearer ${GITHUB_TOKEN}" fetch --depth 1 origin "$BRANCH"; git -C /repo reset --hard FETCH_HEAD'
new=$(docker run --rm -v "$APP_DIR:/repo:ro" alpine/git rev-parse --git-dir=/repo/.git --work-tree=/repo HEAD)
[[ "$old" == "$new" ]]&&exit 0
cd "$APP_DIR/deploy";docker compose --env-file .env build --pull;docker compose --env-file .env up -d --remove-orphans;docker image prune -f
logger -t cdanet-cpe-update "Docker stack aggiornato $old -> $new"
UPDATER
chmod 0750 /usr/local/sbin/cdanet-cpe-update
cat >/etc/systemd/system/cdanet-cpe-update.service <<'EOF'
[Unit]
Description=CDA Net Docker stack updater
After=network-online.target docker.service
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
echo "Docker-only install pronto. Configura $APP_DIR/deploy/.env e firmware, poi: cd $APP_DIR/deploy && docker compose --env-file .env up -d --build"
