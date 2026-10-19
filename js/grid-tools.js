import { makePalette, rgba, hexToRgb } from './grid-colors.js';
/** Independent metric grid, drawn-area selection, snapshot analysis and shading. */
export const METRICS = {
  stopDensity: 'Stops / km²',
  vehicleDensity: 'Vehicles / km²',
  lineDensity: 'Route-km / km²',
  score: 'Relative weighted score (0–100)',
};

export function createGridTool(map, getSnapshot) {
  const source = new ol.source.Vector(),
    areaSource = new ol.source.Vector();
  const layer = new ol.layer.Vector({ source, zIndex: 1.5 });
  layer.set('name', 'interaction-grid');
  const areaLayer = new ol.layer.Vector({ source: areaSource, zIndex: 2 });
  areaLayer.set('name', 'interaction-area');
  const format = new ol.format.GeoJSON();
  let worker = null,
    rejectPending = null,
    requestId = 0,
    selection = null,
    selectionInteraction = null;
  let storedGrid = null,
    storedSettings = null,
    metadata = null;
  let heat = {
    enabled: true,
    metric: 'stopDensity',
    scale: 'linear',
    opacity: 0.65,
    colors: ['#ffffcc', '#fd8d3c', '#bd0026'],
  };
  let palette = makePalette(heat.colors);
  let gridStyle = {
    lineColor: document.body.classList.contains('dark') ? '#5ad7c5' : '#007c78',
    lineWidth: 1,
  };
  let maximum = 0,
    styles = new Map();
  const events = new EventTarget();
  function emit(type, detail) {
    events.dispatchEvent(new CustomEvent(type, { detail }));
  }
  function styleGrid(f) {
    const dark = document.body.classList.contains('dark');
    const value = Number(f.get(heat.metric)) || 0;
    const scaled = heat.scale === 'log' ? Math.log1p(value) : value;
    const max = heat.scale === 'log' ? Math.log1p(maximum) : maximum;
    const bin =
      value > 0 && max > 0
        ? Math.min(palette.length - 1, Math.floor((scaled / max) * palette.length))
        : -1;
    const key = `${dark}|${heat.enabled}|${bin}`;
    if (!styles.has(key))
      styles.set(
        key,
        new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: gridStyle.lineColor,
            width: gridStyle.lineWidth,
          }),
          fill: new ol.style.Fill({
            color: heat.enabled
              ? bin < 0
                ? 'rgba(0,0,0,0)'
                : rgba(palette[bin], heat.opacity)
              : dark
                ? 'rgba(90,215,197,0.025)'
                : 'rgba(0,124,120,0.02)',
          }),
        }),
      );
    return styles.get(key);
  }
  layer.setStyle(styleGrid);
  function refreshStyle() {
    styles.clear();
    maximum = source
      .getFeatures()
      .reduce((m, f) => Math.max(m, Number(f.get(heat.metric)) || 0), 0);
    layer.setOpacity(1);
    layer.changed();
    areaLayer.setStyle(
      new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: document.body.classList.contains('dark') ? '#f9cc6c' : '#8c4b00',
          width: 2,
          lineDash: [7, 5],
        }),
      }),
    );
    emit('legend', { ...heat, maximum, palette, label: METRICS[heat.metric] });
  }
  const observer = new MutationObserver(refreshStyle);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  refreshStyle();
  function cancelPending() {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    worker = null;
    if (rejectPending) rejectPending(new DOMException('Cancelled.', 'AbortError'));
    rejectPending = null;
  }
  function cancelSelection() {
    if (selectionInteraction) map.removeInteraction(selectionInteraction);
    selectionInteraction = null;
    emit('drawing', false);
  }
  function setSelection(geometry) {
    selection = format.writeFeatureObject(new ol.Feature(geometry), {
      featureProjection: map.getView().getProjection(),
      dataProjection: 'EPSG:4326',
    });
    areaSource.clear();
    areaSource.addFeature(new ol.Feature(geometry.clone()));
    if (!map.getLayers().getArray().includes(areaLayer)) map.addLayer(areaLayer);
    emit('selection', selection);
    setTimeout(cancelSelection, 0);
  }
  function beginSelection(kind) {
    cancelSelection();
    if (kind === 'rectangle') {
      selectionInteraction = new ol.interaction.DragBox({
        condition: (e) => e.originalEvent.button === 0,
      });
      selectionInteraction.on('boxend', () =>
        setSelection(selectionInteraction.getGeometry().clone()),
      );
    } else {
      selectionInteraction = new ol.interaction.Draw({ type: 'Polygon' });
      selectionInteraction.on('drawend', (e) =>
        setSelection(e.feature.getGeometry().clone()),
      );
    }
    map.addInteraction(selectionInteraction);
    emit('drawing', kind);
  }
  function escape(e) {
    if (e.key === 'Escape') cancelSelection();
  }
  document.addEventListener('keydown', escape);
  function viewMask() {
    const e = map.getView().calculateExtent(map.getSize());
    return format.writeFeatureObject(new ol.Feature(ol.geom.Polygon.fromExtent(e)), {
      featureProjection: map.getView().getProjection(),
      dataProjection: 'EPSG:4326',
    });
  }
  async function run(operation, settings, weights, { signal } = {}) {
    if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
    cancelPending();
    const id = ++requestId;
    if (operation === 'analyze' && !storedGrid) throw Error('Draw a grid first.');
    const mask =
      settings.scope === 'drawn'
        ? selection
        : settings.scope === 'network'
          ? null
          : viewMask();
    if (settings.scope === 'drawn' && !mask)
      throw Error('Draw a rectangle or polygon first.');
    const snapshot = getSnapshot();
    const abort = () => {
      if (id === requestId) cancelPending();
    };
    signal?.addEventListener('abort', abort, { once: true });
    emit('busy', true);
    try {
      const result = await new Promise((resolve, reject) => {
        rejectPending = reject;
        const current = new Worker(new URL('./grid-worker.js', import.meta.url), {
          type: 'module',
        });
        worker = current;
        function finish() {
          current.terminate();
          if (worker === current) {
            worker = null;
            rejectPending = null;
          }
        }
        current.onmessage = ({ data }) => {
          finish();
          data.error ? reject(Error(data.error)) : resolve(data);
        };
        current.onerror = (e) => {
          e.preventDefault();
          finish();
          reject(
            Error(
              'Grid worker could not load. Check the copied JS files and local Turf/H3 bundles.',
            ),
          );
        };
        current.postMessage({
          operation,
          settings,
          weights,
          mask,
          snapshot,
          grid: operation === 'analyze' ? storedGrid : null,
        });
      });
      if (id !== requestId) throw new DOMException('Cancelled.', 'AbortError');
      if (!result.grid.features.length)
        throw Error(
          'No cells contain the selected data/area. Try a larger area or enable more layers.',
        );
      storedGrid = result.grid;
      storedSettings = { ...settings };
      metadata = result.metadata;
      source.clear();
      source.addFeatures(
        format.readFeatures(storedGrid, {
          dataProjection: 'EPSG:4326',
          featureProjection: map.getView().getProjection(),
        }),
      );
      if (!map.getLayers().getArray().includes(layer)) map.addLayer(layer);
      refreshStyle();
      emit('result', metadata);
      return metadata;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (id === requestId) emit('busy', false);
    }
  }
  function clear() {
    requestId++;
    cancelPending();
    cancelSelection();
    source.clear();
    areaSource.clear();
    selection = null;
    storedGrid = null;
    storedSettings = null;
    metadata = null;
    map.removeLayer(layer);
    map.removeLayer(areaLayer);
    refreshStyle();
    emit('busy', false);
    emit('clear');
  }
  const clickKey = map.on('singleclick', (e) => {
    if (selectionInteraction) return;
    const f = source.getFeaturesAtCoordinate(e.coordinate)[0];
    if (f) emit('cell', { ...f.getProperties(), geometry: undefined });
  });
  return {
    events,
    layer,
    source,
    beginSelection,
    cancelSelection,
    clear,
    draw: (settings, weights) => run('generate', settings, weights),
    recalculate: (weights, options) =>
      run(
        storedSettings?.scope === 'network' ? 'generate' : 'analyze',
        storedSettings || {},
        weights,
        options,
      ),
    setHeat: (options) => {
      const next = { ...heat, ...options };
      const nextPalette = makePalette(next.colors);
      heat = next;
      palette = nextPalette;
      refreshStyle();
    },
    setGridStyle: (options) => {
      const next = { ...gridStyle, ...options };
      hexToRgb(next.lineColor);
      if (!Number.isFinite(next.lineWidth) || next.lineWidth < 0 || next.lineWidth > 8)
        throw Error('Grid line width must be 0–8 pixels.');
      gridStyle = next;
      refreshStyle();
    },
    isBusy: () => Boolean(worker),
    getMetadata: () => metadata,
    destroy() {
      clear();
      observer.disconnect();
      document.removeEventListener('keydown', escape);
      ol.Observable.unByKey(clickKey);
    },
  };
}
