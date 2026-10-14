/**
 * React for the components of web/js written with htm (tagged templates instead of JSX:
 * `html\`<${Card} title=${t}>…</${Card}>\``), used inside the console's React pages. In the build
 * of the console this module is replaced by console/src/lib/react-legacy.ts (vite.config.ts), so
 * they run on the console's own React: what is here only describes the same exports.
 *
 * Text is always escaped by React: like dom.js, no markup from data can get into the page.
 */
import htm from '../vendor/htm/htm.module.js';

const R = () => window.React;

export const html = htm.bind((type, props, ...children) => R().createElement(type, props, ...children));

export const useState = (...a) => R().useState(...a);
export const useEffect = (...a) => R().useEffect(...a);
export const useMemo = (...a) => R().useMemo(...a);
export const useRef = (...a) => R().useRef(...a);
export const useCallback = (...a) => R().useCallback(...a);
export const Fragment = (props) => R().createElement(R().Fragment, null, props.children);
