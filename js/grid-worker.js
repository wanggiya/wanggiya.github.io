import '../vendor/turf-7.4.0.min.js';
import { generateMetricGrid, analyzeGrid } from './grid-math.js';
self.onmessage = async ({ data }) => {
  try {
    let grid = data.grid;
    if (data.operation !== 'analyze') {
      if (data.settings.type === 'h3') {
        const { generateH3Grid } = await import('./grid-h3.js');
        grid = generateH3Grid(self.turf, data);
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
    result.metadata.gridSystem = data.settings.type === 'h3' ? 'h3' : 'metric';
    result.metadata.resolution =
      data.settings.type === 'h3' ? data.settings.resolution : null;
    self.postMessage(result);
  } catch (error) {
    self.postMessage({ error: error.message || 'Grid calculation failed.' });
  }
};
