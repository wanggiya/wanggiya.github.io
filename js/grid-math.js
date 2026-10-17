/** Local-meter grid geometry and deterministic per-cell analysis.
 * Local ENU origin stays fixed so redrawing the same cell size keeps its lattice.
 */
import { LocalENU } from './vehicle-motion.js';
export const GRID_ORIGIN = [-71.06, 42.35];
export const MAX_CELLS = 5000;
export const DEFAULT_WEIGHTS = {
  bus: 1,
  silver: 1.25,
  ferry: 1.5,
  lightRail: 2,
  commuter: 2.5,
  subway: 3,
};
const axes = [0, 1];
const feature = (geometry, properties = {}) => ({
  type: 'Feature',
  geometry,
  properties,
});
const polygon = (ring) => feature({ type: 'Polygon', coordinates: [ring] });
const fc = (features) => ({ type: 'FeatureCollection', features });
const frame = () => new LocalENU(GRID_ORIGIN);
const box = (points) => [
  Math.min(...points.map((p) => p[0])),
  Math.min(...points.map((p) => p[1])),
  Math.max(...points.map((p) => p[0])),
  Math.max(...points.map((p) => p[1])),
];
const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const rings = (geometry) =>
  geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
function transformGeometry(geometry, convert) {
  const mapRing = (ring) => ring.map(convert);
  return {
    type: geometry.type,
    coordinates:
      geometry.type === 'Polygon'
        ? geometry.coordinates.map(mapRing)
        : geometry.coordinates.map((poly) => poly.map(mapRing)),
  };
}
function area(geometry) {
  const ringArea = (ring) =>
    Math.abs(
      ring.slice(1).reduce((sum, p, i) => sum + ring[i][0] * p[1] - p[0] * ring[i][1], 0),
    ) / 2;
  const polyArea = (poly) =>
    ringArea(poly[0]) - poly.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
  return geometry.type === 'Polygon'
    ? polyArea(geometry.coordinates)
    : geometry.coordinates.reduce((sum, poly) => sum + polyArea(poly), 0);
}
function insideRing(p, ring) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
    if (
      Math.abs(cross) < 1e-6 &&
      p[0] >= Math.min(a[0], b[0]) - 1e-7 &&
      p[0] <= Math.max(a[0], b[0]) + 1e-7 &&
      p[1] >= Math.min(a[1], b[1]) - 1e-7 &&
      p[1] <= Math.max(a[1], b[1]) + 1e-7
    )
      return true;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}
function contains(geometry, p) {
  const insidePoly = (poly) =>
    insideRing(p, poly[0]) && !poly.slice(1).some((ring) => insideRing(p, ring));
  return geometry.type === 'Polygon'
    ? insidePoly(geometry.coordinates)
    : geometry.coordinates.some(insidePoly);
}
function asMeters(coord, enu) {
  if (!Array.isArray(coord) || !coord.every(Number.isFinite))
    throw Error('Invalid geographic coordinate.');
  const p = enu.toLocal(coord);
  if (Math.hypot(...p) > 250000)
    throw Error(
      'This metric grid is designed for the MBTA region, within 250 km of Boston. Zoom closer.',
    );
  return p.map((v) => Math.round(v * 10000) / 10000);
}
function networkPoints(snapshot) {
  return [
    ...snapshot.stops.map((p) => p.coordinate),
    ...snapshot.vehicles.map((p) => p.coordinate),
    ...snapshot.lines.flatMap((l) => l.coordinates),
  ];
}
function validate(settings) {
  if (
    !['square', 'hexagon', 'right-triangle', 'equilateral-triangle'].includes(
      settings.type,
    )
  )
    throw Error('Choose a grid type.');
  if (!Number.isFinite(settings.distance) || settings.distance <= 0)
    throw Error('Cell size must be positive.');
  if (!['kilometers', 'miles'].includes(settings.units))
    throw Error('Choose kilometers or miles.');
  return settings.distance * (settings.units === 'miles' ? 1609.344 : 1000);
}

export function generateMetricGrid(turf, payload) {
  const { settings, snapshot, mask } = payload;
  const side = validate(settings),
    enu = frame();
  let metricMask = null,
    points;
  if (settings.scope === 'network') {
    const coords = networkPoints(snapshot);
    if (!coords.length)
      throw Error('No visible network data. Enable lines, stops or vehicles first.');
    points = coords.map((p) => asMeters(p, enu));
  } else {
    if (!mask || !['Polygon', 'MultiPolygon'].includes(mask.geometry.type))
      throw Error('Choose or draw an area first.');
    metricMask = transformGeometry(mask.geometry, (p) => asMeters(p, enu));
    points = rings(metricMask).flat();
  }
  // Reduce without argument spreading: complete MBTA line geometry can contain
  // hundreds of thousands of coordinates and must not overflow the call stack.
  const bounds = points.reduce(
    (b, p) => [
      Math.min(b[0], p[0]),
      Math.min(b[1], p[1]),
      Math.max(b[2], p[0]),
      Math.max(b[3], p[1]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const stepX = settings.type === 'hexagon' ? side * 1.5 : side;
  const stepY =
    settings.type === 'hexagon'
      ? side * Math.sqrt(3)
      : settings.type === 'equilateral-triangle'
        ? (side * Math.sqrt(3)) / 2
        : side;
  const minCol = Math.floor(bounds[0] / stepX) - 2,
    maxCol = Math.ceil(bounds[2] / stepX) + 2;
  const minRow = Math.floor(bounds[1] / stepY) - 2,
    maxRow = Math.ceil(bounds[3] / stepY) + 2;
  const factor = settings.type.includes('triangle') ? 2 : 1;
  if ((maxCol - minCol + 1) * (maxRow - minRow + 1) * factor > MAX_CELLS)
    throw Error(
      'Grid too dense. Increase cell size or use a smaller area (limit 5,000 candidate cells).',
    );
  const cells = [];
  const add = (vertices, id) => {
    vertices = vertices.map((p) => p.map((v) => Math.round(v * 10000) / 10000));
    const ring = [...vertices, vertices[0]];
    if (!overlaps(bounds, box(vertices))) return;
    let cell = polygon(ring);
    if (metricMask) {
      // Turf intersect is planar polygon clipping; here both operands use the
      // SAME local-meter coordinate system. Never call geodesic Turf area on it.
      const intersection = turf.intersect(fc([cell, feature(metricMask)]));
      if (!intersection || area(intersection.geometry) < 0.01) return;
      if (settings.clip) cell = intersection;
    }
    const a = area(cell.geometry);
    if (a < 0.01) return;
    cell.properties = { cellId: id, areaKm2: a / 1e6 };
    cells.push(cell);
  };
  for (let col = minCol; col <= maxCol; col++)
    for (let row = minRow; row <= maxRow; row++) {
      const x = col * stepX,
        y = row * stepY,
        id = `${col}:${row}`;
      if (settings.type === 'hexagon') {
        // Flat-top regular hexagons, alternating half-row vertical offset.
        const cy =
          row * side * Math.sqrt(3) + ((((col % 2) + 2) % 2) * side * Math.sqrt(3)) / 2;
        add(
          Array.from({ length: 6 }, (_, k) => [
            x + side * Math.cos((k * Math.PI) / 3),
            cy + side * Math.sin((k * Math.PI) / 3),
          ]),
          id,
        );
      } else if (settings.type === 'equilateral-triangle') {
        const shift = ((((row % 2) + 2) % 2) * side) / 2;
        const a = [x + shift, y],
          b = [x + shift + side, y],
          top = [x + shift + side / 2, y + stepY];
        add([a, b, top], id + ':a');
        add([b, [x + shift + side * 1.5, y + stepY], top], id + ':b');
      } else {
        const a = [x, y],
          b = [x + side, y],
          c = [x + side, y + side],
          d = [x, y + side];
        if (settings.type === 'square') add([a, b, c, d], id);
        else {
          add([a, b, c], id + ':a');
          add([a, c, d], id + ':b');
        }
      }
    }
  const geographic = fc(
    cells.map((cell) =>
      feature(
        transformGeometry(cell.geometry, (p) => enu.toLonLat(p)),
        cell.properties,
      ),
    ),
  );
  return geographic;
}

/** Index candidate cells by local-meter bins, rather than checking all cells
 * for every stop, vehicle and route segment. Boundary ownership is deterministic.
 */
export function analyzeGrid(
  turf,
  grid,
  snapshot,
  weights = DEFAULT_WEIGHTS,
  scope = 'view',
) {
  const enu = frame();
  for (const key of Object.keys(DEFAULT_WEIGHTS))
    if (!Number.isFinite(weights[key]) || weights[key] < 0 || weights[key] > 20)
      throw Error('Weights must be between 0 and 20.');
  const cells = grid.features.map((f) => ({
    feature: f,
    geometry: transformGeometry(f.geometry, (p) => asMeters(p, enu)),
  }));
  const binSize = Math.max(
    50,
    Math.sqrt(
      (cells.reduce((sum, c) => sum + c.feature.properties.areaKm2, 0) * 1e6) /
        Math.max(1, cells.length),
    ),
  );
  const bins = new Map();
  function visitBox(b, fn) {
    for (let x = Math.floor(b[0] / binSize); x <= Math.floor(b[2] / binSize); x++)
      for (let y = Math.floor(b[1] / binSize); y <= Math.floor(b[3] / binSize); y++)
        fn(`${x}:${y}`);
  }
  cells.forEach((c, i) => {
    c.bounds = box(rings(c.geometry).flat());
    visitBox(c.bounds, (key) => {
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(i);
    });
    c.counts = {
      stops: 0,
      vehicles: 0,
      lineKm: 0,
      weightedStops: 0,
      weightedVehicles: 0,
      weightedLineKm: 0,
    };
  });
  const totalBounds = cells.reduce(
    (b, c) => [
      Math.min(b[0], c.bounds[0]),
      Math.min(b[1], c.bounds[1]),
      Math.max(b[2], c.bounds[2]),
      Math.max(b[3], c.bounds[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const candidates = (b) => {
    if (!overlaps(b, totalBounds)) return [];
    b = [
      Math.max(b[0], totalBounds[0]),
      Math.max(b[1], totalBounds[1]),
      Math.min(b[2], totalBounds[2]),
      Math.min(b[3], totalBounds[3]),
    ];
    const ids = new Set();
    visitBox(b, (key) => {
      for (const id of bins.get(key) || []) ids.add(id);
    });
    return [...ids].filter((i) => overlaps(b, cells[i].bounds)).sort((a, b) => a - b);
  };
  function pointCounts(points, kind) {
    const seen = new Set();
    for (const p of points) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const xy = asMeters(p.coordinate, enu);
      const id = candidates([xy[0], xy[1], xy[0], xy[1]]).find((i) =>
        contains(cells[i].geometry, xy),
      );
      if (id === undefined) continue;
      const modes = p.modes || [p.mode];
      const weight = Math.max(...modes.map((m) => weights[m] ?? 1));
      cells[id].counts[kind]++;
      cells[id].counts[kind === 'stops' ? 'weightedStops' : 'weightedVehicles'] += weight;
    }
  }
  pointCounts(snapshot.stops, 'stops');
  pointCounts(snapshot.vehicles, 'vehicles');
  const seenSegments = new Set();
  let scannedLineSegments = 0,
    candidateLineSegments = 0;
  // Broad geographic rejection is only an optimization. The exact local-grid
  // candidate query below decides whether a segment belongs in the work budget.
  // The margin accommodates curvature of the regional ENU bounding rectangle.
  const geographicCorners = [
    [totalBounds[0], totalBounds[1]],
    [totalBounds[2], totalBounds[1]],
    [totalBounds[2], totalBounds[3]],
    [totalBounds[0], totalBounds[3]],
  ].map((p) => enu.toLonLat(p));
  const geographicBounds = box(geographicCorners).map((v, i) => v + (i < 2 ? -0.1 : 0.1));
  const localCache = new Map();
  const localPoint = (coordinate) => {
    const key = coordinate[0] + ',' + coordinate[1];
    if (!localCache.has(key)) {
      if (localCache.size >= 50000) localCache.clear();
      localCache.set(key, asMeters(coordinate, enu));
    }
    return localCache.get(key);
  };
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  for (const line of snapshot.lines) {
    const coords = line.coordinates;
    for (let k = 1; k < coords.length; k++) {
      scannedLineSegments++;
      const from = coords[k - 1],
        to = coords[k];
      // Endpoint bounding boxes also retain segments that cross the area with
      // BOTH endpoints outside it; do not filter only by endpoint containment.
      if (!overlaps(geographicBounds, box([from, to]))) continue;
      const a = localPoint(from),
        b = localPoint(to);
      const segmentBounds = box([a, b]);
      if (!overlaps(segmentBounds, totalBounds)) continue;
      const vector = axes.map((i) => b[i] - a[i]);
      const length = Math.hypot(...vector);
      if (length < 0.001) continue;
      const ends = [a, b].map((p) => p.map((v) => Math.round(v * 10)).join(',')).sort();
      const key = line.routeId + '|' + ends.join('|');
      if (seenSegments.has(key)) continue;
      const ids = candidates(segmentBounds);
      if (!ids.length) continue;
      seenSegments.add(key);
      // Limit unique segments that require cell clipping, not the number of
      // coordinates in the entire MBTA network or repeated pattern geometries.
      if (++candidateLineSegments > 250000)
        throw Error(
          'This analysis area contains too many unique route segments. Use a smaller area or fewer visible routes.',
        );
      const cuts = [0, 1];
      for (const id of ids)
        for (const ring of rings(cells[id].geometry))
          for (let j = 1; j < ring.length; j++) {
            const c = ring[j - 1],
              d = ring[j],
              edge = axes.map((i) => d[i] - c[i]),
              delta = axes.map((i) => c[i] - a[i]);
            const denom = cross(vector, edge);
            if (Math.abs(denom) < 1e-10) {
              // Collinear cell edges: include their endpoints for unique ownership.
              if (Math.abs(cross(delta, vector)) < 1e-5)
                for (const p of [c, d]) {
                  const t =
                    ((p[0] - a[0]) * vector[0] + (p[1] - a[1]) * vector[1]) /
                    (length * length);
                  if (t > 0 && t < 1) cuts.push(t);
                }
              continue;
            }
            const t = cross(delta, edge) / denom,
              u = cross(delta, vector) / denom;
            if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) cuts.push(t);
          }
      cuts.sort((a, b) => a - b);
      for (let j = 1; j < cuts.length; j++) {
        const dt = cuts[j] - cuts[j - 1];
        if (dt < 1e-10) continue;
        const t = (cuts[j] + cuts[j - 1]) / 2,
          mid = axes.map((i) => a[i] + vector[i] * t);
        const id = ids.find((i) => contains(cells[i].geometry, mid));
        if (id === undefined) continue;
        const km = (length * dt) / 1000;
        cells[id].counts.lineKm += km;
        cells[id].counts.weightedLineKm += km * (weights[line.mode] ?? 1);
      }
    }
  }
  const retained =
    scope === 'network'
      ? cells.filter((c) => c.counts.stops || c.counts.vehicles || c.counts.lineKm > 1e-9)
      : cells;
  const maxima = { stops: 0, vehicles: 0, lines: 0 };
  for (const c of retained) {
    const p = c.feature.properties,
      a = p.areaKm2;
    Object.assign(p, c.counts, {
      stopDensity: c.counts.stops / a,
      vehicleDensity: c.counts.vehicles / a,
      lineDensity: c.counts.lineKm / a,
    });
    for (const [kind, key] of [
      ['stops', 'weightedStops'],
      ['vehicles', 'weightedVehicles'],
      ['lines', 'weightedLineKm'],
    ])
      maxima[kind] = Math.max(maxima[kind], c.counts[key] / a);
  }
  const enabled = Object.keys(maxima).filter((k) => snapshot.enabledKinds[k]);
  for (const c of retained) {
    const p = c.feature.properties;
    p.score = enabled.length
      ? (100 / enabled.length) *
        enabled.reduce((sum, kind) => {
          const key = {
            stops: 'weightedStops',
            vehicles: 'weightedVehicles',
            lines: 'weightedLineKm',
          }[kind];
          return sum + (maxima[kind] ? p[key] / p.areaKm2 / maxima[kind] : 0);
        }, 0)
      : 0;
  }
  return {
    grid: fc(retained.map((c) => c.feature)),
    metadata: {
      scannedLineSegments,
      candidateLineSegments,
      capturedAt: snapshot.capturedAt,
      enabledKinds: snapshot.enabledKinds,
      excludedStaleVehicles: snapshot.excludedStaleVehicles || 0,
      loadedRoutes: snapshot.loadedRoutes,
      totalRoutes: snapshot.totalRoutes,
      origin: GRID_ORIGIN,
      weights,
      cellCount: retained.length,
    },
  };
}
