/** Shared regional geometry helpers. Geographic coordinates are [longitude, latitude]. */
import { LocalENU } from './vehicle-motion.js';
import { GRID_ORIGIN } from './grid-math.js';
export const feature = (geometry, properties = {}) => ({
  type: 'Feature',
  geometry,
  properties,
});
export const collection = (features) => ({ type: 'FeatureCollection', features });
export const regionalFrame = () => new LocalENU(GRID_ORIGIN);
export function localPoint(coordinate, enu) {
  if (
    !Array.isArray(coordinate) ||
    coordinate.length < 2 ||
    !coordinate.every(Number.isFinite)
  )
    throw Error('Invalid geographic coordinate.');
  const p = enu.toLocal(coordinate);
  if (Math.hypot(...p) > 250000)
    throw Error('Analysis is limited to the MBTA region, within 250 km of Boston.');
  return p.map((n) => Math.round(n * 10000) / 10000);
}
export function transformGeometry(geometry, convert) {
  if (!['Polygon', 'MultiPolygon'].includes(geometry?.type))
    throw Error('Choose or draw a polygon area first.');
  const polygon = (rings) => rings.map((ring) => ring.map(convert));
  return {
    type: geometry.type,
    coordinates:
      geometry.type === 'Polygon'
        ? polygon(geometry.coordinates)
        : geometry.coordinates.map(polygon),
  };
}
export function planarArea(geometry) {
  const ringArea = (ring) =>
    Math.abs(
      ring.slice(1).reduce((a, p, i) => a + ring[i][0] * p[1] - p[0] * ring[i][1], 0),
    ) / 2;
  const polygon = (rings) =>
    ringArea(rings[0]) - rings.slice(1).reduce((a, r) => a + ringArea(r), 0);
  return geometry.type === 'Polygon'
    ? polygon(geometry.coordinates)
    : geometry.coordinates.reduce((a, p) => a + polygon(p), 0);
}
export function networkMask(turf, snapshot) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const include = (p) => {
    bounds[0] = Math.min(bounds[0], p[0]);
    bounds[1] = Math.min(bounds[1], p[1]);
    bounds[2] = Math.max(bounds[2], p[0]);
    bounds[3] = Math.max(bounds[3], p[1]);
  };
  snapshot.stops.forEach((p) => include(p.coordinate));
  snapshot.vehicles.forEach((p) => include(p.coordinate));
  snapshot.lines.forEach((line) => line.coordinates.forEach(include));
  if (!Number.isFinite(bounds[0]))
    throw Error('No visible network data. Enable lines, stops or vehicles first.');
  return turf.bboxPolygon(bounds.map((v, i) => v + (i < 2 ? -0.00001 : 0.00001)));
}
