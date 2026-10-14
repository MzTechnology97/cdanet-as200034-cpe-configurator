import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import { createMap, fit, type Leaflet, leaflet, type LMap, popup } from './leaflet';

export type { Leaflet, LMap };
export { leaflet };

/**
 * The map of the console (one component for every page with a map): Leaflet with the local
 * basemap (or the public tiles), the admins' views (satellite, 3D) as on the other maps, loaded
 * only with the page that shows it. [draw] receives a layer group, Leaflet and the map each time
 * [deps] change and returns the layers to fit; the group is emptied before the next draw and the
 * map removed with the page. [fitMode] 'once' keeps the view where the user put it on the next
 * draws (a page refreshed every minute). [mapRef] and [onReady] give the page the map itself (to
 * centre a point from a list, to listen to its events).
 */
export function MapView({
  draw,
  deps = [],
  zoom = 10,
  center,
  tall = false,
  legendItems,
  fitMaxZoom,
  fitMode = 'always',
  mapRef,
  onReady,
}: {
  draw: (target: Leaflet, L: Leaflet, map: LMap) => unknown[];
  deps?: unknown[];
  zoom?: number;
  center?: [number, number];
  tall?: boolean;
  legendItems?: Array<[string, string]>;
  fitMaxZoom?: number;
  fitMode?: 'always' | 'once' | 'never';
  mapRef?: MutableRefObject<LMap | null>;
  onReady?: (map: LMap, L: Leaflet) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<LMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    let gone = false;
    let made: LMap | null = null;
    createMap(el.current!, { zoom, ...(center ? { center } : {}) })
      .then((m: LMap) => {
        made = m;
        if (gone) m?.remove();
        else {
          if (mapRef) mapRef.current = m;
          if (m) onReady?.(m, leaflet());
          setMap(m);
        }
      })
      .catch((e: Error) => !gone && setError(e.message));
    return () => {
      gone = true;
      made?.remove();
      if (mapRef) mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!map) return;
    const L = leaflet();
    const group = L.layerGroup().addTo(map);
    const layers = draw(group, L, map).filter(Boolean);
    if (layers.length && fitMode !== 'never' && (fitMode === 'always' || !fitted.current)) {
      fit(map, layers);
      if (fitMaxZoom && map.getZoom() > fitMaxZoom) map.setZoom(fitMaxZoom);
      fitted.current = true;
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
      {legendItems && <Legend items={legendItems} />}
    </div>
  );
}

/** The popup of a marker: a title and a few lines (escaped: no markup from the data). */
export const mapPopup = (title: string, ...lines: Array<string | null | undefined | false>): HTMLElement => popup(title, ...lines);

/** The legend under a map: [colour, text] of each kind of mark. */
export function Legend({ items }: { items: Array<[color: string, text: string]> }) {
  return (
    <div className="map-legend small">
      {items.map(([color, text]) => (
        <span key={text}>
          <i className="dot" style={{ background: color }} />
          {text}
        </span>
      ))}
    </div>
  );
}
