import { useEffect, useRef, useState } from 'react';
import { createMap, fit, legend, popup } from '../../../web/js/map.js';
import { Dom } from '../ui';

/**
 * The map of the console (one component for every page with a map): Leaflet with the local
 * basemap (or the public tiles), the admins' views (satellite, 3D) as on the other maps, loaded
 * only with the page that shows it. [draw] receives the map and Leaflet each time [deps] change
 * and returns the layers to fit; they are removed before the next draw and with the page.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type L = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LMap = any;

export function MapView({
  draw,
  deps = [],
  zoom = 10,
  tall = false,
  legendItems,
  fitMaxZoom,
}: {
  draw: (map: LMap, L: L) => unknown[];
  deps?: unknown[];
  zoom?: number;
  tall?: boolean;
  legendItems?: Array<[string, string]>;
  fitMaxZoom?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<LMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    let made: LMap | null = null;
    createMap(el.current, { zoom })
      .then((m: LMap) => {
        made = m;
        if (gone) m?.remove();
        else setMap(m);
      })
      .catch((e: Error) => !gone && setError(e.message));
    return () => {
      gone = true;
      made?.remove();
    };
  }, []);

  useEffect(() => {
    if (!map) return;
    const W = (window as unknown as { L: L }).L;
    const group = W.layerGroup().addTo(map);
    const layers = draw(group, W).filter(Boolean);
    if (layers.length) {
      fit(map, layers);
      if (fitMaxZoom && map.getZoom() > fitMaxZoom) map.setZoom(fitMaxZoom);
    }
    // the size of a map just shown in a panel is known only now
    const t = setTimeout(() => map.invalidateSize(), 200);
    return () => {
      clearTimeout(t);
      group.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ...deps]);

  return (
    <div className="mv">
      <div ref={el} className={`map${tall ? ' map-tall' : ''}`} />
      {error && <p className="ui-muted ui-small">Mappa non disponibile: {error}</p>}
      {legendItems && <Dom make={() => legend(legendItems)} />}
    </div>
  );
}

/** The popup of a marker: a title and a few lines (escaped: no markup from the data). */
export const mapPopup = (title: string, ...lines: Array<string | null | undefined | false>): HTMLElement => popup(title, ...lines);
