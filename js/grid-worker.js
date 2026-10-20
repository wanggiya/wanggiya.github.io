import '../vendor/turf-7.4.0.min.js';
import { generateMetricGrid, analyzeGrid } from './grid-math.js';
self.onmessage = async ({ data }) => {
  try {
    if (data.operation === 'voronoi') {
      const { generateStopVoronoi } = await import('./stop-voronoi.js');
      self.postMessage(generateStopVoronoi(self.turf, data));
      return;
    }
    let grid = data.grid;
    if (data.operation !== 'analyze') {
      if (data.settings.type === 'h3') {
        const { generateH3Grid } = await import('./grid-h3.js');
        grid = generateH3Grid(self.turf, data);
      } else if (data.settings.type === 's2') {
        const { generateS2Grid } = await import('./grid-s2.js');
        grid = generateS2Grid(self.turf, data);
      } else {
        grid = generateMetricGrid(self.turf, data);
      }
    }
    const result = analyzeGrid(
      self.turf,
      grid,
      data.snapshot,
      data.weights,
      data.settings.scope,
    );
    result.metadata.gridSystem = ['h3', 's2'].includes(data.settings.type)
      ? data.settings.type
      : 'metric';
    result.metadata.resolution =
      data.settings.type === 'h3' ? data.settings.resolution : null;
    result.metadata.level = data.settings.type === 's2' ? data.settings.level : null;
    self.postMessage(result);
  } catch (error) {
    self.postMessage({ error: error.message || 'Grid calculation failed.' });
  }
};
