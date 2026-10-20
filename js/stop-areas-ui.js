import { colorEditor, bindColorEditor, rgba } from './grid-colors.js';

/** Independent Voronoi overlay. It never changes grid analysis or vehicle rendering. */
export function createStopAreasUI({ context, selectionTool, panel }) {
  panel
    .querySelector('.interaction-tools')
    .insertAdjacentHTML(
      'beforeend',
      '<button id="open-stop-areas" type="button" aria-expanded="false">Nearest-stop areas</button>',
    );
  panel.insertAdjacentHTML(
    'beforeend',
    `
    <section id="stop-areas-settings" class="grid-settings" hidden aria-label="Nearest-stop areas">
      <strong>Thiessen / Voronoi polygons</strong>
      <p class="grid-note">Each region is closest to one selected stop or station representative by straight-line distance in local meters. These are not walking-time or transit service boundaries.</p>
      <label>Sites<select id="voronoi-grouping"><option value="stations">Group by MBTA parent station</option><option value="stops">Individual stops</option></select></label>
      <p class="grid-note">Station representatives are the mean of their shown stops. Missing parent IDs remain individual stops. Co-located sites share one region. Stops outside the area still participate.</p>
      <label>Coverage<select id="voronoi-scope"><option value="view">Current map view</option><option value="drawn">Drawn rectangle / polygon</option></select></label>
      <div class="interaction-actions"><button id="voronoi-rectangle" type="button">Drag rectangle</button><button id="voronoi-polygon" type="button">Draw polygon</button></div>
      <button id="voronoi-cancel" type="button" hidden>Cancel drawing (Esc)</button>
      <p id="voronoi-area-status" class="grid-note">Uses the same drawn selection as the grid tools. Changing that selection does not redraw existing results.</p>
      <div class="grid-switch-row"><span id="voronoi-toggle-label">Show stop areas</span><label class="grid-slide"><input id="voronoi-visible" type="checkbox" role="switch" aria-labelledby="voronoi-toggle-label" checked><span class="grid-slide-track" aria-hidden="true"></span></label><span id="voronoi-switch-state" class="grid-switch-status">On</span></div>
      <details><summary>Stop-area appearance</summary>
        ${colorEditor('voronoi-color', 'Area color', '#8056d9')}
        <label>Fill opacity<input id="voronoi-opacity" type="range" min="0" max="0.6" step="0.05" value="0.15"></label>
      </details>
      <div class="interaction-actions"><button id="voronoi-draw" type="button">Calculate stop areas</button><button id="voronoi-clear" type="button">Clear stop areas</button></div>
      <p id="voronoi-status" class="grid-note" role="status" aria-live="polite">Uses currently visible stops from selected routes. Recalculate after changing routes or stops.</p>
      <p id="voronoi-cell-info" class="grid-note">Click a region to inspect its stop/station and area.</p>
    </section>`,
  );
  const $ = (id) => document.getElementById(id);
  const source = new ol.source.Vector();
  const layer = new ol.layer.Vector({ source, zIndex: 1.6 });
  layer.set('name', 'interaction-stop-areas');
  const format = new ol.format.GeoJSON();
  let color = '#8056d9',
    worker = null,
    rejectPending = null,
    generation = 0;
  function restyle() {
    layer.setStyle(
      new ol.style.Style({
        stroke: new ol.style.Stroke({ color, width: 1.3 }),
        fill: new ol.style.Fill({
          color: rgba(color, Number($('voronoi-opacity').value)),
        }),
      }),
    );
  }
  bindColorEditor($('voronoi-color'), (value) => {
    color = value;
    restyle();
  });
  $('voronoi-opacity').oninput = restyle;
  restyle();
  $('voronoi-visible').onchange = () => {
    layer.setVisible($('voronoi-visible').checked);
    $('voronoi-switch-state').textContent = layer.getVisible() ? 'On' : 'Off';
  };
  function cancel() {
    worker?.terminate();
    worker = null;
    rejectPending?.(new DOMException('Cancelled.', 'AbortError'));
    rejectPending = null;
  }
  for (const kind of ['rectangle', 'polygon'])
    $(`voronoi-${kind}`).onclick = () => {
      $('voronoi-scope').value = 'drawn';
      selectionTool.beginSelection(kind);
    };
  $('voronoi-cancel').onclick = () => selectionTool.cancelSelection();
  selectionTool.events.addEventListener('drawing', ({ detail }) => {
    $('voronoi-cancel').hidden = !detail;
    if (detail)
      $('voronoi-area-status').textContent =
        detail === 'rectangle'
          ? 'Drag on the map with the left mouse button. Esc cancels.'
          : 'Click polygon corners; double-click to finish. Esc cancels.';
  });
  selectionTool.events.addEventListener('selection', () => {
    $('voronoi-area-status').textContent = 'Area selected. Click Calculate stop areas.';
  });
  selectionTool.events.addEventListener('clear', () => {
    $('voronoi-area-status').textContent =
      'The shared drawn selection was cleared. Draw a new area or choose Current map view.';
  });
  $('voronoi-clear').onclick = () => {
    generation++;
    cancel();
    source.clear();
    context.map.removeLayer(layer);
    $('voronoi-draw').disabled = false;
    $('voronoi-status').textContent = 'Stop areas cleared.';
    $('voronoi-cell-info').textContent = 'Calculate stop areas to inspect them.';
  };
  $('voronoi-draw').onclick = async () => {
    cancel();
    const id = ++generation;
    $('voronoi-draw').disabled = true;
    $('voronoi-status').textContent = 'Calculating nearest-stop areas…';
    try {
      const mask = selectionTool.getArea($('voronoi-scope').value);
      const snapshot = context.getVisibleNetworkSnapshot();
      const result = await new Promise((resolve, reject) => {
        const current = new Worker(new URL('./grid-worker.js', import.meta.url), {
          type: 'module',
        });
        worker = current;
        rejectPending = reject;
        const finish = () => {
          current.terminate();
          if (worker === current) {
            worker = null;
            rejectPending = null;
          }
        };
        current.onmessage = ({ data }) => {
          finish();
          data.error ? reject(Error(data.error)) : resolve(data);
        };
        current.onerror = (event) => {
          event.preventDefault();
          finish();
          reject(
            Error(
              'Stop-area worker could not load. Check the JS files and local Turf bundle.',
            ),
          );
        };
        current.postMessage({
          operation: 'voronoi',
          mask,
          snapshot,
          grouping: $('voronoi-grouping').value,
        });
      });
      if (id !== generation) return;
      source.clear();
      source.addFeatures(
        format.readFeatures(result.regions, {
          dataProjection: 'EPSG:4326',
          featureProjection: context.map.getView().getProjection(),
        }),
      );
      if (!context.map.getLayers().getArray().includes(layer))
        context.map.addLayer(layer);
      const m = result.metadata;
      $('voronoi-status').textContent =
        `${m.regionCount} regions · ${m.seedCount} sites from ${m.inputStops} shown stops · snapshot ${new Date(m.capturedAt).toLocaleTimeString()} · ${snapshot.loadedRoutes}/${snapshot.totalRoutes} routes loaded.`;
      $('voronoi-cell-info').textContent =
        'Click a region to inspect its stop/station and area.';
    } catch (error) {
      if (id === generation && error.name !== 'AbortError')
        $('voronoi-status').textContent = error.message;
    } finally {
      if (id === generation) $('voronoi-draw').disabled = false;
    }
  };
  context.map.on('singleclick', (event) => {
    if (!layer.getVisible() || !$('voronoi-cancel').hidden) return;
    const region = source.getFeaturesAtCoordinate(event.coordinate)[0];
    if (!region) return;
    const p = region.getProperties();
    $('voronoi-cell-info').textContent =
      `${p.name} · ${p.areaKm2.toLocaleString(undefined, { maximumFractionDigits: 3 })} km² · ${p.stopIds.length} stop(s) · site IDs: ${p.seedIds.join(', ')}. Nearest by straight-line distance to ${p.groupedByParent ? 'the representative of shown station stops' : 'the stop site'}.`;
  });
}
