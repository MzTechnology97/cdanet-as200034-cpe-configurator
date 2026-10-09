#!/bin/sh
# CDA Net auto-updater: keeps the "app" service on the newest image published
# from the repository (ghcr.io, built by CI only after tests pass).
#
# Every UPDATE_INTERVAL seconds: pull -> if the image changed: DB backup ->
# recreate app -> wait for healthy -> otherwise roll back to the previous image.
# After a successful update the deploy files shipped in the new image (compose,
# Caddyfile, this script, map script) are applied too, so the installer is not
# needed again for upgrades.
#
# It also applies the infrastructure settings requested from the console
# (Impostazioni server → Infrastruttura): the app writes /appdata/infra/request.env,
# this script validates every line, updates .env, restarts what is needed and
# writes the outcome to /appdata/infra/status.env.
set -eu

PROJECT="${COMPOSE_PROJECT_NAME:-cdanet-cpe-configurator}"
DIR="${DEPLOY_DIR:?DEPLOY_DIR required}"
HEALTH_TIMEOUT="${UPDATE_HEALTH_TIMEOUT:-180}"
STATE=/state
INFRA=/appdata/infra
mkdir -p "$STATE"

compose() { docker compose -p "$PROJECT" --project-directory "$DIR" -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" "$@"; }
log() { echo "$(date -u +%FT%TZ) $*"; }

# .env is read at every cycle: settings changed from the console apply without restarts.
get_env() { awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/, ""); v=$0} END{print v}' "$DIR/.env" 2>/dev/null; }
# Writes through the same inode (cat >): .env may be a bind-mounted file.
set_env() {
  t=$(mktemp)
  awk -v k="$1" -v v="$2" 'BEGIN{f=0} index($0, k "=")==1{print k "=" v; f=1; next} {print} END{if(!f) print k "=" v}' "$DIR/.env" >"$t" && cat "$t" >"$DIR/.env"
  rm -f "$t"
}
interval() { v=$(get_env UPDATE_INTERVAL); echo "${v:-${UPDATE_INTERVAL:-300}}"; }
window() { if grep -q '^UPDATE_WINDOW=' "$DIR/.env" 2>/dev/null; then get_env UPDATE_WINDOW; else echo "${UPDATE_WINDOW:-}"; fi; }
autoupdate() { v=$(get_env AUTOUPDATE); echo "${v:-${AUTOUPDATE:-1}}"; }

in_window() {
  w=$(window)
  [ -z "$w" ] && return 0
  h=$(date +%H | sed 's/^0//'); from=${w%-*}; to=${w#*-}
  from=$(echo "$from" | sed 's/^0//'); to=$(echo "$to" | sed 's/^0//')
  [ "${h:-0}" -ge "${from:-0}" ] && [ "${h:-0}" -lt "${to:-24}" ]
}

app_container() { compose ps -q app 2>/dev/null | head -n1; }

wait_healthy() {
  end=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$end" ]; do
    c=$(app_container)
    if [ -n "$c" ]; then
      s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)
      [ "$s" = healthy ] && return 0
      [ "$s" = unhealthy ] && return 1
    fi
    sleep 5
  done
  return 1
}

# ---- Deploy files shipped in the app image --------------------------------------------------
DEPLOY_FILES="docker-compose.yml Caddyfile updater/update.sh maps/fetch-basemap.sh"

# Recreates this updater from a throwaway container (it cannot replace itself while running).
restart_self() {
  docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$DIR:$DIR" -e DOCKER_CONFIG=/nonexistent docker:27-cli \
    sh -c "sleep 5; docker compose -p '$PROJECT' --project-directory '$DIR' -f '$DIR/docker-compose.yml' --env-file '$DIR/.env' up -d --no-deps --force-recreate updater" >/dev/null
}

sync_deploy() {
  c=$(app_container)
  [ -n "$c" ] || return 0
  new=$(mktemp -d)
  if ! docker cp "$c:/app/deploy/." "$new/" >/dev/null 2>&1; then rm -rf "$new"; return 0; fi # older images
  changed=""
  for f in $DEPLOY_FILES; do
    [ -f "$new/$f" ] || continue
    cmp -s "$new/$f" "$DIR/$f" 2>/dev/null || changed="$changed $f"
  done
  if [ -z "$changed" ]; then rm -rf "$new"; return 0; fi
  if ! docker compose -p "$PROJECT" --project-directory "$DIR" -f "$new/docker-compose.yml" --env-file "$DIR/.env" config -q >/dev/null 2>&1; then
    log "deploy files of the new version are not valid: kept the current ones"
    rm -rf "$new"
    return 0
  fi
  bk="$STATE/deploy-backup"
  rm -rf "$bk"; mkdir -p "$bk"
  for f in $DEPLOY_FILES; do [ -f "$DIR/$f" ] && mkdir -p "$bk/$(dirname "$f")" && cp -p "$DIR/$f" "$bk/$f"; done
  for f in $changed; do mkdir -p "$DIR/$(dirname "$f")"; cp "$new/$f" "$DIR/$f"; done
  chmod 0644 "$DIR/docker-compose.yml" "$DIR/Caddyfile" 2>/dev/null || true
  rm -rf "$new"
  log "deploy files updated:$changed"
  case "$changed" in *docker-compose.yml*|*Caddyfile*) compose up -d --no-deps --remove-orphans caddy >/dev/null 2>&1 || log "caddy restart failed" ;; esac
  case "$changed" in *docker-compose.yml*|*update.sh*) log "restarting the updater with the new files"; restart_self ;; esac
}

check_once() {
  c=$(app_container)
  if [ -z "$c" ]; then log "app container not running: starting it"; compose up -d app; return; fi
  image_ref=$(docker inspect -f '{{.Config.Image}}' "$c")
  current_id=$(docker inspect -f '{{.Image}}' "$c")

  compose pull -q app >/dev/null 2>&1 || { log "pull failed for $image_ref (network/registry?)"; return; }
  # the channel can change from the console: the image reference follows .env
  image_ref=$(compose config --images 2>/dev/null | grep cdanet-cpe-server | head -n1 || echo "$image_ref")
  new_id=$(docker image inspect -f '{{.Id}}' "$image_ref" 2>/dev/null || echo "")
  [ -z "$new_id" ] || [ "$new_id" = "$current_id" ] && return
  if grep -qx "$new_id" "$STATE/bad-images" 2>/dev/null; then return; fi

  new_ver=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image_ref" 2>/dev/null || echo "?")
  log "new image $image_ref ($new_ver, ${new_id#sha256:}) - backing up database"
  docker exec -u node "$c" node src/cli/backup.ts "pre-update-$new_ver" || { log "backup failed: update postponed"; return; }

  docker tag "$current_id" "${image_ref%:*}:rollback"
  compose up -d --no-deps app
  if wait_healthy; then
    log "updated to $new_ver"
    docker image prune -f >/dev/null 2>&1 || true
    sync_deploy || log "deploy files sync error"
  else
    log "new version unhealthy: rolling back"
    echo "$new_id" >> "$STATE/bad-images"
    docker logs --tail 80 "$(app_container)" 2>&1 | sed 's/^/  app> /' || true
    docker tag "$current_id" "$image_ref"
    compose up -d --no-deps app
    wait_healthy && log "rollback completed" || log "ROLLBACK FAILED: manual intervention required"
  fi
}

# ---- Infrastructure settings requested from the console ------------------------------------
INFRA_KEYS="APP_LISTEN HTTPS_SITES HTTPS_DEFAULT_SNI AUTOUPDATE UPDATE_INTERVAL UPDATE_WINDOW CDANET_CHANNEL MAP_MODE MAP_REGION MAP_BBOX"

valid() {
  case "$1" in
    APP_LISTEN) printf '%s' "$2" | grep -Eq '^(:[0-9]{1,5}|[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$' ;;
    HTTPS_SITES) printf '%s' "$2" | grep -Eq '^https://[A-Za-z0-9.:-]+( https://[A-Za-z0-9.:-]+){0,9}$' ;;
    HTTPS_DEFAULT_SNI) printf '%s' "$2" | grep -Eq '^[A-Za-z0-9.:-]{1,253}$' ;;
    AUTOUPDATE) printf '%s' "$2" | grep -Eq '^[01]$' ;;
    UPDATE_INTERVAL) printf '%s' "$2" | grep -Eq '^[0-9]{2,5}$' && [ "$2" -ge 60 ] ;;
    UPDATE_WINDOW) printf '%s' "$2" | grep -Eq '^([01][0-9]|2[0-4])-([01][0-9]|2[0-4])$' || [ -z "$2" ] ;;
    CDANET_CHANNEL) printf '%s' "$2" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,39}$' ;;
    MAP_MODE) printf '%s' "$2" | grep -Eq '^(local|off)$' ;;
    MAP_REGION) printf '%s' "$2" | grep -Eq '^(sicilia|isole|sud|centro|nord-est|nord-ovest|italia|custom)$' ;;
    MAP_BBOX) printf '%s' "$2" | grep -Eq '^-?[0-9]{1,3}(\.[0-9]+)?,-?[0-9]{1,2}(\.[0-9]+)?,-?[0-9]{1,3}(\.[0-9]+)?,-?[0-9]{1,2}(\.[0-9]+)?$' ;;
    *) return 1 ;;
  esac
}

bbox_of() {
  case "$1" in
    sicilia) echo 11.85,35.45,15.70,38.85 ;; isole) echo 8.10,35.45,15.70,41.32 ;; sud) echo 13.00,37.90,18.60,42.90 ;;
    centro) echo 9.60,41.20,14.10,44.50 ;; nord-est) echo 10.30,43.70,13.95,47.10 ;; nord-ovest) echo 6.60,43.75,11.45,46.70 ;;
    italia) echo 6.60,35.45,18.60,47.10 ;; *) echo "" ;;
  esac
}

# Value in use: .env, otherwise the compose default.
effective() {
  case "$1" in
    AUTOUPDATE) autoupdate ;; UPDATE_INTERVAL) interval ;; UPDATE_WINDOW) window ;;
    *) v=$(get_env "$1")
       case "$1" in
         APP_LISTEN) echo "${v:-:80}" ;; HTTPS_SITES) echo "${v:-https://localhost}" ;; HTTPS_DEFAULT_SNI) echo "${v:-localhost}" ;;
         CDANET_CHANNEL) echo "${v:-stable}" ;; MAP_MODE) echo "${v:-off}" ;; *) echo "$v" ;;
       esac ;;
  esac
}

# Current values for the console; rewritten only when .env changed (also by hand or by the installer).
write_current() {
  mkdir -p "$INFRA"
  t=$(mktemp)
  for k in $INFRA_KEYS; do printf '%s=%s\n' "$k" "$(effective "$k")" >>"$t"; done
  printf 'AGENT=1\n' >>"$t"
  cmp -s "$t" "$INFRA/current.env" || { cat "$t" >"$INFRA/current.env"; chmod 0644 "$INFRA/current.env" 2>/dev/null || true; }
  rm -f "$t"
}

status() {
  printf 'AT=%s\nRESULT=%s\nMESSAGE=%s\n' "$(date -u +%FT%TZ)" "$1" "$2" >"$INFRA/status.env"
  chmod 0644 "$INFRA/status.env" 2>/dev/null || true
  log "infra request: $1 - $2"
}

apply_request() {
  req="$INFRA/request.env"
  write_current
  [ -f "$req" ] || return 0
  work=$(mktemp)
  mv "$req" "$work" 2>/dev/null || { rm -f "$work"; return 0; }
  changed=""; bad=""; action=""
  while IFS= read -r line || [ -n "$line" ]; do
    line=$(printf '%s' "$line" | tr -d '\r')
    k=${line%%=*}; v=${line#*=}
    [ -z "$k" ] && continue
    if [ "$k" = ACTION ]; then action="$v"; continue; fi
    if valid "$k" "$v"; then
      if [ "$(get_env "$k")" != "$v" ]; then set_env "$k" "$v"; changed="$changed $k"; fi
    else
      bad="$bad $k"
    fi
  done <"$work"
  rm -f "$work"
  case "$changed" in *MAP_REGION*) r=$(get_env MAP_REGION); b=$(bbox_of "$r"); [ -n "$b" ] && set_env MAP_BBOX "$b" ;; esac
  case "$changed" in *APP_LISTEN*|*HTTPS_*) compose up -d --no-deps caddy >/dev/null 2>&1 || bad="$bad caddy" ;; esac
  map=""
  case "$changed" in *MAP_REGION*|*MAP_BBOX*|*MAP_MODE*) map=1 ;; esac
  [ "$action" = map_update ] && map=1
  if [ "$(get_env MAP_MODE)" = off ]; then
    # back to the public OpenStreetMap maps: the local basemap is removed
    case "$changed" in *MAP_MODE*) rm -f /appdata/maps/basemap.pmtiles; map=removed ;; *) map="" ;; esac
  elif [ -n "$map" ]; then
    write_current
    status running "download della mappa in corso (qualche minuto)"
    if compose --profile maps run --rm maptiles </dev/null >/tmp/maptiles.log 2>&1; then map=ok; else map=fail; fi
  fi
  write_current
  if [ -n "$bad" ]; then status error "non applicati (valori non validi o servizio non riavviato):$bad${changed:+ · applicati:$changed}"
  elif [ "$map" = fail ]; then status error "download della mappa non riuscito: $(tail -n 1 /tmp/maptiles.log | tr -d '\r')"
  else
    m=""
    [ "$map" = ok ] && m=" · mappa aggiornata"
    [ "$map" = removed ] && m=" · mappa locale rimossa"
    status ok "applicato:${changed:- nessuna modifica}$m"
  fi
}

# ---- Main loop --------------------------------------------------------------------------------
# The app (user node, uid 1000) writes request.env in this directory.
if [ -d /appdata ]; then mkdir -p "$INFRA" && chown 1000:1000 "$INFRA" 2>/dev/null || true; fi
write_current 2>/dev/null || true
log "auto-updater started: project=$PROJECT interval=$(interval)s window=$(window) autoupdate=$(autoupdate)"
# Let the installer / compose finish starting the stack before the first check.
start=$(date +%s)
while [ $(( $(date +%s) - start )) -lt "${UPDATE_START_DELAY:-120}" ]; do apply_request || true; sleep 10; done
while true; do
  if [ "$(autoupdate)" = 1 ] && in_window; then check_once || log "update cycle error"; fi
  # wait for the next check, applying console requests every 10 s meanwhile
  next=$(( $(date +%s) + $(interval) ))
  while [ "$(date +%s)" -lt "$next" ]; do apply_request || log "infra request error"; sleep 10; done
done
