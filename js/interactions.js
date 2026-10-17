import { interactionContext } from './mbta.js';
import { createGridTool, METRICS } from './grid-tools.js';
import { DEFAULT_WEIGHTS } from './grid-math.js';
import { COLOR_PRESETS, colorEditor, bindColorEditor } from './grid-colors.js';
import { createAutoAnalysis } from './grid-auto.js';

// Keep additional personal interaction tools here; the grid owns its own layers.
const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = new URL('../css/grid-tools.css', import.meta.url).href;
document.head.append(css);
const tool = createGridTool(
  interactionContext.map,
  interactionContext.getVisibleNetworkSnapshot,
);
const $ = (id) => document.getElementById(id);
const modes = {
  bus: 'Bus',
  silver: 'Silver Line',
  lightRail: 'Light rail',
  subway: 'Subway',
  commuter: 'Commuter rail',
  ferry: 'Ferry',
};
document.body.insertAdjacentHTML(
  'beforeend',
  `
<aside id="interaction-panel" class="interaction-panel" hidden aria-label="Map interactions">
 <div class="interaction-heading"><strong>Interactions</strong><button id="close-interactions" type="button" aria-label="Close interactions">×</button></div>
 <div class="interaction-tools"><button id="open-grid-settings" type="button" aria-expanded="false">Draw grid / choose area</button><button id="open-heat-settings" type="button" aria-expanded="false">Cell heatmap / analysis</button><!-- Add future tool buttons here. --></div>
 <form id="grid-settings" class="grid-settings" hidden>
  <label>Grid type<select id="grid-type"><option value="square">Equal-meter square</option><option value="hexagon">Hexagon</option><option value="right-triangle">Right triangle</option><option value="equilateral-triangle">Equilateral triangle</option></select></label>
  <label>Cell side / triangle leg<input id="grid-distance" type="number" min="0.01" step="any" value="2" required></label>
  <label>Units<select id="grid-units"><option value="kilometers">Kilometers</option><option value="miles">Miles</option></select></label>
  <label>Coverage<select id="grid-scope"><option value="view">Current map view</option><option value="drawn">Drawn rectangle / polygon</option><option value="network">Visible lines, stops or vehicles (union)</option></select></label>
  <div class="interaction-actions"><button id="select-rectangle" type="button">Drag rectangle</button><button id="select-polygon" type="button">Draw polygon</button></div>
  <button id="cancel-area" type="button" hidden>Cancel drawing (Esc)</button>
  <p id="area-message" class="grid-note">Drag a rectangle, or click polygon corners and double-click to finish.</p>
  <label class="grid-inline"><input id="clip-grid" type="checkbox">Clip cells at the view/drawn boundary</label>
  <p class="grid-note">Whole cells keep equal dimensions. Clipped edge cells change shape and use their actual area.</p>
  <details><summary>Grid line appearance</summary>
   ${colorEditor('grid-line-color', 'Grid line color', document.body.classList.contains('dark') ? '#5ad7c5' : '#007c78')}
   <label for="grid-line-width">Line thickness (pixels)</label>
   <div class="grid-paired-control"><input id="grid-line-width" type="range" min="0" max="8" step="0.1" value="1" aria-label="Grid line thickness slider"><input id="grid-line-width-number" type="number" min="0" max="8" step="0.1" value="1" aria-label="Grid line thickness number"></div>
  </details>
  <div class="interaction-actions"><button id="draw-grid" type="submit">Draw grid</button><button id="clear-grid" type="button">Clear grid</button></div>
  <p id="grid-message" class="grid-note" role="status" aria-live="polite"></p>
 </form>
 <section id="heat-settings" class="grid-settings" hidden aria-label="Grid heatmap">
  <div class="grid-switch-row"><span id="heat-toggle-label">Show heatmap</span><label class="grid-slide"><input id="heat-enabled" type="checkbox" role="switch" aria-labelledby="heat-toggle-label" checked><span class="grid-slide-track" aria-hidden="true"></span></label><span id="heat-switch-state" class="grid-switch-status">On</span></div>
  <div class="grid-switch-row"><span id="auto-toggle-label">Auto-update vehicles</span><label class="grid-slide"><input id="auto-vehicles" type="checkbox" role="switch" aria-labelledby="auto-toggle-label"><span class="grid-slide-track" aria-hidden="true"></span></label><span id="auto-switch-state" class="grid-switch-status">Off</span></div>
  <p id="auto-status" class="grid-note" role="status">Off · use Recalculate for a manual snapshot.</p>
  <p id="heat-state" class="grid-note" role="status"></p>
  <label>Color represents<select id="heat-metric">${Object.entries(METRICS)
    .map(([id, name]) => `<option value="${id}">${name}</option>`)
    .join('')}</select></label>
  <label>Color scale<select id="heat-scale"><option value="linear">Linear</option><option value="log">Logarithmic (log1p)</option></select></label>
  <label>Opacity<input id="heat-opacity" type="range" min="0.2" max="0.9" step="0.05" value="0.65"></label>
  <details><summary>Heatmap color ramp</summary>
   <label>Color set<select id="heat-preset">${Object.entries(COLOR_PRESETS)
     .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
     .join('')}<option value="custom">Custom</option></select></label>
   <label>Color stops<select id="heat-color-stops"><option value="2">Two: minimum / maximum</option><option value="3" selected>Three: minimum / middle / maximum</option></select></label>
   ${colorEditor('heat-min-color', 'Minimum', '#ffffcc')}
   ${colorEditor('heat-mid-color', 'Middle', '#fd8d3c')}
   ${colorEditor('heat-max-color', 'Maximum', '#bd0026')}
   <div id="heat-ramp-preview" class="grid-ramp-preview" aria-label="Heatmap color ramp preview"></div>
   <p class="grid-note">RGB channels use 0–255. Color wells open the browser color picker. Middle represents the midpoint of the selected linear/log color scale.</p>
  </details>
  <button id="recalculate-grid" type="button">Recalculate from visible layers</button>
  <p class="grid-note">Uses a snapshot of currently shown data. Recalculate after changing layers or to refresh vehicles.</p>
  <details><summary>Score weights (editable)</summary><p class="grid-note">Illustrative mode priorities, not vehicle capacities. Raw density measures ignore these weights. Recalculate applies edits now; auto mode uses current weights too.</p>
   <table class="grid-weights"><thead><tr><th>Mode</th><th>Weight</th></tr></thead><tbody>${Object.entries(
     modes,
   )
     .map(
       ([id, name]) =>
         `<tr><td>${name}</td><td><input data-weight="${id}" aria-label="${name} weight" type="number" min="0" max="20" step="0.25" value="${DEFAULT_WEIGHTS[id]}"></td></tr>`,
     )
     .join('')}</tbody></table>
   <div class="interaction-actions"><button id="equal-weights" type="button">All equal</button><button id="default-weights" type="button">Defaults</button></div>
   <p class="grid-note">Score averages the enabled weighted density components after each is divided by its grid-wide maximum. Scores are relative to this snapshot.</p>
  </details>
  <div id="heat-legend" class="grid-note"></div><p id="analysis-message" class="grid-note" role="status"></p>
  <div id="grid-cell-info" class="grid-note">Click a grid cell to inspect its calculated values.</div>
 </section>
</aside>`,
);
const panel = $('interaction-panel'),
  button = $('interactions-toggle');
button.setAttribute('aria-controls', panel.id);
button.setAttribute('aria-expanded', 'false');
function openPanel(open) {
  panel.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (!open) tool.cancelSelection();
}
button.onclick = () => openPanel(panel.hidden);
$('close-interactions').onclick = () => {
  openPanel(false);
  button.focus();
};
for (const [buttonId, panelId] of [
  ['open-grid-settings', 'grid-settings'],
  ['open-heat-settings', 'heat-settings'],
])
  $(buttonId).onclick = () => {
    const open = $(panelId).hidden;
    if (open) {
      const otherPanel = panelId === 'grid-settings' ? 'heat-settings' : 'grid-settings';
      const otherButton =
        panelId === 'grid-settings' ? 'open-heat-settings' : 'open-grid-settings';
      $(otherPanel).hidden = true;
      $(otherButton).setAttribute('aria-expanded', 'false');
      if (panelId === 'heat-settings') tool.cancelSelection();
    }
    $(panelId).hidden = !open;
    $(buttonId).setAttribute('aria-expanded', String(open));
  };
panel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    openPanel(false);
    button.focus();
  }
});
$('select-rectangle').onclick = () => {
  $('grid-scope').value = 'drawn';
  tool.beginSelection('rectangle');
};
$('select-polygon').onclick = () => {
  $('grid-scope').value = 'drawn';
  tool.beginSelection('polygon');
};
$('cancel-area').onclick = () => tool.cancelSelection();
$('grid-scope').onchange = () => {
  tool.cancelSelection();
};
function weights() {
  return Object.fromEntries(
    [...panel.querySelectorAll('[data-weight]')].map((input) => [
      input.dataset.weight,
      input.valueAsNumber,
    ]),
  );
}
function settings() {
  return {
    type: $('grid-type').value,
    distance: $('grid-distance').valueAsNumber,
    units: $('grid-units').value,
    scope: $('grid-scope').value,
    clip: $('clip-grid').checked,
  };
}
async function execute(action) {
  $('grid-message').textContent = 'Calculating…';
  try {
    await action();
    autoAnalysis.manualCompleted();
    $('grid-cell-info').textContent = 'Click a grid cell for updated values.';
  } catch (error) {
    if (error.name !== 'AbortError') $('grid-message').textContent = error.message;
  }
}
$('grid-settings').onsubmit = (e) => {
  e.preventDefault();
  execute(() => tool.draw(settings(), weights()));
};
$('recalculate-grid').onclick = () => execute(() => tool.recalculate(weights()));
$('clear-grid').onclick = () => {
  tool.clear();
  $('grid-message').textContent = 'Grid and drawn area cleared.';
  $('analysis-message').textContent = '';
  $('grid-cell-info').textContent = 'Draw a grid to analyze it.';
  autoAnalysis.notify();
};
const lineEditor = bindColorEditor($('grid-line-color'), (color) =>
  tool.setGridStyle({ lineColor: color }),
);
function lineWidth(value) {
  const valid = Number.isFinite(value) && value >= 0 && value <= 8;
  $('grid-line-width-number').setCustomValidity(
    valid ? '' : 'Choose a thickness from 0 to 8 pixels.',
  );
  if (!valid) return;
  const width = Math.round(value * 10) / 10;
  $('grid-line-width').value = width;
  $('grid-line-width-number').value = width;
  tool.setGridStyle({ lineWidth: width });
}
$('grid-line-width').oninput = (e) => lineWidth(e.target.valueAsNumber);
$('grid-line-width-number').oninput = (e) => lineWidth(e.target.valueAsNumber);
function customColor() {
  $('heat-preset').value = 'custom';
  heat();
}
const colorEditors = {
  min: bindColorEditor($('heat-min-color'), customColor),
  mid: bindColorEditor($('heat-mid-color'), customColor),
  max: bindColorEditor($('heat-max-color'), customColor),
};
function rampColors() {
  return $('heat-color-stops').value === '3'
    ? [colorEditors.min.get(), colorEditors.mid.get(), colorEditors.max.get()]
    : [colorEditors.min.get(), colorEditors.max.get()];
}
$('heat-preset').onchange = () => {
  const preset = COLOR_PRESETS[$('heat-preset').value];
  if (!preset) return;
  $('heat-color-stops').value = String(preset.colors.length);
  colorEditors.min.set(preset.colors[0]);
  colorEditors.max.set(preset.colors.at(-1));
  if (preset.colors.length === 3) colorEditors.mid.set(preset.colors[1]);
  heat();
};
$('heat-color-stops').onchange = () => {
  $('heat-preset').value = 'custom';
  heat();
};
const autoAnalysis = createAutoAnalysis({
  canRun: () => Boolean(tool.getMetadata()),
  isWorking: () => tool.isBusy(),
  isPaused: () => document.hidden || $('pause').getAttribute('aria-checked') === 'false',
  run: (signal) => tool.recalculate(weights(), { signal }),
  onStatus: (message) => ($('auto-status').textContent = message),
});
$('auto-vehicles').onchange = () => {
  const enabled = $('auto-vehicles').checked;
  $('auto-switch-state').textContent = enabled ? 'On' : 'Off';
  autoAnalysis.setEnabled(enabled);
};
// Vehicle source geometry changes at GPS ingestion, not on animation frames.
// Coalesce its many feature events into one snapshot job; never fetch here.
interactionContext.vehicleSource.on('change', () => autoAnalysis.notify());
$('modes').addEventListener('change', () => autoAnalysis.notify());
for (const id of ['lines', 'stops', 'vehicles'])
  $(id).addEventListener('change', () => autoAnalysis.notify());
$('pause').addEventListener('click', () => autoAnalysis.notify());
document.addEventListener('visibilitychange', () => autoAnalysis.notify());

function heat() {
  const enabled = $('heat-enabled').checked;
  $('heat-switch-state').textContent = enabled ? 'On' : 'Off';
  $('heat-mid-color').hidden = $('heat-color-stops').value !== '3';
  const colors = rampColors();
  $('heat-ramp-preview').style.background =
    `linear-gradient(to right,${colors.join(',')})`;
  for (const id of ['heat-metric', 'heat-scale', 'heat-opacity'])
    $(id).disabled = !enabled;
  $('heat-state').textContent = enabled
    ? `Showing ${METRICS[$('heat-metric').value]}. Zero-value cells are transparent.`
    : 'Heatmap hidden. Grid outlines and calculated values remain available.';

  tool.setHeat({
    colors,
    enabled: $('heat-enabled').checked,
    metric: $('heat-metric').value,
    scale: $('heat-scale').value,
    opacity: Number($('heat-opacity').value),
  });
}
for (const id of ['heat-enabled', 'heat-metric', 'heat-scale', 'heat-opacity'])
  $(id).addEventListener(id === 'heat-opacity' ? 'input' : 'change', heat);
$('equal-weights').onclick = () => {
  panel.querySelectorAll('[data-weight]').forEach((input) => (input.value = 1));
};
$('default-weights').onclick = () => {
  panel
    .querySelectorAll('[data-weight]')
    .forEach((input) => (input.value = DEFAULT_WEIGHTS[input.dataset.weight]));
};
tool.events.addEventListener('busy', ({ detail }) => {
  $('draw-grid').disabled = detail;
  $('recalculate-grid').disabled = detail;
});
tool.events.addEventListener('drawing', ({ detail }) => {
  $('cancel-area').hidden = !detail;
  if (detail)
    $('area-message').textContent =
      detail === 'rectangle'
        ? 'Drag on the map with the left mouse button.'
        : 'Click map corners, then double-click the last corner. Esc cancels.';
});
tool.events.addEventListener('selection', () => {
  $('area-message').textContent = 'Area selected. Click Draw grid.';
});
tool.events.addEventListener('result', ({ detail: m }) => {
  const kinds =
    Object.keys(m.enabledKinds)
      .filter((k) => m.enabledKinds[k])
      .join(', ') || 'none';
  $('grid-message').textContent =
    `${m.cellCount.toLocaleString()} cells · local-meter grid.`;
  $('analysis-message').textContent =
    `Snapshot ${new Date(m.capturedAt).toLocaleTimeString()} · layers: ${kinds}. ${m.excludedStaleVehicles} stale vehicles excluded. ${m.loadedRoutes}/${m.totalRoutes} routes loaded.`;
});
function format(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
}
tool.events.addEventListener('legend', ({ detail: d }) => {
  const element = $('heat-legend');
  element.replaceChildren();
  if (!d.enabled) {
    element.textContent = 'Heatmap hidden.';
    return;
  }
  const title = document.createElement('strong');
  title.textContent = d.label;
  element.append(title);
  if (!d.maximum) {
    const p = document.createElement('p');
    p.textContent = 'All values are zero (or no grid yet).';
    element.append(p);
    return;
  }
  const steps = d.palette.length;
  for (let i = 0; i < steps; i++) {
    const invert = (x) =>
      d.scale === 'log' ? Math.expm1(Math.log1p(d.maximum) * x) : d.maximum * x;
    const row = document.createElement('div'),
      swatch = document.createElement('span');
    swatch.className = 'grid-swatch';
    swatch.style.background = d.palette[i];
    row.append(
      swatch,
      document.createTextNode(
        `${format(invert(i / steps))} – ${format(invert((i + 1) / steps))}`,
      ),
    );
    element.append(row);
  }
  const zero = document.createElement('p');
  zero.textContent = 'Zero-value cells are transparent.';
  element.append(zero);
});
tool.events.addEventListener('cell', ({ detail: p }) => {
  $('grid-cell-info').textContent =
    `Cell ${p.cellId} · ${format(p.areaKm2)} km² | Stops: ${p.stops} (${format(p.stopDensity)}/km²) | Vehicles: ${p.vehicles} (${format(p.vehicleDensity)}/km²) | Route geometry: ${format(p.lineKm)} km (${format(p.lineDensity)} km/km²) | Relative score: ${format(p.score)}/100.`;
});
heat();
