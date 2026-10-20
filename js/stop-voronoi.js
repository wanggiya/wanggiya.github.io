/** Planar nearest-stop regions in local ENU meters; no walking-network claim. */
import {
  feature,
  collection,
  regionalFrame,
  localPoint,
  transformGeometry,
  planarArea,
} from './analysis-geometry.js';
const MAX_SEEDS = 10000;
const MAX_REGIONS = 5000;

export function generateStopVoronoi(turf, { snapshot, mask, grouping = 'stations' }) {
  if (!['stations', 'stops'].includes(grouping)) throw Error('Choose stops or stations.');
  if (!snapshot.stops.length)
    throw Error('No visible stops. Enable stops and at least one route first.');
  if (snapshot.stops.length > MAX_SEEDS)
    throw Error('Too many input stops (limit 10,000). Select fewer routes.');
  const enu = regionalFrame();
  const metricMask = feature(
    transformGeometry(mask?.geometry, (p) => localPoint(p, enu)),
  );
  if (planarArea(metricMask.geometry) < 0.01)
    throw Error('Choose an area larger than 0.01 m².');
  const groups = new Map(),
    seen = new Set();
  // All selected stops participate, including outside the mask. This avoids edge bias.
  for (const stop of snapshot.stops) {
    if (seen.has(stop.id)) continue;
    seen.add(stop.id);
    const key = grouping === 'stations' ? stop.stationId || stop.id : stop.id;
    if (!groups.has(key))
      groups.set(key, {
        id: key,
        names: new Set(),
        stopIds: [],
        points: [],
        groupedByParent: false,
      });
    const group = groups.get(key);
    group.names.add(stop.name || stop.id);
    group.stopIds.push(stop.id);
    group.points.push(localPoint(stop.coordinate, enu));
    group.groupedByParent ||= Boolean(grouping === 'stations' && stop.stationId);
  }
  const sites = new Map();
  for (const group of groups.values()) {
    const xy = [0, 1].map(
      (axis) => group.points.reduce((a, p) => a + p[axis], 0) / group.points.length,
    );
    // Co-located sites have one geometric region and retain all member IDs.
    const key = xy.map((n) => Math.round(n * 10)).join(':');
    if (!sites.has(key))
      sites.set(key, {
        xy,
        seedIds: [],
        stopIds: [],
        names: new Set(),
        groupedByParent: false,
      });
    const site = sites.get(key);
    site.seedIds.push(group.id);
    site.stopIds.push(...group.stopIds);
    for (const name of group.names) site.names.add(name);
    site.groupedByParent ||= group.groupedByParent;
  }
  const points = collection(
    [...sites.values()]
      .sort((a, b) => a.seedIds[0].localeCompare(b.seedIds[0]))
      .map((site) =>
        feature(
          { type: 'Point', coordinates: site.xy },
          {
            seedIds: site.seedIds,
            stopIds: site.stopIds,
            name: [...site.names].sort().join(' / '),
            seedCoordinate: enu.toLonLat(site.xy),
            groupedByParent: site.groupedByParent,
          },
        ),
      ),
  );
  const polygons = turf.voronoi(points, { bbox: turf.bbox(metricMask) });
  const regions = [];
  for (const polygon of polygons.features) {
    if (!polygon) continue;
    const clipped = turf.intersect(collection([polygon, metricMask]));
    if (!clipped) continue;
    const areaKm2 = planarArea(clipped.geometry) / 1e6;
    if (areaKm2 < 1e-8) continue;
    if (regions.length >= MAX_REGIONS)
      throw Error(
        'Too many Voronoi regions (limit 5,000). Choose a smaller area or fewer routes.',
      );
    regions.push(
      feature(
        transformGeometry(clipped.geometry, (p) => enu.toLonLat(p)),
        {
          ...polygon.properties,
          regionId: polygon.properties.seedIds.join('|'),
          areaKm2,
        },
      ),
    );
  }
  return {
    regions: collection(regions),
    metadata: {
      regionCount: regions.length,
      seedCount: sites.size,
      inputStops: seen.size,
      grouping,
      capturedAt: snapshot.capturedAt,
    },
  };
}
