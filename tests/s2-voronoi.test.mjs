import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { s2 } from '../vendor/s2js-1.44.0.es.js';
import { generateS2Grid } from '../js/grid-s2.js';
import { generateStopVoronoi } from '../js/stop-voronoi.js';
import { analyzeGrid, DEFAULT_WEIGHTS } from '../js/grid-math.js';
import {
  regionalFrame,
  feature,
  collection,
  transformGeometry,
  planarArea,
} from '../js/analysis-geometry.js';
const context = {};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(new URL('../vendor/turf-7.4.0.min.js', import.meta.url), 'utf8'),
  context,
);
const turf = context.turf,
  enu = regionalFrame();
const snapshot = {
  stops: [],
  vehicles: [],
  lines: [],
  enabledKinds: { stops: true, vehicles: true, lines: true },
  capturedAt: new Date().toISOString(),
  loadedRoutes: 1,
  totalRoutes: 1,
};
const settings = { type: 's2', level: 13, scope: 'view', clip: false };
const mask = turf.bboxPolygon([-71.075, 42.34, -71.045, 42.36]);
const grid = generateS2Grid(turf, { settings, snapshot, mask });
assert(grid.features.length > 1);
for (const f of grid.features) {
  const id = s2.cellid.fromToken(f.properties.s2Token);
  assert.equal(s2.cellid.level(id), 13);
  assert.equal(f.properties.s2Token, s2.cellid.toToken(id));
  assert(
    Math.abs(
      f.properties.areaKm2 - (s2.Cell.fromCellID(id).exactArea() * 6371008.8 ** 2) / 1e6,
    ) < 1e-10,
  );
  const ring = f.geometry.coordinates[0];
  assert.equal(ring.length, 33);
  assert.deepEqual(ring[0], ring.at(-1));
}
const target = s2.cellid.parent(
  s2.cellid.fromLatLng(s2.LatLng.fromDegrees(42.35, -71.06)),
  13,
);
const ll = s2.LatLng.fromPoint(s2.Cell.fromCellID(target).center());
const coordinate = [(ll.lng * 180) / Math.PI, (ll.lat * 180) / Math.PI];
snapshot.stops = [{ id: 's', name: 'Stop', coordinate, modes: ['subway'] }];
snapshot.vehicles = [{ id: 'v', coordinate, mode: 'bus' }];
snapshot.lines = [
  {
    routeId: 'r',
    mode: 'bus',
    coordinates: [
      [-71.08, 42.35],
      [-71.04, 42.35],
    ],
  },
];
let result = analyzeGrid(turf, grid, snapshot, DEFAULT_WEIGHTS);
const owner = result.grid.features.find(
  (f) => f.properties.s2Token === s2.cellid.toToken(target),
);
assert.equal(owner.properties.stops, 1);
assert.equal(owner.properties.vehicles, 1);
assert.equal(owner.properties.vehicleDensity, 1 / owner.properties.areaKm2);
assert.equal(
  result.grid.features.reduce((a, f) => a + f.properties.stops, 0),
  1,
);
assert(result.grid.features.some((f) => f.properties.lineKm > 0));
console.log(
  'PASS S2 fixed levels, string token round-trip, spherical areas, points and route analysis',
);
const clipped = generateS2Grid(turf, {
  settings: { ...settings, clip: true },
  snapshot,
  mask,
});
assert(
  Math.abs(
    clipped.features.reduce((a, f) => a + f.properties.areaKm2, 0) -
      turf.area(mask) / 1e6,
  ) < 0.0001,
);
assert(
  clipped.features.some(
    (f) =>
      f.properties.areaKm2 <
      grid.features.find((g) => g.properties.cellId === f.properties.cellId).properties
        .areaKm2 *
        0.9,
  ),
);
assert.deepEqual(
  generateS2Grid(turf, { settings, snapshot, mask }).features.map(
    (f) => f.properties.cellId,
  ),
  grid.features.map((f) => f.properties.cellId),
);
const network = generateS2Grid(turf, {
  settings: { ...settings, scope: 'network' },
  snapshot,
  mask: null,
});
result = analyzeGrid(turf, network, snapshot, DEFAULT_WEIGHTS, 'network');
assert(
  result.grid.features.every(
    (f) => f.properties.stops || f.properties.vehicles || f.properties.lineKm,
  ),
);
assert.throws(
  () => generateS2Grid(turf, { settings: { ...settings, level: 18 }, snapshot, mask }),
  /too dense/,
);
assert.throws(
  () => generateS2Grid(turf, { settings: { ...settings, level: 7 }, snapshot, mask }),
  /level/,
);
assert.throws(
  () =>
    generateS2Grid(turf, { settings, snapshot, mask: turf.bboxPolygon([0, 0, 1, 1]) }),
  /region/,
);
console.log('PASS S2 clipping, stable IDs, network union and safety limits');
const geo = (x, y) => enu.toLonLat([x, y]);
const localMask = feature({
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [2000, 0],
      [2000, 2000],
      [0, 2000],
      [0, 0],
    ],
  ],
});
const geoMask = feature(transformGeometry(localMask.geometry, (p) => enu.toLonLat(p)));
const stop = (id, x, y, stationId = null) => ({
  id,
  name: id,
  stationId,
  coordinate: geo(x, y),
  modes: ['bus'],
});
function vor(stops, mask = geoMask, grouping = 'stops') {
  return generateStopVoronoi(turf, { snapshot: { ...snapshot, stops }, mask, grouping });
}
let regions = vor([stop('west', 500, 1000), stop('east', 1500, 1000)]);
assert.equal(regions.metadata.regionCount, 2);
for (const f of regions.regions.features)
  assert(Math.abs(f.properties.areaKm2 - 2) < 0.001);
const totalArea = (result) =>
  result.regions.features.reduce((a, f) => a + f.properties.areaKm2, 0);
assert(Math.abs(totalArea(regions) - 4) < 0.001);
// An outside site can own the whole selected area; never drop it merely because its point is outside.
regions = vor([stop('far', -10000, 1000), stop('near-outside', 2100, 1000)]);
assert.equal(regions.metadata.regionCount, 1);
assert.deepEqual(regions.regions.features[0].properties.seedIds, ['near-outside']);
assert(Math.abs(totalArea(regions) - 4) < 0.001);
console.log(
  'PASS Voronoi meter-based bisectors, area conservation and outside-area competitors',
);
regions = vor([stop('one', 1000, 1000)]);
assert.equal(regions.metadata.regionCount, 1);
assert(Math.abs(totalArea(regions) - 4) < 0.001);
regions = vor([stop('one', 1000, 1000), stop('two', 1000, 1000)]);
assert.equal(regions.metadata.seedCount, 1);
assert.equal(regions.regions.features[0].properties.stopIds.length, 2);
regions = vor([stop('a', 500, 1000), stop('b', 1000, 1000), stop('c', 1500, 1000)]);
assert.equal(regions.metadata.regionCount, 3);
assert(Math.abs(totalArea(regions) - 4) < 0.001);
regions = vor(
  [
    stop('p1', 500, 500, 'station'),
    stop('p2', 1500, 500, 'station'),
    stop('no-parent', 1000, 1500),
  ],
  geoMask,
  'stations',
);
assert.equal(regions.metadata.seedCount, 2);
assert.equal(regions.metadata.inputStops, 3);
assert.equal(
  regions.regions.features.find((f) => f.properties.seedIds.includes('station'))
    .properties.stopIds.length,
  2,
);
console.log(
  'PASS lone, co-located and collinear sites; parent-station grouping and fallback',
);
const hole = feature({
  type: 'Polygon',
  coordinates: [
    localMask.geometry.coordinates[0],
    [
      [750, 750],
      [750, 1250],
      [1250, 1250],
      [1250, 750],
      [750, 750],
    ],
  ],
});
regions = vor(
  [stop('a', 500, 1000), stop('b', 1500, 1000)],
  feature(transformGeometry(hole.geometry, (p) => enu.toLonLat(p))),
);
assert(Math.abs(totalArea(regions) - 3.75) < 0.001);
assert.throws(() => vor([]), /No visible stops/);
assert.throws(
  () => vor(Array.from({ length: 10001 }, (_, i) => stop(String(i), 1000, 1000))),
  /Too many/,
);
assert.throws(
  () => vor([stop('a', 1000, 1000)], turf.bboxPolygon([0, 0, 1, 1])),
  /region/,
);
console.log('PASS Voronoi holes, empty selection, size limits and regional validation');
