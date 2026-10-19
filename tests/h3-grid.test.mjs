import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as h3 from '../vendor/h3-js-4.5.0.es.js';
import { generateH3Grid } from '../js/grid-h3.js';
import { analyzeGrid, DEFAULT_WEIGHTS } from '../js/grid-math.js';
const context = {};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(new URL('../vendor/turf-7.4.0.min.js', import.meta.url), 'utf8'),
  context,
);
const turf = context.turf;
const snapshot = {
  stops: [],
  vehicles: [],
  lines: [],
  enabledKinds: { stops: true, vehicles: true, lines: true },
  capturedAt: new Date().toISOString(),
  loadedRoutes: 1,
  totalRoutes: 1,
};
const settings = { type: 'h3', resolution: 8, scope: 'drawn', clip: false };
const mask = turf.bboxPolygon([-71.075, 42.34, -71.045, 42.36]);
const payload = { settings, snapshot, mask };
const grid = generateH3Grid(turf, payload);
assert(grid.features.length > 1);
for (const cell of grid.features) {
  assert(h3.isValidCell(cell.properties.cellId));
  assert.equal(cell.properties.resolution, 8);
  assert.equal(cell.properties.areaKm2, h3.cellArea(cell.properties.cellId, 'km2'));
  const ring = cell.geometry.coordinates[0];
  assert.deepEqual(ring[0], ring.at(-1));
}
const id = h3.latLngToCell(42.35, -71.06, 8);
const [lat, lng] = h3.cellToLatLng(id);
snapshot.stops = [{ id: 'stop', coordinate: [lng, lat], modes: ['subway'] }];
snapshot.vehicles = [{ id: 'vehicle', coordinate: [lng, lat], mode: 'bus' }];
snapshot.lines = [
  {
    routeId: 'route',
    mode: 'bus',
    coordinates: [
      [-71.08, lat],
      [-71.04, lat],
    ],
  },
];
let result = analyzeGrid(turf, grid, snapshot, DEFAULT_WEIGHTS);
assert.equal(
  result.grid.features.reduce((sum, f) => sum + f.properties.stops, 0),
  1,
);
assert.equal(
  result.grid.features.reduce((sum, f) => sum + f.properties.vehicles, 0),
  1,
);
const owner = result.grid.features.find((f) => f.properties.cellId === id);
assert.equal(owner.properties.stops, 1);
assert.equal(owner.properties.vehicleDensity, 1 / owner.properties.areaKm2);
assert(result.grid.features.some((f) => f.properties.lineKm > 0));
console.log(
  'PASS H3 IDs, closed GeoJSON rings, exact whole-cell area, counts and route clipping',
);
const clipped = generateH3Grid(turf, {
  ...payload,
  settings: { ...settings, clip: true },
});
assert(
  clipped.features.some(
    (f) => f.properties.areaKm2 < h3.cellArea(f.properties.cellId, 'km2') * 0.9,
  ),
);
assert(
  Math.abs(
    clipped.features.reduce((sum, f) => sum + f.properties.areaKm2, 0) -
      turf.area(mask) / 1e6,
  ) < 0.0001,
);
console.log('PASS clipped fragments cover the selected area and use fragment areas');
const tiny = turf.bboxPolygon([-71.060001, 42.349999, -71.059999, 42.350001]);
assert(generateH3Grid(turf, { ...payload, mask: tiny }).features.length >= 1);
const networkGrid = generateH3Grid(turf, {
  ...payload,
  settings: { ...settings, scope: 'network' },
});
result = analyzeGrid(turf, networkGrid, snapshot, DEFAULT_WEIGHTS, 'network');
assert(
  result.grid.features.every(
    (f) => f.properties.stops || f.properties.vehicles || f.properties.lineKm,
  ),
);
assert(result.grid.features.some((f) => f.properties.cellId === id));
console.log('PASS tiny masks and occupied visible-network coverage');
const regenerate = generateH3Grid(turf, payload);
assert.deepEqual(
  regenerate.features.map((f) => f.properties.cellId),
  grid.features.map((f) => f.properties.cellId),
);
assert.throws(
  () =>
    generateH3Grid(turf, {
      ...payload,
      mask: turf.bboxPolygon([-71.2, 42.2, -70.9, 42.5]),
      settings: { ...settings, resolution: 11 },
    }),
  /too dense/,
);
assert.throws(
  () => generateH3Grid(turf, { ...payload, settings: { ...settings, resolution: 4 } }),
  /resolution/,
);
assert.throws(
  () => generateH3Grid(turf, { ...payload, mask: turf.bboxPolygon([0, 0, 1, 1]) }),
  /region/,
);
assert.throws(
  () =>
    generateH3Grid(turf, {
      ...payload,
      snapshot: { ...snapshot, stops: [], vehicles: [], lines: [] },
      settings: { ...settings, scope: 'network' },
    }),
  /No visible/,
);
console.log('PASS stable IDs, limits and invalid input');
