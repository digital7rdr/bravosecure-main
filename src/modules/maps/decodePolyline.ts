/**
 * Google/Mapbox encoded-polyline decoder.
 *
 * Ported verbatim (behaviour, not style) from the WebView map's inline
 * `decodePolyline`, where it sits inside a generated HTML template literal and
 * so has never been testable. The mission route arrives from the Directions
 * API as an encoded string at **precision 6** — decoding it at precision 5,
 * the library default, silently puts the route ~10x off in both axes, which
 * looks like a route to nowhere rather than an error.
 *
 * Output is [lng, lat] — Mapbox order, NOT the {lat, lng} the payloads use.
 */
export type LngLat = [number, number];

export function decodePolyline(str: string, precision = 5): LngLat[] {
  if (!str) {
    return [];
  }
  const factor = Math.pow(10, precision);
  const coords: LngLat[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

/** The precision the Directions API responses in this app are encoded at. */
export const ROUTE_POLYLINE_PRECISION = 6;
