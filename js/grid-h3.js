/** H3 geometry adapter. Runs in the analysis worker, never in the animation loop. */
import * as h3 from '../vendor/h3-js-4.5.0.es.js';
import { LocalENU } from './vehicle-motion.js';
import { GRID_ORIGIN, MAX_CELLS } from './grid-math.js';

const feature = (geometry, properties = {}) => ({
  type: 'Feature',
  geometry,
  properties,
});
const collection = (features) => ({ type: 'FeatureCollection', features });

export function generateH3Grid(turf, { settings, snapshot, mask }) {
  const resolution = Number(settings.resolution);
  if (!Number.isInteger(resolution) || resolution < 5 || resolution > 11)
    throw Error('Choose an H3 resolution from 5 to 11.');
  if (settings.scope === 'network') {
    // Cover the network extent first; the shared analyzer removes empty cells.
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
    // Avoid a zero-area extent for a single point or a straight route.
    const pad = 0.00001;
    mask = turf.bboxPolygon([
      bounds[0] - pad,
      bounds[1] - pad,
      bounds[2] + pad,
      bounds[3] + pad,
    ]);
  }
  if (!mask || !['Polygon', 'MultiPolygon'].includes(mask.geometry.type))
    throw Error('Choose or draw an area first.');
  const enu = new LocalENU(GRID_ORIGIN);
  const polygons =
    mask.geometry.type === 'Polygon'
      ? [mask.geometry.coordinates]
      : mask.geometry.coordinates;
  for (const poly of polygons)
    for (const ring of poly)
      for (const p of ring)
        if (!p.every(Number.isFinite) || Math.hypot(...enu.toLocal(p)) > 250000)
          throw Error('Analysis is limited to the MBTA region, within 250 km of Boston.');

  // Reject obviously oversized requests BEFORE allocating a potentially huge fill.
  // This conservative estimate is a guard, not a claim that cells have equal area.
  const estimate =
    turf.area(turf.bboxPolygon(turf.bbox(mask))) /
    1e6 /
    h3.getHexagonAreaAvg(resolution, h3.UNITS.km2);
  if (estimate > MAX_CELLS * 2)
    throw Error(
      'H3 grid too dense. Lower resolution or choose a smaller area (5,000-cell limit).',
    );
  const ids = new Set();
  for (const poly of polygons) {
    const part = h3.polygonToCellsExperimental(
      poly,
      resolution,
      h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
      true,
    );
    for (const id of part) {
      ids.add(id);
      if (ids.size > MAX_CELLS)
        throw Error(
          'H3 grid too dense. Lower resolution or choose a smaller area (5,000-cell limit).',
        );
    }
  }
  const features = [];
  for (const id of [...ids].sort()) {
    // GeoJSON coordinate order is longitude, latitude; H3 closes this ring.
    let cell = feature({ type: 'Polygon', coordinates: [h3.cellToBoundary(id, true)] });
    let areaKm2 = h3.cellArea(id, h3.UNITS.km2);
    if (settings.clip && settings.scope !== 'network') {
      cell = turf.intersect(collection([cell, mask]));
      if (!cell) continue;
      // Clipped fragments are no longer full H3 cells. Use their geographic area.
      areaKm2 = turf.area(cell) / 1e6;
    }
    if (areaKm2 < 1e-8) continue;
    cell.properties = {
      cellId: id,
      h3Index: id,
      gridSystem: 'h3',
      resolution,
      clipped: Boolean(settings.clip && settings.scope !== 'network'),
      areaKm2,
    };
    features.push(cell);
  }
  return collection(features);
}
