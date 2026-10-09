#!/usr/bin/env bash
# CDA Net CPE Configurator - Debian 12/13 installer / upgrader.
#
# Installs Docker, prepares secrets and the deploy directory, then starts the
# stack from the image published by CI. No source checkout or build on the server.
#
#   sudo ./deploy/install-debian.sh            (from a repository checkout)
#   curl -fsSL <raw-url>/deploy/install-debian.sh | sudo bash
#
# Local OpenStreetMap geocoder (Nominatim container), asked on first run or forced with:
#   sudo CDANET_GEOCODER=local [CDANET_GEOCODER_REGION=sicilia] ./deploy/install-debian.sh
#   sudo CDANET_GEOCODER=public ./deploy/install-debian.sh       (back to the public service)
#   regions: sicilia (default), isole (Sicilia+Sardegna), sud, centro, nord-est, nord-ovest,
#            italia, custom (CDANET_GEOCODER_PBF_URL [+ CDANET_GEOCODER_REPLICATION_URL])
#
# Console maps (Protomaps basemap, OpenStreetMap data, downloaded once and refreshed monthly):
#   CDANET_MAP=local (default) | off      CDANET_MAP_REGION=<region above> (default: the geocoder's)
#   CDANET_MAP_BBOX=minLon,minLat,maxLon,maxLat for a custom area
#
# Unattended first install (no questions), e.g. for automation:
#   CDANET_ADMIN_USER=admin CDANET_ADMIN_PASSWORD=... CDANET_GEOCODER=local|public
# Image override (pin a version or test a local build): CDANET_IMAGE, CDANET_CHANNEL,
# CDANET_SKIP_PULL=1 (use images already present).
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
install -d -m0755 "$DEPLOY_DIR/maps"
fetch maps/fetch-basemap.sh "$DEPLOY_DIR/maps/fetch-basemap.sh"
chmod 0755 "$DEPLOY_DIR/maps" && chmod 0644 "$DEPLOY_DIR/maps/fetch-basemap.sh"
fetch .env.example "$DEPLOY_DIR/.env.example"
fetch reset-admin-password.sh "$DEPLOY_DIR/reset-admin-password.sh"
chmod 0755 "$DEPLOY_DIR/reset-admin-password.sh"
# Shortcut usable from any directory: sudo cdanet-cpe <docker compose args>
fetch cdanet-cpe /usr/local/bin/cdanet-cpe
chmod 0755 /usr/local/bin/cdanet-cpe

ENV_FILE=$DEPLOY_DIR/.env
FIRST_ADMIN=""
# Sets KEY=VALUE in .env (appended when missing) without interpreting special characters in VALUE.
set_env() {
  K="$1" V="$2" awk -F= -v OFS== 'BEGIN{f=0} $1==ENVIRON["K"]{print ENVIRON["K"] "=" ENVIRON["V"]; f=1; next} {print} END{if(!f) print ENVIRON["K"] "=" ENVIRON["V"]}' "$ENV_FILE" >"$ENV_FILE.tmp"
  cat "$ENV_FILE.tmp" >"$ENV_FILE"; rm -f "$ENV_FILE.tmp"
}
get_env() { K="$1" awk -F= '$1==ENVIRON["K"]{sub(/^[^=]*=/, ""); v=$0} END{print v}' "$ENV_FILE" 2>/dev/null; }
has_tty() { [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; }
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
    if [[ -n ${CDANET_ADMIN_PASSWORD:-} ]]; then
      u=${CDANET_ADMIN_USER:-admin}
      p1=$CDANET_ADMIN_PASSWORD
      [[ ${#p1} -ge 14 ]] || fail "CDANET_ADMIN_PASSWORD: almeno 14 caratteri"
    else
      has_tty || fail "Installazione senza terminale: imposta CDANET_ADMIN_USER e CDANET_ADMIN_PASSWORD"
      read -rp "Username amministratore [admin]: " u </dev/tty; u=${u:-admin}
      while :; do
        read -rsp "Password amministratore (min 14): " p1 </dev/tty; echo
        read -rsp "Conferma password: " p2 </dev/tty; echo
        [[ ${#p1} -ge 14 && $p1 == "$p2" ]] && break
        echo "Password non valide, riprova."
      done
    fi
    [[ $u =~ ^[A-Za-z0-9._-]{3,64}$ ]] || fail "Username non valido"
    set_env ADMIN_USERNAME "$u"
    FIRST_ADMIN=$p1
  fi
  set_env DEPLOY_DIR "$DEPLOY_DIR"
  chmod 0600 "$ENV_FILE"
  echo "  creato $ENV_FILE: completare CPE_ADMIN_PASSWORD e UISP_ENROLLMENT prima del provisioning"
fi
[[ -z ${CDANET_IMAGE:-} ]] || set_env CDANET_IMAGE "$CDANET_IMAGE"
[[ -z ${CDANET_CHANNEL:-} ]] || set_env CDANET_CHANNEL "$CDANET_CHANNEL"

# --- OpenStreetMap: local Nominatim container or public service --------------------------
GEOCODER_LOCAL=0
setup_geocoder() {
  local mode=${CDANET_GEOCODER:-} saved region old_region pbf repl ram_mb disk_gb need_ram need_disk a
  saved=$(get_env GEOCODER_MODE)
  if [[ -z $mode ]]; then
    if [[ -n $saved ]]; then
      mode=$saved
    elif has_tty; then
      echo "  OpenStreetMap locale: la ricerca indirizzi (Copertura, posizione CPE) gira su questo server,"
      echo "  senza inviare indirizzi all'esterno. Per la Sicilia servono almeno 3 GB di RAM e 15 GB di disco liberi."
      read -rp "  Installare OpenStreetMap locale (Nominatim)? [S/n]: " a </dev/tty
      if [[ ${a:-S} =~ ^[sSyY] ]]; then mode=local; else mode=public; fi
    else
      mode=public
    fi
  fi
  if [[ $mode != local ]]; then
    set_env GEOCODER_MODE public
    set_env COMPOSE_PROFILES ""
    set_env GEOCODER_URL https://nominatim.openstreetmap.org
    set_env GEOCODER_FALLBACK_URL ""
    echo "  OpenStreetMap: servizio pubblico (nominatim.openstreetmap.org)"
    return 0
  fi

  old_region=$(get_env NOMINATIM_REGION)
  region=${CDANET_GEOCODER_REGION:-$old_region}
  if [[ -z $region ]] && has_tty; then
    read -rp "  Regione OSM da importare [sicilia] (sicilia, isole, sud, centro, nord-est, nord-ovest, italia): " region </dev/tty
  fi
  region=${region:-sicilia}
  case $region in
    sicilia)
      # openstreetmap.fr: Sicily-only extract (Geofabrik only has Sicilia+Sardegna).
      pbf=https://download.openstreetmap.fr/extracts/europe/italy/sicilia-latest.osm.pbf
      repl=https://download.openstreetmap.fr/replication/europe/italy/sicilia/minute/
      need_ram=3000; need_disk=15 ;;
    isole|sud|centro|nord-est|nord-ovest)
      pbf=https://download.geofabrik.de/europe/italy/$region-latest.osm.pbf
      repl=https://download.geofabrik.de/europe/italy/$region-updates/
      need_ram=4000; need_disk=25 ;;
    italia)
      pbf=https://download.geofabrik.de/europe/italy-latest.osm.pbf
      repl=https://download.geofabrik.de/europe/italy-updates/
      need_ram=8000; need_disk=90 ;;
    custom)
      pbf=${CDANET_GEOCODER_PBF_URL:-$(get_env NOMINATIM_PBF_URL)}
      repl=${CDANET_GEOCODER_REPLICATION_URL-$(get_env NOMINATIM_REPLICATION_URL)}
      [[ $pbf =~ ^https?:// ]] || fail "Regione custom: imposta CDANET_GEOCODER_PBF_URL"
      need_ram=2000; need_disk=10 ;;
    *) fail "Regione OSM non valida: $region" ;;
  esac
  if [[ -n $old_region && $old_region != "$region" ]] && docker volume inspect cdanet-cpe-configurator_nominatim_data >/dev/null 2>&1; then
    echo "  ATTENZIONE: i dati già importati sono della regione '$old_region'."
    echo "  Per passare a '$region' dopo l'installazione: sudo cdanet-cpe geocoder reset"
  fi

  ram_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
  mkdir -p /var/lib/docker
  disk_gb=$(df -BG --output=avail /var/lib/docker | tail -1 | tr -dc 0-9)
  if (( ram_mb < need_ram || disk_gb < need_disk )); then
    echo "  ATTENZIONE: per '$region' servono circa $need_ram MB di RAM e $need_disk GB liberi (disponibili: $ram_mb MB, $disk_gb GB)."
    echo "  L'import potrebbe essere lento o fallire; nel frattempo la ricerca usa il servizio pubblico come riserva."
  fi

  # PostgreSQL sized on this server's RAM (the image defaults assume 32+ GB).
  local sb=$(( ram_mb / 8 )) mw=$(( ram_mb / 4 )) ec=$(( ram_mb / 2 ))
  (( sb > 2048 )) && sb=2048
  (( mw > 4096 )) && mw=4096
  (( mw < 256 )) && mw=256
  set_env GEOCODER_MODE local
  set_env COMPOSE_PROFILES geocoder
  set_env GEOCODER_URL http://nominatim:8080
  set_env GEOCODER_FALLBACK_URL https://nominatim.openstreetmap.org
  set_env NOMINATIM_REGION "$region"
  set_env NOMINATIM_PBF_URL "$pbf"
  set_env NOMINATIM_REPLICATION_URL "$repl"
  [[ -n $(get_env NOMINATIM_PASSWORD) ]] || set_env NOMINATIM_PASSWORD "$(openssl rand -hex 24)"
  set_env NOMINATIM_THREADS "$(nproc)"
  set_env NOMINATIM_PG_SHARED_BUFFERS "${sb}MB"
  set_env NOMINATIM_PG_MAINTENANCE_WORK_MEM "${mw}MB"
  set_env NOMINATIM_PG_EFFECTIVE_CACHE_SIZE "${ec}MB"
  GEOCODER_LOCAL=1
  echo "  OpenStreetMap locale: regione '$region' (import automatico al primo avvio, aggiornamento giornaliero)"
}
echo "[3b/5] OpenStreetMap"
setup_geocoder

MAP_FETCH=0
setup_map() {
  local mode=${CDANET_MAP:-$(get_env MAP_MODE)} region bbox old
  mode=${mode:-local}
  if [[ $mode == off ]]; then
    set_env MAP_MODE off
    echo "  Mappe: disattivate (la console usa le mappe pubbliche di OpenStreetMap)"
    return 0
  fi
  [[ $mode == local ]] || fail "CDANET_MAP non valido: $mode (local|off)"
  region=${CDANET_MAP_REGION:-$(get_env MAP_REGION)}
  region=${region:-$(get_env NOMINATIM_REGION)}
  region=${region:-sicilia}
  case $region in
    sicilia) bbox=11.85,35.45,15.70,38.85 ;;
    isole) bbox=8.10,35.45,15.70,41.32 ;;
    sud) bbox=13.00,37.90,18.60,42.90 ;;
    centro) bbox=9.60,41.20,14.10,44.50 ;;
    nord-est) bbox=10.30,43.70,13.95,47.10 ;;
    nord-ovest) bbox=6.60,43.75,11.45,46.70 ;;
    italia) bbox=6.60,35.45,18.60,47.10 ;;
    custom) bbox=${CDANET_MAP_BBOX:-$(get_env MAP_BBOX)} ;;
    *) fail "Regione mappa non valida: $region" ;;
  esac
  [[ $bbox =~ ^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$ ]] || fail "Area mappa non valida: '$bbox' (CDANET_MAP_BBOX=minLon,minLat,maxLon,maxLat)"
  old=$(get_env MAP_BBOX)
  set_env MAP_MODE local
  set_env MAP_REGION "$region"
  set_env MAP_BBOX "$bbox"
  [[ $old != "$bbox" ]] && MAP_FETCH=1
  # Monthly refresh (systemd timer: present on every Debian, unlike cron).
  cat >/etc/systemd/system/cdanet-cpe-map.service <<'UNIT'
[Unit]
Description=CDA Net CPE - aggiornamento mappa (Protomaps / OpenStreetMap)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cdanet-cpe map update
UNIT
  cat >/etc/systemd/system/cdanet-cpe-map.timer <<'UNIT'
[Unit]
Description=CDA Net CPE - aggiornamento mensile della mappa

[Timer]
OnCalendar=monthly
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  chmod 0644 /etc/systemd/system/cdanet-cpe-map.service /etc/systemd/system/cdanet-cpe-map.timer
  if [[ -d /run/systemd/system ]]; then
    systemctl daemon-reload && systemctl enable --now cdanet-cpe-map.timer >/dev/null 2>&1 || echo "  (timer mensile non attivato: systemd non disponibile)"
  fi
  echo "  Mappe: regione '$region' ($bbox), aggiornamento mensile"
}
echo "[3c/5] Mappe"
setup_map

echo "[4/5] Stop eventuale stack v0.5.x"
# Only once: the legacy stack uses the same compose project name, so a later "down"
# would stop the current stack too.
if [[ -f $LEGACY_DIR/deploy/docker-compose.yml && $LEGACY_DIR != "$DEPLOY_DIR" && ! -f $DEPLOY_DIR/.legacy-stopped ]]; then
  (cd "$LEGACY_DIR/deploy" && docker compose --env-file .env down --remove-orphans) || true
  touch "$DEPLOY_DIR/.legacy-stopped"
  echo "  stack legacy fermato: il volume dati 'cdanet-cpe-configurator_appdata' viene riutilizzato"
else
  echo "  niente da fare"
fi

echo "[5/5] Avvio"
cd "$DEPLOY_DIR"
if [[ -n ${GHCR_TOKEN:-} ]]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-cdanet}" --password-stdin
fi
if [[ ${CDANET_SKIP_PULL:-0} == 1 ]]; then echo "  pull saltato (CDANET_SKIP_PULL=1)"; else docker compose --env-file .env pull; fi
wait_app() {
  local s=""
  for _ in $(seq 1 90); do
    s=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -aq app)" 2>/dev/null || true)
    [[ $s == healthy ]] && return 0
    sleep 2
  done
  docker compose logs --tail=80 app
  fail "l'app non si avvia (log qui sopra)"
}
# App first (and alone): the updater must not race with it, and a failing start shows its log.
# ADMIN_PASSWORD is passed only for the very first boot (it creates the admin) and the
# container is then recreated without it, so it never stays visible in "docker inspect".
ADMIN_PASSWORD="$FIRST_ADMIN" docker compose --env-file .env up -d --remove-orphans --no-deps app || true
wait_app
unset FIRST_ADMIN p1 p2
docker compose --env-file .env up -d --remove-orphans
wait_app
docker compose exec -T app wget -qO- http://127.0.0.1:8787/api/health; echo
if [[ $(get_env MAP_MODE) == local ]]; then
  if [[ $MAP_FETCH == 1 ]] || ! docker compose exec -T app test -s /data/maps/basemap.pmtiles; then
    echo "Download della mappa (Protomaps, regione $(get_env MAP_REGION)): qualche minuto..."
    docker compose --env-file .env --profile maps run --rm maptiles || echo "  ATTENZIONE: mappa non scaricata, riprova con: sudo cdanet-cpe map update (intanto la console usa le mappe pubbliche)"
  fi
fi
echo
echo "=== Installazione completata ==="
echo "Console: http://$(hostname -I | awk '{print $1}')  (APP_LISTEN=hostname in .env per HTTPS automatico)"
echo "Aggiornamenti automatici: container 'updater' (log: sudo cdanet-cpe logs -f updater)"
echo "Comandi: sudo cdanet-cpe help"
if [[ $GEOCODER_LOCAL == 1 ]]; then
  echo
  echo "OpenStreetMap locale: il container 'nominatim' scarica e importa i dati (da ~20 minuti a qualche ora)."
  echo "  Avanzamento: sudo cdanet-cpe geocoder   (fino al termine la ricerca indirizzi usa il servizio pubblico)"
fi
