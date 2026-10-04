#!/usr/bin/env bash
set -Eeuo pipefail
DEST=${ANDROID_RELEASE_HOST_PATH:-/srv/cdanet-private/releases}
APK=${1:-}
META=${2:-}
[[ $EUID -eq 0 ]] || { echo "Eseguire come root." >&2; exit 1; }
[[ -f "$APK" && -f "$META" ]] || { echo "Uso: $0 CDA-Net-CPE-x.y.z.apk latest.json" >&2; exit 2; }
python3 - "$APK" "$META" <<'PY'
import hashlib,json,sys
from pathlib import Path
apk=Path(sys.argv[1]); meta=Path(sys.argv[2])
m=json.loads(meta.read_text())
required={'versionCode','versionName','sha256','fileName'}
if not required <= set(m): raise SystemExit('latest.json incompleto')
sha=hashlib.sha256(apk.read_bytes()).hexdigest()
if sha.lower()!=str(m['sha256']).lower(): raise SystemExit('SHA-256 non corrisponde')
if apk.name!=m['fileName']: raise SystemExit('Nome APK diverso da latest.json')
print('Release verificata',m['versionName'],sha)
PY
install -d -m0755 "$DEST"
install -m0644 "$APK" "$DEST/$([[ -n "$APK" ]] && basename "$APK")"
install -m0644 "$META" "$DEST/latest.json.new"
mv -f "$DEST/latest.json.new" "$DEST/latest.json"
echo "Release pubblicata in $DEST"
