/**
 * The one way to hand inline map HTML to a WebView.
 *
 * iOS BLACK MAP (founder 2026-08-11): `source={{html}}` with no `baseUrl` makes
 * WKWebView call `loadHTMLString:baseURL:nil`, which gives the document a NULL
 * (opaque) origin. Mapbox GL JS v3 starts its render/worker threads from
 * `blob:` URLs, and WKWebView refuses blob workers on a null origin — so GL
 * never initialises, the canvas is never painted, and the div keeps its CSS
 * background. The result is a perfectly laid-out BLACK RECTANGLE with no error:
 * the main frame loaded fine, so `onError` never fires either.
 *
 * Android's WebView is permissive about this, which is why the same build looks
 * correct there and black on an iPhone.
 *
 * Giving the document a real https origin fixes the worker bootstrap, and makes
 * the GL script/CSS same-origin rather than cross-origin from a null source.
 */

/** A real, secure origin — the one the map assets already come from. */
export const MAP_HTML_BASE_URL = 'https://api.mapbox.com';

export interface MapWebViewSource {
  html: string;
  baseUrl: string;
}

/**
 * Wrap inline map HTML for `<WebView source={...} />`.
 *
 * Keep the returned object's identity stable across renders (`useMemo`) — a
 * fresh object every render makes the WebView re-evaluate and can remount the
 * map mid-mission.
 */
export function mapHtmlSource(html: string): MapWebViewSource {
  return {html, baseUrl: MAP_HTML_BASE_URL};
}
