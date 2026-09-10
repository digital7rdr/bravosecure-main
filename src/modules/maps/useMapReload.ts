import {useCallback, useEffect, useReducer} from 'react';

/**
 * B-77 — recovery state machine for the WebView Mapbox surfaces.
 *
 * Every map is a `WebView source={{html}}` loading mapbox-gl from a CDN. If any
 * boot request fails (the GL script, the style JSON, the first tiles) or WebGL
 * can't init, the map stays a blank rectangle forever: GL never retries a style
 * fetch, and on Android react-native-webview only fires onError/onHttpError for
 * MAIN-frame failures — and the main frame is the inline HTML, which can't fail
 * — so a token 401 / style fetch / tile failure surfaces as nothing.
 *
 * The one signal every surface reliably emits on success is a `{type:'ready'}`
 * postMessage from `map.on('load')`. So we treat "no `ready` within a timeout"
 * as a failed load: auto-remount once (recovers a transient blip without a tap),
 * then surface a RETRY affordance. Using the watchdog rather than reacting to
 * `map.on('error')` deliberately avoids remounting a WORKING map on a benign
 * post-load tile hiccup (GL fires `error` for recoverable tile 404s too).
 */
export type MapHealth = 'loading' | 'ready' | 'failed';

export interface MapHealthState {
  status: MapHealth;
  /** Bump to force a WebView remount (`key={reloadKey}`). */
  reloadKey: number;
  /** Automatic remount attempts spent on the current load sequence. */
  autoRetries: number;
}

export type MapHealthEvent = {t: 'ready'} | {t: 'fail'} | {t: 'retry'};

export const INITIAL_MAP_HEALTH: MapHealthState = {status: 'loading', reloadKey: 0, autoRetries: 0};

/**
 * Pure transition (unit-tested without React):
 *  - `ready`  → up; clears the auto-retry budget.
 *  - `fail`   → ignored once ready (late tile error); otherwise remount while
 *               budget remains, else `failed`.
 *  - `retry`  → manual RETRY; fresh attempt with a full budget.
 */
export function mapHealthReducer(
  state: MapHealthState,
  event: MapHealthEvent,
  maxAutoRetries: number,
): MapHealthState {
  switch (event.t) {
    case 'ready':
      return {status: 'ready', reloadKey: state.reloadKey, autoRetries: 0};
    case 'fail':
      if (state.status === 'ready') {return state;}
      if (state.autoRetries < maxAutoRetries) {
        return {status: 'loading', reloadKey: state.reloadKey + 1, autoRetries: state.autoRetries + 1};
      }
      return {status: 'failed', reloadKey: state.reloadKey, autoRetries: state.autoRetries};
    case 'retry':
      return {status: 'loading', reloadKey: state.reloadKey + 1, autoRetries: 0};
    default:
      return state;
  }
}

export interface MapReload {
  status: MapHealth;
  reloadKey: number;
  /** Call when the map posts `{type:'ready'}`. */
  onReady: () => void;
  /** Call on an explicit fatal signal (e.g. a pre-load `maperror` message). */
  onError: () => void;
  /** Wire to a RETRY button. */
  retry: () => void;
}

export function useMapReload(opts?: {timeoutMs?: number; maxAutoRetries?: number}): MapReload {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const maxAutoRetries = opts?.maxAutoRetries ?? 1;
  const [state, dispatch] = useReducer(
    (s: MapHealthState, e: MapHealthEvent) => mapHealthReducer(s, e, maxAutoRetries),
    INITIAL_MAP_HEALTH,
  );

  // Watchdog — each load attempt (initial mount or a reloadKey bump) that hasn't
  // reached `ready` within the window dispatches `fail`. Cleared the instant the
  // status leaves `loading`, so a slow-but-successful load never trips it.
  useEffect(() => {
    if (state.status !== 'loading') {return undefined;}
    const t = setTimeout(() => dispatch({t: 'fail'}), timeoutMs);
    return () => clearTimeout(t);
  }, [state.status, state.reloadKey, timeoutMs]);

  return {
    status: state.status,
    reloadKey: state.reloadKey,
    onReady: useCallback(() => dispatch({t: 'ready'}), []),
    onError: useCallback(() => dispatch({t: 'fail'}), []),
    retry: useCallback(() => dispatch({t: 'retry'}), []),
  };
}
