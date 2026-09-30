#!/usr/bin/env bash
set -Eeuo pipefail
export CDANET_BRANCH=main
exec "$(dirname "$0")/install-debian.sh" "$@"
