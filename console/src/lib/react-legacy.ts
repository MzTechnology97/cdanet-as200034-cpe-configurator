/**
 * web/js/react.js inside the build: the components of web/js written with htm (the tools of
 * Copertura, a few cards) run on the React of the console, as parts of its pages. The same
 * exports; vite.config.ts puts this module in place of that one for every import from web/js.
 */
import { createElement, Fragment as F, type ReactNode, useCallback as uc, useEffect as ue, useMemo as um, useRef as ur, useState as us } from 'react';
import htm from '../../../web/vendor/htm/htm.module.js';

export const html = htm.bind(createElement as (type: unknown, props: unknown, ...children: unknown[]) => unknown);

export const useState = us;
export const useEffect = ue;
export const useMemo = um;
export const useRef = ur;
export const useCallback = uc;
export const Fragment = (props: { children?: ReactNode }) => createElement(F, null, props.children);
