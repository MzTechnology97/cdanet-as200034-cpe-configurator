#!/bin/sh
# Starts as root only to adopt volumes created by older (root) versions and to
# hand the master key to the unprivileged user, then drops to "node".
set -eu
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data "${ANDROID_RELEASE_DIR:-/opt/cdanet/releases}" /run/cdanet
  chown -R node:node /data
  chown -R node:node "${ANDROID_RELEASE_DIR:-/opt/cdanet/releases}" 2>/dev/null || true
  if [ -f "${SECRETS_KEY_FILE}" ]; then
    # chmod before chown: after chown root would need CAP_FOWNER to change the mode.
    cp "${SECRETS_KEY_FILE}" /run/cdanet/master.key
    chmod 0400 /run/cdanet/master.key
    chown node:node /run/cdanet/master.key
    export SECRETS_KEY_FILE=/run/cdanet/master.key
  fi
  exec su-exec node "$@"
fi
exec "$@"
