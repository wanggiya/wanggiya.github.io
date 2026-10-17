import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const website = process.argv[2] || root;
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(website, 'vendor/turf-7.4.0.min.js'), 'utf8'),
  ctx,
);
const uri = (s) => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');
const motion = fs.readFileSync(path.join(website, 'js/vehicle-motion.js'), 'utf8');
const { LocalENU } = await import(uri(motion));
let source = fs
  .readFileSync(path.join(root, 'js/grid-math.js'), 'utf8')
  .replace("'./vehicle-motion.js'", JSON.stringify(uri(motion)));
const { generateMetricGrid, analyzeGrid, DEFAULT_WEIGHTS } = await import(uri(source));
const enu = new LocalENU([-71.06, 42.35]);
const geo = (p) => enu.toLonLat(p);
const mask = (x0 = 0, y0 = 0, x1 = 2000, y1 = 2000) => ({
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ].map(geo),
    ],
  },
});
const snapshot = () => ({
  stops: [],
  vehicles: [],
  lines: [],
  enabledKinds: { stops: true, vehicles: true, lines: true },
  capturedAt: '2026-10-16T00:00:00Z',
  loadedRoutes: 2,
  totalRoutes: 2,
});
const settings = (type) => ({
  type,
  distance: 1,
  units: 'kilometers',
  scope: 'drawn',
  clip: false,
});
const gen = (type = 'square', overrides = {}) =>
  generateMetricGrid(ctx.turf, {
    settings: settings(type),
    snapshot: snapshot(),
    mask: mask(),
    ...overrides,
  });
const close = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('PASS', name);
}
test('equal local-meter square edges and known cell areas for all four grids', () => {
  for (const [type, area] of [
    ['square', 1],
    ['hexagon', (3 * Math.sqrt(3)) / 2],
    ['right-triangle', 0.5],
    ['equilateral-triangle', Math.sqrt(3) / 4],
  ]) {
    const grid = gen(type);
    assert.ok(grid.features.length);
    for (const f of grid.features) {
      close(f.properties.areaKm2, area);
      const ring = f.geometry.coordinates[0].map((p) => enu.toLocal(p));
      const lengths = ring
        .slice(1)
        .map((p, i) => Math.hypot(p[0] - ring[i][0], p[1] - ring[i][1]));
      if (type !== 'right-triangle') for (const l of lengths) close(l, 1000, 3e-4);
    }
  }
});
test('hexagons cover positive and negative northings without row gaps', () => {
  for (const y of [-25000, 25000]) {
    const m = mask(0, y, 4000, y + 4000);
    const grid = gen('hexagon', { mask: m });
    assert.ok(grid.features.length > 3);
  }
});
test('clipped edges use actual area and preserve total mask area', () => {
  const grid = gen('square', {
    settings: { ...settings('square'), clip: true },
    mask: mask(100, 100, 1900, 1900),
  });
  close(
    grid.features.reduce((sum, f) => sum + f.properties.areaKm2, 0),
    3.24,
    1e-7,
  );
  assert.equal(grid.features.length, 4);
});
test('unique stops, boundary ownership, shared mode max-weight and density', () => {
  const s = snapshot();
  s.stops = [
    { id: 'shared', coordinate: geo([1000, 1000]), modes: ['bus', 'subway'] },
    { id: 'shared', coordinate: geo([1000, 1000]), modes: ['bus'] },
  ];
  s.vehicles = [{ id: 'v', coordinate: geo([500, 500]), mode: 'silver' }];
  const result = analyzeGrid(ctx.turf, gen(), s, DEFAULT_WEIGHTS);
  assert.equal(
    result.grid.features.reduce((n, f) => n + f.properties.stops, 0),
    1,
  );
  close(
    result.grid.features.reduce((n, f) => n + f.properties.weightedStops, 0),
    3,
  );
  assert.equal(
    result.grid.features.reduce((n, f) => n + f.properties.vehicles, 0),
    1,
  );
  for (const f of result.grid.features) {
    close(f.properties.stopDensity, f.properties.stops / f.properties.areaKm2);
    assert.ok(f.properties.score >= 0 && f.properties.score <= 100 + 1e-7);
  }
});
test('route clipping conserves length and deduplicates reversed exact segments per route', () => {
  const s = snapshot();
  s.lines = [
    { routeId: 'A', mode: 'bus', coordinates: [geo([0, 1000]), geo([2000, 1000])] },
    { routeId: 'A', mode: 'bus', coordinates: [geo([2000, 1000]), geo([0, 1000])] },
  ];
  const r = analyzeGrid(ctx.turf, gen(), s, DEFAULT_WEIGHTS);
  close(
    r.grid.features.reduce((n, f) => n + f.properties.lineKm, 0),
    2,
    1e-6,
  );
  s.lines.push({ ...s.lines[0], routeId: 'B' });
  const rr = analyzeGrid(ctx.turf, gen(), s, DEFAULT_WEIGHTS);
  close(
    rr.grid.features.reduce((n, f) => n + f.properties.lineKm, 0),
    4,
    1e-6,
  );
});
test('network coverage is union of occupied cells with empty gaps removed', () => {
  const s = snapshot();
  s.stops = [{ id: 's', coordinate: geo([500, 500]), modes: ['bus'] }];
  s.vehicles = [{ id: 'v', coordinate: geo([4500, 500]), mode: 'ferry' }];
  const grid = gen('square', {
    settings: { ...settings('square'), scope: 'network' },
    snapshot: s,
    mask: null,
  });
  const result = analyzeGrid(ctx.turf, grid, s, DEFAULT_WEIGHTS, 'network');
  assert.equal(result.grid.features.length, 2);
  assert.equal(
    result.grid.features.reduce(
      (n, f) => n + f.properties.stops + f.properties.vehicles,
      0,
    ),
    2,
  );
});
test('weight changes affect only the score, never raw counts and lengths', () => {
  const s = snapshot();
  s.enabledKinds = { stops: true, vehicles: false, lines: false };
  s.stops = [
    { id: 'b', coordinate: geo([500, 500]), modes: ['bus'] },
    { id: 'r', coordinate: geo([1500, 500]), modes: ['subway'] },
  ];
  const a = analyzeGrid(ctx.turf, gen(), s, DEFAULT_WEIGHTS);
  const b = analyzeGrid(ctx.turf, gen(), s, { ...DEFAULT_WEIGHTS, subway: 1 });
  assert.deepEqual(
    a.grid.features.map((f) => f.properties.stops),
    b.grid.features.map((f) => f.properties.stops),
  );
  assert.notDeepEqual(
    a.grid.features.map((f) => f.properties.score),
    b.grid.features.map((f) => f.properties.score),
  );
});
test('polygon holes exclude points and conserve clipped line length', () => {
  const m = mask();
  m.geometry.coordinates.push(
    [
      [500, 500],
      [500, 1500],
      [1500, 1500],
      [1500, 500],
      [500, 500],
    ].map(geo),
  );
  const grid = gen('square', {
    settings: { ...settings('square'), clip: true },
    mask: m,
  });
  close(
    grid.features.reduce((n, f) => n + f.properties.areaKm2, 0),
    3,
    1e-6,
  );
  const snap = snapshot();
  snap.stops = [{ id: 'hole', coordinate: geo([1000, 1000]), modes: ['bus'] }];
  snap.lines = [
    { routeId: 'A', mode: 'bus', coordinates: [geo([0, 1000]), geo([2000, 1000])] },
  ];
  const result = analyzeGrid(ctx.turf, grid, snap, DEFAULT_WEIGHTS);
  assert.equal(
    result.grid.features.reduce((n, f) => n + f.properties.stops, 0),
    0,
  );
  close(
    result.grid.features.reduce((n, f) => n + f.properties.lineKm, 0),
    1,
    1e-6,
  );
});
test('regional line outside a tiny grid does not allocate an unbounded bin search', () => {
  const snap = snapshot();
  snap.lines = [
    {
      routeId: 'far',
      mode: 'bus',
      coordinates: [geo([-200000, -20000]), geo([200000, 20000])],
    },
  ];
  const result = analyzeGrid(ctx.turf, gen(), snap, DEFAULT_WEIGHTS);
  assert.ok(result.grid.features.every((f) => Number.isFinite(f.properties.lineDensity)));
});
test('over 250000 offscreen segments do not consume the local analysis limit', () => {
  const snap = snapshot();
  const farA = geo([100000, 100000]),
    farB = geo([100001, 100000]);
  snap.lines = [
    {
      routeId: 'outside',
      mode: 'bus',
      coordinates: Array.from({ length: 260005 }, (_, i) => (i % 2 ? farA : farB)),
    },
    {
      routeId: 'crossing',
      mode: 'bus',
      coordinates: [geo([-1000, 500]), geo([3000, 500])],
    },
  ];
  const result = analyzeGrid(ctx.turf, gen(), snap, DEFAULT_WEIGHTS);
  assert.ok(result.metadata.scannedLineSegments > 250000);
  assert.equal(result.metadata.candidateLineSegments, 1);
  close(
    result.grid.features.reduce((n, f) => n + f.properties.lineKm, 0),
    2,
    1e-6,
  );
});
test('over 250000 repeated local pattern segments count once before the work limit', () => {
  const snap = snapshot();
  const a = geo([500, 500]),
    b = geo([1500, 500]);
  snap.lines = [
    {
      routeId: 'repeat',
      mode: 'bus',
      coordinates: Array.from({ length: 260005 }, (_, i) => (i % 2 ? a : b)),
    },
  ];
  const result = analyzeGrid(ctx.turf, gen(), snap, DEFAULT_WEIGHTS);
  assert.ok(result.metadata.scannedLineSegments > 250000);
  assert.equal(result.metadata.candidateLineSegments, 1);
  close(
    result.grid.features.reduce((n, f) => n + f.properties.lineKm, 0),
    1,
    1e-6,
  );
});
test('density limit and regional bounds reject invalid requests', () => {
  assert.throws(() =>
    gen('square', { settings: { ...settings('square'), distance: 0.001 } }),
  );
  assert.throws(() =>
    gen('square', { settings: { ...settings('square'), distance: 0 } }),
  );
  assert.throws(() =>
    gen('square', {
      mask: {
        ...mask(),
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-120, 40],
              [-119, 40],
              [-119, 41],
              [-120, 40],
            ],
          ],
        },
      },
    }),
  );
});
console.log(`${passed} suites passed`);
