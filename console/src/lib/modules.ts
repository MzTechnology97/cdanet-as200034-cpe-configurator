import { api } from './api';

/** Enabled optional features ("Funzionalità"), from /api/meta. Unknown = on (older servers). */
let state: Record<string, boolean> = {};
let loaded = false;

export const isOn = (key: string) => state[key] !== false;
export const modulesLoaded = () => loaded;

export async function loadModules() {
  try {
    state = (await api<{ modules?: Record<string, boolean> }>('/api/meta')).modules ?? {};
  } catch {
    state = {};
  }
  loaded = true;
}

export function setModules(next: Record<string, boolean>) {
  state = next;
  loaded = true;
}

export function resetModules() {
  state = {};
  loaded = false;
}
