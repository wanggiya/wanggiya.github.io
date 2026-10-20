/** Fixed-level S2 coverage, generated only in the analysis worker. */
import { s2 } from '../vendor/s2js-1.44.0.es.js';
import { MAX_CELLS } from './grid-math.js';
import {
  feature,
  collection,
  regionalFrame,
  localPoint,
  transformGeometry,
  networkMask,
} from './analysis-geometry.js';
const EARTH_RADIUS_M = 6371008.8;

function boundary(cell) {
  const ring = [];
  // Sample the great-circle edges rather than drawing long straight lon/lat chords.
  for (let edge = 0; edge < 4; edge++) {
    const a = cell.vertex(edge).vector,
      b = cell.vertex((edge + 1) % 4).vector;
    for (let step = 0; step < 8; step++) {
      const t = step / 8;
      const x = a.x * (1 - t) + b.x * t,
        y = a.y * (1 - t) + b.y * t,
        z = a.z * (1 - t) + b.z * t;
      ring.push([
        (Math.atan2(y, x) * 180) / Math.PI,
        (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
      ]);
    }
  }
  ring.push(ring[0]);
  return ring;
}

export function generateS2Grid(turf, { settings, snapshot, mask }) {
  const level = Number(settings.level);
  if (!Number.isInteger(level) || level < 8 || level > 18)
    throw Error('Choose an S2 level from 8 to 18.');
  if (settings.scope === 'network') mask = networkMask(turf, snapshot);
  const enu = regionalFrame();
  // Validate the entire area before traversing any cells.
  transformGeometry(mask?.geometry, (p) => localPoint(p, enu));
  const bounds = turf.bbox(mask);
  const averageKm2 = (4 * Math.PI * EARTH_RADIUS_M ** 2) / (6 * 4 ** level) / 1e6;
  if (turf.area(turf.bboxPolygon(bounds)) / 1e6 / averageKm2 > MAX_CELLS * 2)
    throw Error(
      'S2 grid too dense. Lower the level or choose a smaller area (5,000-cell limit).',
    );
  const region = s2.Rect.fromLatLng(s2.LatLng.fromDegrees(bounds[1], bounds[0])).addPoint(
    s2.LatLng.fromDegrees(bounds[3], bounds[2]),
  );
  const stack = Array.from({ length: 6 }, (_, face) =>
    s2.Cell.fromCellID(s2.cellid.fromFace(face)),
  );
  const cells = [];
  let candidates = 0;
  while (stack.length) {
    const cell = stack.pop();
    if (!cell.rectBound().intersects(region)) continue;
    if (cell.level < level) {
      stack.push(...cell.children());
      continue;
    }
    if (++candidates > MAX_CELLS)
      throw Error(
        'S2 grid too dense. Lower the level or choose a smaller area (5,000-cell limit).',
      );
    let polygon = feature({ type: 'Polygon', coordinates: [boundary(cell)] });
    const intersection = turf.intersect(collection([polygon, mask]));
    if (!intersection || turf.area(intersection) < 0.01) continue;
    const clipped = Boolean(settings.clip && settings.scope !== 'network');
    if (clipped) polygon = intersection;
    const token = s2.cellid.toToken(cell.id);
    polygon.properties = {
      cellId: token,
      s2Token: token,
      gridSystem: 's2',
      level,
      clipped,
      areaKm2: clipped
        ? turf.area(polygon) / 1e6
        : (cell.exactArea() * EARTH_RADIUS_M ** 2) / 1e6,
    };
    cells.push(polygon);
  }
  cells.sort((a, b) => a.properties.cellId.localeCompare(b.properties.cellId));
  return collection(cells);
}
