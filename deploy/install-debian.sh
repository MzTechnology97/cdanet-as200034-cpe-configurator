#!/usr/bin/env bash
# CDA Net CPE Configurator - Debian 12/13 installer / upgrader.
#
# Installs Docker, prepares secrets and the deploy directory, then starts the
# stack from the image published by CI. No source checkout or build on the server.
#
#   sudo ./deploy/install-debian.sh            (from a repository checkout)
#   curl -fsSL <raw-url>/deploy/install-debian.sh | sudo bash
#
# Re-running is safe: existing .env, master key and database are preserved.
set -Eeuo pipefail
umask 077

REPO="${CDANET_REPO:-MzTechnology97/cdanet-as200034-cpe-configurator}"
BRANCH="${CDANET_BRANCH:-main}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/cdanet-cpe}"
SECRETS_DIR=/etc/cdanet-cpe/secrets
MASTER_KEY=$SECRETS_DIR/master.key
RELEASES=/srv/cdanet-private/releases
LEGACY_DIR=/opt/cdanet-cpe-configurator

fail() { echo "ERRORE: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail "Eseguire come root."
. /etc/os-release
[[ ${ID:-} == debian && ${VERSION_ID:-} =~ ^(12|13)$ ]] || fail "Supportati Debian 12/13."

echo "=== CDA Net CPE Configurator · installazione ==="
apt-get update -qq
apt-get install -y -qq ca-certificates curl openssl >/dev/null

if ! command -v docker >/dev/null; then
  echo "[1/5] Installo Docker Engine"
  install -m0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<SRC
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
SRC
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
else
  echo "[1/5] Docker già presente"
fi
docker compose version >/dev/null || fail "Plugin docker compose mancante"

echo "[2/5] Directory e segreti"
install -d -m0750 "$DEPLOY_DIR" "$DEPLOY_DIR/updater" "$SECRETS_DIR" "$RELEASES"
[[ -f $MASTER_KEY ]] || { openssl rand -base64 32 >"$MASTER_KEY"; chmod 0400 "$MASTER_KEY"; echo "  creata master key $MASTER_KEY (fare backup sicuro!)"; }

echo "[3/5] File di deploy"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
fetch() {
  local rel=$1 dst=$2
  if [[ -n $SRC_DIR && -f $SRC_DIR/$rel ]]; then install -m0644 "$SRC_DIR/$rel" "$dst"; return; fi
  local auth=()
  [[ -n ${GITHUB_TOKEN:-} ]] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fsSL "${auth[@]}" -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/$REPO/contents/deploy/$rel?ref=$BRANCH" -o "$dst"
  chmod 0644 "$dst"
}
fetch docker-compose.yml "$DEPLOY_DIR/docker-compose.yml"
fetch Caddyfile "$DEPLOY_DIR/Caddyfile"
fetch updater/update.sh "$DEPLOY_DIR/updater/update.sh"
fetch .env.example "$DEPLOY_DIR/.env.example"
fetch reset-admin-password.sh "$DEPLOY_DIR/reset-admin-password.sh"
chmod 0755 "$DEPLOY_DIR/reset-admin-password.sh"
# Shortcut usable from any directory: sudo cdanet-cpe <docker compose args>
fetch cdanet-cpe /usr/local/bin/cdanet-cpe
chmod 0755 /usr/local/bin/cdanet-cpe

ENV_FILE=$DEPLOY_DIR/.env
FIRST_ADMIN=""
# Sets KEY=VALUE in .env without interpreting special characters in VALUE.
set_env() {
  K="$1" V="$2" awk -F= -v OFS== '$1==ENVIRON["K"]{print ENVIRON["K"] "=" ENVIRON["V"]; next} {print}' "$ENV_FILE" >"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}
if [[ ! -f $ENV_FILE ]]; then
  cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
  if [[ -f $LEGACY_DIR/deploy/.env ]]; then
    echo "  importo i valori dalla v0.5.x ($LEGACY_DIR/deploy/.env)"
    while IFS='=' read -r k v; do
      [[ -z $k || $k == \#* ]] && continue
      case $k in
        JWT_SECRET|ADMIN_USERNAME|CPE_*|UISP_ENROLLMENT|SNMP_*|GDPR_AUDIT_RETENTION_DAYS|ROUTEROS_ALLOW_PUBLIC|ANDROID_RELEASE_HOST_PATH)
          set_env "$k" "$v" ;;
      esac
    done < "$LEGACY_DIR/deploy/.env"
  else
    set_env JWT_SECRET "$(openssl rand -hex 48)"
    read -rp "Username amministratore [admin]: " u </dev/tty; u=${u:-admin}
    [[ $u =~ ^[A-Za-z0-9._-]{3,64}$ ]] || fail "Username non valido"
    while :; do
      read -rsp "Password amministratore (min 14): " p1 </dev/tty; echo
      read -rsp "Conferma password: " p2 </dev/tty; echo
      [[ ${#p1} -ge 14 && $p1 == "$p2" ]] && break
      echo "Password non valide, riprova."
    done
    set_env ADMIN_USERNAME "$u"
    FIRST_ADMIN=$p1
  fi
  set_env DEPLOY_DIR "$DEPLOY_DIR"
  chmod 0600 "$ENV_FILE"
  echo "  creato $ENV_FILE: completare CPE_ADMIN_PASSWORD e UISP_ENROLLMENT prima del provisioning"
fi

echo "[4/5] Stop eventuale stack v0.5.x"
if [[ -f $LEGACY_DIR/deploy/docker-compose.yml && $LEGACY_DIR != "$DEPLOY_DIR" ]]; then
  (cd "$LEGACY_DIR/deploy" && docker compose --env-file .env down --remove-orphans) || true
  echo "  stack legacy fermato: il volume dati 'cdanet-cpe-configurator_appdata' viene riutilizzato"
fi

echo "[5/5] Avvio"
cd "$DEPLOY_DIR"
if [[ -n ${GHCR_TOKEN:-} ]]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-cdanet}" --password-stdin
fi
docker compose --env-file .env pull
ADMIN_PASSWORD="$FIRST_ADMIN" docker compose --env-file .env up -d --remove-orphans
unset FIRST_ADMIN p1 p2

for _ in $(seq 1 60); do
  s=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || true)
  [[ $s == healthy ]] && break
  sleep 2
done
[[ ${s:-} == healthy ]] || { docker compose logs --tail=80 app; fail "health-check fallito"; }
docker compose exec -T app wget -qO- http://127.0.0.1:8787/api/health; echo
echo
echo "=== Installazione completata ==="
echo "Console: http://$(hostname -I | awk '{print $1}')  (APP_LISTEN=hostname in .env per HTTPS automatico)"
echo "Aggiornamenti automatici: container 'updater' (log: sudo cdanet-cpe logs -f updater)"
echo "Comandi: sudo cdanet-cpe help"
