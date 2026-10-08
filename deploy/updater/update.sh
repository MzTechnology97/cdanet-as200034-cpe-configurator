#!/bin/sh
# CDA Net auto-updater: keeps the "app" service on the newest image published
# from the repository (ghcr.io, built by CI only after tests pass).
#
# Every UPDATE_INTERVAL seconds: pull -> if the image changed: DB backup ->
# recreate app -> wait for healthy -> otherwise roll back to the previous image.
set -eu

PROJECT="${COMPOSE_PROJECT_NAME:-cdanet-cpe-configurator}"
DIR="${DEPLOY_DIR:?DEPLOY_DIR required}"
INTERVAL="${UPDATE_INTERVAL:-300}"
WINDOW="${UPDATE_WINDOW:-}"          # e.g. "01-05": only update between 01:00 and 04:59
HEALTH_TIMEOUT="${UPDATE_HEALTH_TIMEOUT:-180}"
STATE=/state
mkdir -p "$STATE"

compose() { docker compose -p "$PROJECT" --project-directory "$DIR" -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" "$@"; }
log() { echo "$(date -u +%FT%TZ) $*"; }

in_window() {
  [ -z "$WINDOW" ] && return 0
  h=$(date +%H | sed 's/^0//'); from=${WINDOW%-*}; to=${WINDOW#*-}
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

check_once() {
  c=$(app_container)
  if [ -z "$c" ]; then log "app container not running: starting it"; compose up -d app; return; fi
  image_ref=$(docker inspect -f '{{.Config.Image}}' "$c")
  current_id=$(docker inspect -f '{{.Image}}' "$c")

  compose pull -q app >/dev/null 2>&1 || { log "pull failed for $image_ref (network/registry?)"; return; }
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
  else
    log "new version unhealthy: rolling back"
    echo "$new_id" >> "$STATE/bad-images"
    docker logs --tail 80 "$(app_container)" 2>&1 | sed 's/^/  app> /' || true
    docker tag "$current_id" "$image_ref"
    compose up -d --no-deps app
    wait_healthy && log "rollback completed" || log "ROLLBACK FAILED: manual intervention required"
  fi
}

if [ "${AUTOUPDATE:-1}" != "1" ]; then log "AUTOUPDATE disabled: idle"; while true; do sleep 3600; done; fi
log "auto-updater started: project=$PROJECT interval=${INTERVAL}s window=${WINDOW:-always}"
while true; do
  if in_window; then check_once || log "update cycle error"; fi
  sleep "$INTERVAL"
done
