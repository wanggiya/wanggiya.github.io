import '../vendor/turf-7.4.0.min.js';
import { generateMetricGrid, analyzeGrid } from './grid-math.js';
self.onmessage = ({ data }) => {
  try {
    const grid =
      data.operation === 'analyze' ? data.grid : generateMetricGrid(self.turf, data);
    self.postMessage(
      analyzeGrid(self.turf, grid, data.snapshot, data.weights, data.settings.scope),
    );
  } catch (error) {
    self.postMessage({ error: error.message || 'Grid calculation failed.' });
  }
};
