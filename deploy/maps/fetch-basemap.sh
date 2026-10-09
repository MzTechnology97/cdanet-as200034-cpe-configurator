#!/bin/sh
# Downloads (or refreshes) the Protomaps basemap - OpenStreetMap data, BSD/ODbL - of the
# configured area into the app data volume (/data/maps/basemap.pmtiles). Runs in a throwaway
# container ("maptiles" service): sudo cdanet-cpe map update
#
#   MAP_BBOX     minLon,minLat,maxLon,maxLat (set by the installer from the region)
#   MAP_MAXZOOM  highest zoom kept (default 15, the basemap's own maximum)
set -eu
umask 022

PMTILES_VERSION=1.31.2
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x86_64 SUM=3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f ;;
  aarch64 | arm64) ARCH=arm64 SUM=f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1 ;;
  *) echo "Architettura non supportata: $(uname -m)" >&2; exit 1 ;;
esac
BBOX=${MAP_BBOX:?MAP_BBOX mancante}
MAXZOOM=${MAP_MAXZOOM:-15}

echo "Preparazione strumenti..."
apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null

cd /tmp
curl -fsSL -o pmtiles.tgz "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${ARCH}.tar.gz"
echo "$SUM  pmtiles.tgz" | sha256sum -c - >/dev/null
tar -xzf pmtiles.tgz pmtiles

# Latest daily build of the Protomaps basemap (OpenStreetMap data).
BUILD=$(curl -fsSL https://build-metadata.protomaps.dev/builds.json | grep -o '"key":"[0-9]\{8\}\.pmtiles"' | cut -d'"' -f4 | sort | tail -1)
[ -n "$BUILD" ] || { echo "Nessuna build Protomaps trovata" >&2; exit 1; }

echo "Scarico la mappa ($BUILD, area $BBOX, zoom fino a $MAXZOOM)..."
mkdir -p /data/maps
./pmtiles extract "https://build.protomaps.com/$BUILD" /data/maps/basemap.tmp.pmtiles --bbox="$BBOX" --maxzoom="$MAXZOOM"
mv -f /data/maps/basemap.tmp.pmtiles /data/maps/basemap.pmtiles
chmod 0644 /data/maps/basemap.pmtiles
echo "Mappa pronta: $(du -h /data/maps/basemap.pmtiles | cut -f1) ($BUILD)"
