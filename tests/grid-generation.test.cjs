const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
// Run from the extracted update after copying vendor/ from the website, or pass
// the existing website path: node tests/grid-generation.test.cjs /path/to/site
const website = process.argv[2] || path.resolve(__dirname, '..');
const context = { console };
context.self = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(website, 'vendor/turf-7.4.0.min.js'), 'utf8'), context);
let source = fs.readFileSync(path.join(__dirname, '../js/grid-worker.js'), 'utf8');
source = source.replace(/^import .*;$/m, '').replace(/export /g, '');
vm.runInContext(source, context);
const bbox = [-71.1, 42.3, -71, 42.4];
const run = (type, distance = 1, units = 'kilometers', bounds = bbox) => context.generateGrid(context.turf, bounds, { type, distance, units });
const counts = {};
for (const [type, vertices] of [['square', 5], ['hexagon', 7], ['right-triangle', 4], ['equilateral-triangle', 4]]) {
  const grid = run(type);
  assert.ok(grid.features.length > 0);
  for (const cell of grid.features) {
    const ring = cell.geometry.coordinates[0];
    assert.equal(ring.length, vertices);
    assert.deepEqual(ring[0], ring.at(-1));
    assert.equal(cell.properties.gridType, type);
    assert.ok(context.turf.area(cell) > 0);
  }
  counts[type] = grid.features.length;
}
assert.equal(counts['equilateral-triangle'], counts.hexagon * 6);
const eq = run('equilateral-triangle').features[0].geometry.coordinates[0];
const lengths = [0, 1, 2].map(i => context.turf.distance(eq[i], eq[i + 1], {units:'kilometers'}));
assert.ok(Math.max(...lengths) / Math.min(...lengths) < 1.002, 'Hexagon triangles must be approximately equilateral in local ground distances');
const right = run('right-triangle').features[0].geometry.coordinates[0];
const angles = [0, 1, 2].map(i => {
  const a = right[i], b = right[(i + 1) % 3], c = right[(i + 2) % 3];
  return Math.abs((b[0]-a[0])*(c[0]-a[0])+(b[1]-a[1])*(c[1]-a[1]));
});
assert.ok(Math.min(...angles) < 1e-12);
for (const type of Object.keys(counts)) assert.equal(run(type, 1 / 1.609344, 'miles').features.length, counts[type]);
for (const distance of [0, -1, NaN, Infinity, 0.00001]) assert.throws(() => run('square', distance));
assert.throws(() => run('unknown'));
assert.throws(() => run('square', 1, 'feet'));
assert.throws(() => run('square', 1, 'kilometers', [170, 20, -170, 30]));
console.log('PASS all four geometries, hex/triangle equivalence, approximate equilateral lengths, right angle, units and input/density guards', counts);
