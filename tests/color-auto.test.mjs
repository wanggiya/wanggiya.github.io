import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const file = (name) => new URL('../js/' + name, import.meta.url);
const uri = (source) =>
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const { hexToRgb, rgbToHex, makePalette, COLOR_PRESETS } = await import(
  uri(fs.readFileSync(file('grid-colors.js'), 'utf8'))
);
for (const preset of Object.values(COLOR_PRESETS)) {
  const p = makePalette(preset.colors);
  assert.equal(p.length, 7);
  assert.equal(p[0], preset.colors[0]);
  assert.equal(p.at(-1), preset.colors.at(-1));
  if (preset.colors.length === 3) assert.equal(p[3], preset.colors[1]);
}
assert.deepEqual(hexToRgb('#ff0080'), [255, 0, 128]);
assert.equal(rgbToHex([255, 0, 128]), '#ff0080');
assert.throws(() => rgbToHex([256, 0, 0]));
assert.throws(() => rgbToHex([1.5, 0, 0]));
assert.throws(() => makePalette(['#000000']));
assert.throws(() => hexToRgb('bad'));
console.log(
  'PASS RGB validation and exact minimum/middle/maximum color anchors for all presets',
);
let now = 0,
  nextId = 1,
  timers = new Map(),
  calls = 0,
  grid = false,
  paused = false,
  manual = false,
  active = 0,
  maxActive = 0,
  inflight = false,
  aborted = 0;
const context = {
  AbortController,
  DOMException,
  Date: { now: () => now },
  setTimeout: (fn, delay) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + delay });
    return id;
  },
  clearTimeout: (id) => timers.delete(id),
};
vm.createContext(context);
vm.runInContext(
  fs
    .readFileSync(file('grid-auto.js'), 'utf8')
    .replace('export function createAutoAnalysis', 'function createAutoAnalysis'),
  context,
);
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    const list = [...timers.entries()]
      .filter(([, t]) => t.at <= end)
      .sort((a, b) => a[1].at - b[1].at);
    if (!list.length) break;
    const [id, t] = list[0];
    timers.delete(id);
    now = t.at;
    t.fn();
    await flush();
  }
  now = end;
  await flush();
}
const auto = context.createAutoAnalysis({
  canRun: () => grid,
  isPaused: () => paused,
  isWorking: () => manual,
  run: async (signal) => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (inflight)
        await new Promise((resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted++;
              reject(new DOMException('Cancelled', 'AbortError'));
            },
            { once: true },
          ),
        );
    } finally {
      active--;
    }
  },
});
auto.notify();
assert.equal(timers.size, 0);
auto.setEnabled(true);
assert.equal(timers.size, 0);
grid = true;
auto.notify();
await advance(799);
assert.equal(calls, 0);
await advance(1);
assert.equal(calls, 1);
for (let i = 0; i < 500; i++) auto.notify();
await advance(9999);
assert.equal(calls, 1);
await advance(1);
assert.equal(calls, 2);
console.log(
  'PASS opt-in, grid readiness, 800 ms event coalescing and ten-second rate limit',
);
paused = true;
auto.notify();
await advance(20000);
assert.equal(calls, 2);
paused = false;
auto.notify();
await advance(800);
assert.equal(calls, 3);
manual = true;
auto.notify();
await advance(20000);
assert.equal(calls, 3);
manual = false;
auto.manualCompleted();
await advance(9999);
assert.equal(calls, 3);
await advance(1);
assert.equal(calls, 4);
console.log('PASS pause handling and no overlap with manual analysis');
inflight = true;
auto.notify();
await advance(10000);
assert.equal(calls, 5);
for (let i = 0; i < 20; i++) auto.notify();
assert.equal(active, 1);
assert.equal(timers.size, 0);
auto.setEnabled(false);
await flush();
assert.equal(aborted, 1);
assert.equal(active, 0);
await advance(60000);
assert.equal(calls, 5);
assert.equal(maxActive, 1);
auto.destroy();
assert.equal(timers.size, 0);
console.log('PASS one in-flight job, abort on Off, no further work after Off/destroy');
