import { WORKER_URL, REFRESH_MS } from './config.js';
import { recordPosition, createPlayback, advancePlayback } from './vehicle-motion.js';
const $ = (id) => document.getElementById(id);
// ---- Modes, configuration and saved preferences ----
const MODES = [
  { type: 0, name: 'Light rail', icon: 'LR', color: '#00843d' },
  { type: 1, name: 'Subway', icon: 'T', color: '#da291c' },
  { type: 2, name: 'Commuter rail', icon: 'CR', color: '#80276c' },
  { type: 3, name: 'Bus', icon: 'B', color: '#aa7200' },
  { type: 4, name: 'Ferry', icon: 'F', color: '#007da5' },
];
const safeRead = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
let base = (
  WORKER_URL ||
  safeRead('mbta-worker-url') ||
  'https://api-v3.mbta.com'
).replace(/\/+$/, '');
const direct = base === 'https://api-v3.mbta.com';
function warning(text) {
  $('data-warning').textContent = text;
  $('data-warning').hidden = !text;
}
if (direct)
  warning(
    'Using the public MBTA API with lower request limits. Set your Worker URL in js/config.js.',
  );
let liveEnabled = true,
  refreshTimer = null,
  nextFetchAt = 0,
  refreshGeneration = 0;
let intervalSeconds =
  Number(safeRead('mbta-refresh-seconds')) || Math.round(REFRESH_MS / 1000) || 15;
intervalSeconds = Math.max(1, Math.min(300, Math.round(intervalSeconds)));
$('refresh-interval').value = String(intervalSeconds);
$('refresh-slider').value = String(intervalSeconds);
$('interval-text').textContent = intervalSeconds;
const storedTheme = safeRead('mbta-theme');
let dark = storedTheme === 'dark';
function applyTheme() {
  $('mbta-brand-logo').src = dark
    ? 'assets/mbta/mbta-secondary-logo-circle-filled.png'
    : 'assets/mbta/mbta-secondary-logo-circle.png';
  document.body.classList.toggle('dark', dark);
  $('theme-light').setAttribute('aria-pressed', String(!dark));
  $('theme-dark').setAttribute('aria-pressed', String(dark));
}
function setTheme(value) {
  dark = value;
  applyTheme();
  try {
    localStorage.setItem('mbta-theme', dark ? 'dark' : 'light');
  } catch {}
  redraw();
  map.render();
}
$('theme-light').onclick = () => setTheme(false);
$('theme-dark').onclick = () => setTheme(true);
applyTheme();
function modeType(route) {
  return route?.id === 'Mattapan' ? 1 : route?.attributes.type;
}

// ---- Shared route, layer and vehicle state ----
const routeById = new Map(),
  routeState = new Map(),
  modeState = new Map(
    MODES.map((m) => [
      m.type,
      { enabled: true, lines: true, stops: true, vehicles: true },
    ]),
  );
const routeSource = new ol.source.Vector(),
  stopSource = new ol.source.Vector(),
  vehicleSource = new ol.source.Vector();
const stopsById = new Map();
let loaded = 0,
  failed = 0,
  networkBusy = false,
  vehicleBusy = false,
  lastFetch = 0,
  vehicleError = '',
  popupFeature = null;
// Keep L(n-2t), L(n-t), L(n), and one persistent playback clock per vehicle.
// recordPosition shifts out the oldest report as each new sample arrives.
const reportedPositions = new Map();
const playbackStates = new Map();
let smoothMovement = safeRead('mbta-smooth-movement') !== 'off';
const isStale = (f) =>
  !Number.isFinite(Date.parse(f.get('updated_at'))) ||
  Date.now() - Date.parse(f.get('updated_at')) > 90000;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const styles = new Map();
const routeIds = (f) => f.get('routeIds') || [f.get('routeId')];
function visibleRoute(id, kind) {
  const r = routeById.get(id),
    s = modeState.get(modeType(r));
  return Boolean(r && s?.enabled && s[kind] && routeState.get(id));
}
function visibleColor(f, kind) {
  for (const id of routeIds(f)) {
    if (visibleRoute(id, kind)) return color(routeById.get(id));
  }
  return null;
}
function color(r) {
  const c = r?.attributes.color;
  return /^[0-9a-f]{6}$/i.test(c || '')
    ? '#' + c
    : MODES.find((m) => m.type === modeType(r))?.color || '#506970';
}
function rgba(c, a) {
  return `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${a})`;
}
/** Find the first selected route used to color a shared stop or a route feature. */
function selectedRoute(feature, layerKind) {
  return routeIds(feature)
    .filter((id) => visibleRoute(id, layerKind))
    .map((id) => routeById.get(id))
    .find(Boolean);
}

function isSilverLine(route) {
  return Boolean(
    route &&
    (route.id.startsWith('SL') ||
      /^SL[0-9W]/i.test(route.attributes.short_name || '') ||
      /silver line/i.test(route.attributes.long_name || '')),
  );
}

/** Theme rules live here so you can adjust them without changing API code. */
function appearanceFor(route) {
  const type = modeType(route);
  const whiteOutline =
    dark &&
    (type === 0 ||
      type === 2 ||
      ['Red', 'Mattapan', 'Blue'].includes(route.id) ||
      isSilverLine(route));
  const blackOutline = type === 3 || route.id === 'Orange';
  const grayStopFill = dark && (type === 0 || route.id === 'Blue' || isSilverLine(route));
  const whiteStopFill = !dark || type === 2;

  return {
    outline: whiteOutline ? '#ffffff' : blackOutline ? '#111820' : null,
    stopFill: grayStopFill ? '#d9e0e5' : whiteStopFill ? '#ffffff' : '#233944',
  };
}

/** A single SVG symbol preserves both rings when the stop layer declutters. */
function outlinedStopImage(routeColor, fillColor, outlineColor) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
    <circle cx="9" cy="9" r="7.2" fill="${fillColor}" stroke="${outlineColor}" stroke-width="1.2"/>
    <circle cx="9" cy="9" r="6" fill="${fillColor}" stroke="${routeColor}" stroke-width="2.2"/>
  </svg>`;
  return new ol.style.Icon({
    src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
    anchor: [0.5, 0.5],
  });
}

function styleFor(kind, feature) {
  const route = selectedRoute(feature, kind);
  if (!route) return;

  const routeColor = color(route);
  const stale = kind === 'vehicles' && isStale(feature);
  const appearance = appearanceFor(route);
  const outline =
    kind === 'stops' && !dark && modeType(route) === 3
      ? '#111820'
      : dark
        ? appearance.outline
        : null;
  const cacheKey = [
    kind,
    routeColor,
    stale,
    dark,
    appearance.outline,
    appearance.stopFill,
    outline,
  ].join('|');
  if (styles.has(cacheKey)) return styles.get(cacheKey);

  let result;
  if (kind === 'lines') {
    const coloredLine = new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: routeColor,
        width: 2.8,
        lineCap: 'round',
        lineJoin: 'round',
      }),
      zIndex: 1,
    });
    result = appearance.outline
      ? [
          new ol.style.Style({
            stroke: new ol.style.Stroke({
              color: appearance.outline,
              width: 4.2,
              lineCap: 'round',
              lineJoin: 'round',
            }),
            zIndex: 0,
          }),
          coloredLine,
        ]
      : coloredLine;
  }

  if (kind === 'stops') {
    // One symbol per stop: separate overlaid symbols are independently decluttered
    // by OpenLayers and can cause the outer ring to disappear.
    const image = outline
      ? outlinedStopImage(routeColor, appearance.stopFill, outline)
      : new ol.style.Circle({
          radius: 6,
          fill: new ol.style.Fill({ color: appearance.stopFill }),
          stroke: new ol.style.Stroke({ color: routeColor, width: 2.2 }),
        });
    result = new ol.style.Style({ image, zIndex: 2 });
  }

  if (kind === 'vehicles') {
    result = new ol.style.Style({
      image: new ol.style.Circle({
        radius: 3.4,
        fill: new ol.style.Fill({ color: stale ? '#849298' : routeColor }),
        stroke: new ol.style.Stroke({
          color: appearance.outline || (dark ? '#f2f8fa' : '#fff'),
          width: 1.2,
        }),
      }),
      zIndex: 4,
    });
  }
  styles.set(cacheKey, result);
  return result;
}
// ---- OpenLayers map and feature details ----
const routeLayer = new ol.layer.Vector({
  source: routeSource,
  style: (f) => styleFor('lines', f),
});
const stopLayer = new ol.layer.Vector({
  source: stopSource,
  style: (f) => styleFor('stops', f),
  renderBuffer: 20,
  declutter: true,
});
const vehicleLayer = new ol.layer.Vector({
  source: vehicleSource,
  style: (f) => styleFor('vehicles', f),
});
const map = new ol.Map({
  target: 'map',
  layers: [
    new ol.layer.Tile({ className: 'basemap-layer', source: new ol.source.OSM() }),
    routeLayer,
    stopLayer,
    vehicleLayer,
  ],
  view: new ol.View({ center: ol.proj.fromLonLat([-71.06, 42.35]), zoom: 11 }),
});
const popup = new ol.Overlay({
  element: $('popup'),
  positioning: 'bottom-center',
  offset: [0, -14],
  autoPan: { animation: { duration: 180 } },
});
map.addOverlay(popup);
function closePopup() {
  popupFeature = null;
  $('popup').hidden = true;
  popup.setPosition(undefined);
}
$('popup-close').onclick = closePopup;
function line(text, parent, tag = 'div') {
  const el = document.createElement(tag);
  el.textContent = text;
  parent.append(el);
  return el;
}
function showPopup(f) {
  const node = $('popup-content');
  node.replaceChildren();
  const kind = f.get('kind');
  line(
    kind === 'vehicle' ? 'LIVE VEHICLE' : kind === 'stop' ? 'STOP / STATION' : 'ROUTE',
    node,
  ).className = 'tag';
  line(f.get('name') || 'MBTA', node, 'h2');
  const names = routeIds(f)
    .map((id) => routeById.get(id))
    .filter(Boolean)
    .map((r) => r.attributes.short_name || r.attributes.long_name || r.id);
  line('Route: ' + [...new Set(names)].join(', '), node);
  if (kind === 'vehicle') {
    line(
      'Status: ' +
        (f.get('current_status') || 'Not reported').replaceAll('_', ' ').toLowerCase(),
      node,
    );
    const t = Date.parse(f.get('updated_at')),
      age = Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
    line(
      'Position reported: ' +
        (age === null ? 'unknown' : `${age}s ago${age > 90 ? ' · stale' : ''}`),
      node,
    );
    const speed = f.get('speed');
    if (typeof speed === 'number') line(`Speed: ${(speed * 3.6).toFixed(0)} km/h`, node);
    line('Next/current stop ID: ' + (f.get('stopId') || 'Not reported'), node);
    line('Vehicle ID: ' + f.getId(), node);
    line(
      smoothMovement
        ? 'Display: continuous estimated motion'
        : 'Display: latest MBTA-reported position',
      node,
    );
  } else if (kind === 'stop') {
    line('Stop ID: ' + f.getId(), node);
    if (f.get('municipality')) line(f.get('municipality'), node);
  }
  $('popup').hidden = false;
  popup.setPosition(
    f.getGeometry().getType() === 'Point'
      ? f.getGeometry().getCoordinates()
      : map.getView().getCenter(),
  );
  popupFeature = f;
}
map.on('singleclick', (event) => {
  const f = map.forEachFeatureAtPixel(event.pixel, (f) => f, {
    hitTolerance: 5,
    layerFilter: (l) => l === stopLayer || l === vehicleLayer,
  });
  if (f) showPopup(f);
  else closePopup();
});
// Avoid full-network hit detection on every mouse movement; points remain clickable.

function redraw() {
  routeLayer.changed();
  stopLayer.changed();
  vehicleLayer.changed();
  if (popupFeature) closePopup();
  updateStatus();
}
function updateStatus() {
  const shown = vehicleLayer.getVisible()
    ? vehicleSource.getFeatures().filter((f) => Boolean(visibleColor(f, 'vehicles')))
    : [];
  const stale = shown.filter(isStale).length;
  const paused = !liveEnabled || document.hidden;
  $('live-status').textContent = vehicleError
    ? vehicleError
    : lastFetch
      ? `${shown.length} visible vehicles${stale ? ` · ${stale} stale` : ''}${paused ? ' · updates paused' : ''}`
      : 'Waiting for vehicle positions…';
  $('live-dot').className =
    'live-dot ' + (vehicleError ? 'error' : lastFetch && !paused ? 'ok' : '');
  $('next-update').textContent = paused
    ? 'Paused'
    : vehicleBusy
      ? 'Fetching…'
      : nextFetchAt
        ? 'Next in ' + Math.max(0, Math.ceil((nextFetchAt - Date.now()) / 1000)) + 's'
        : 'Connecting…';
  $('load-status').textContent =
    `${loaded}/${routeById.size} routes loaded · ${stopSource.getFeatures().length.toLocaleString()} stops${failed ? ` · ${failed} route loads need retry` : ''}${networkBusy ? ' · loading network…' : ''}${lastFetch ? ' · fetched ' + new Date(lastFetch).toLocaleTimeString() : ''}`;
}
// ---- Static-data cache and paginated API requests ----
const dbPromise = new Promise((resolve) => {
  try {
    const q = indexedDB.open('mbta-atlas-cache', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('responses');
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => resolve(null);
  } catch {
    resolve(null);
  }
});
async function cached(key) {
  const db = await dbPromise;
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const q = db.transaction('responses').objectStore('responses').get(key);
      q.onsuccess = () =>
        resolve(
          q.result && Date.now() - q.result.time < 86400000 ? q.result.value : null,
        );
      q.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function cache(key, value) {
  const db = await dbPromise;
  if (!db) return;
  try {
    const tx = db.transaction('responses', 'readwrite');
    tx.objectStore('responses').put({ time: Date.now(), value }, key);
  } catch {
    /* Cache is optional. */
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(path, params = {}, staticData = false) {
  const url = new URL(path, base);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  if (staticData) {
    const hit = await cached(url.href);
    if (hit) return hit;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 25000);
    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        cache: staticData ? 'default' : 'no-store',
      });
      if (res.status === 429) {
        const delay = Math.min(
          60,
          Math.max(5, Number(res.headers.get('Retry-After')) || 15),
        );
        if (attempt < 2) {
          await wait(delay * 1000);
          continue;
        }
      }
      if (!res.ok)
        throw new Error(
          `${path}: HTTP ${res.status}${res.status === 400 ? ' — update the Worker from this ZIP' : res.status === 429 ? ' — rate limited; connect your Worker or retry later' : ''}`,
        );
      const data = await res.json();
      if (!Array.isArray(data.data)) throw new Error(`${path}: unexpected response`);
      if (staticData) await cache(url.href, data);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
async function allPages(path, params = {}, staticData = false, withIncluded = false) {
  const all = [],
    included = new Map(),
    seen = new Set();
  let page = { ...params, 'page[limit]': 1000 };
  for (let i = 0; i < 100; i++) {
    const key = JSON.stringify(page);
    if (seen.has(key)) throw new Error('Repeated pagination cursor');
    seen.add(key);
    const json = await request(path, page, staticData);
    all.push(...json.data);
    for (const resource of json.included || [])
      included.set(resource.type + ':' + resource.id, resource);
    if (!json.links?.next)
      return withIncluded ? { data: all, included: [...included.values()] } : all;
    // Use only the cursor/query on our own API base, never the MBTA hostname from links.
    const next = new URL(json.links.next, 'https://api-v3.mbta.com');
    if (next.pathname.replace(/\/$/, '') !== path)
      throw new Error('Unexpected pagination path');
    page = Object.fromEntries(next.searchParams);
    delete page.api_key;
  }
  throw new Error('Pagination exceeded safety limit; data not silently truncated');
}
// ---- Mode, route and layer controls ----
function checkbox(parent, text, checked, onchange) {
  const label = document.createElement('label'),
    input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.onchange = onchange;
  label.append(input, document.createTextNode(text));
  parent.append(label);
  return input;
}
function buildControls() {
  for (const mode of MODES) {
    const routes = [...routeById.values()].filter((r) => modeType(r) === mode.type);
    const details = document.createElement('details');
    details.className = 'mode';
    details.open = mode.type < 2;
    details.dataset.mode = mode.type;
    const summary = document.createElement('summary');
    const label = document.createElement('label');
    label.className = 'mode-check';
    label.onclick = (e) => e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.dataset.modeToggle = mode.type;
    input.setAttribute('aria-label', mode.name);
    input.onchange = () => {
      modeState.get(mode.type).enabled = input.checked;
      redraw();
    };
    label.append(input);
    const icon = line(mode.icon, label, 'span');
    icon.className = 'mode-icon';
    icon.style.setProperty('--mode', mode.color);
    line(mode.name, label, 'span');
    summary.append(label);
    line(String(routes.length), summary, 'span').className = 'mode-count';
    details.append(summary);
    const sub = document.createElement('div');
    sub.className = 'mode-layers';
    for (const kind of ['lines', 'stops', 'vehicles']) {
      const check = checkbox(sub, kind[0].toUpperCase() + kind.slice(1), true, (e) => {
        modeState.get(mode.type)[kind] = e.target.checked;
        syncLayerControls(kind);
        redraw();
      });
      check.dataset.kind = kind;
      check.dataset.modeLayer = mode.type;
    }
    details.append(sub);
    const list = document.createElement('div');
    list.className = 'routes';
    for (const r of routes) {
      const row = document.createElement('label');
      row.className = 'route-row';
      row.dataset.search =
        `${r.id} ${r.attributes.short_name || ''} ${r.attributes.long_name || ''}`.toLowerCase();
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = true;
      check.dataset.route = r.id;
      check.onchange = () => {
        routeState.set(r.id, check.checked);
        redraw();
      };
      row.append(check);
      const swatch = line('', row, 'span');
      swatch.className = 'swatch';
      swatch.style.background = color(r);
      line(
        [r.attributes.short_name, r.attributes.long_name].filter(Boolean).join(' · ') ||
          r.id,
        row,
        'span',
      );
      list.append(row);
    }
    details.append(list);
    $('modes').append(details);
  }
}
$('route-search').oninput = (e) => {
  const term = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.mode').forEach((d) => {
    let count = 0;
    d.querySelectorAll('.route-row').forEach((row) => {
      row.hidden = Boolean(term && !row.dataset.search.includes(term));
      row.style.display = row.hidden ? 'none' : '';
      if (!row.hidden) count++;
    });
    d.hidden = count === 0;
    if (term && count) d.open = true;
  });
};
function syncLayerControls(kind) {
  const states = [...modeState.values()].map((s) => s[kind]);
  $(kind).checked = states.every(Boolean);
  $(kind).indeterminate = states.some(Boolean) && !states.every(Boolean);
  document
    .querySelectorAll(`[data-kind="${kind}"]`)
    .forEach((c) => (c.checked = modeState.get(Number(c.dataset.modeLayer))[kind]));
  ({ lines: routeLayer, stops: stopLayer, vehicles: vehicleLayer })[kind].setVisible(
    states.some(Boolean),
  );
}
for (const kind of ['lines', 'stops', 'vehicles'])
  $(kind).onchange = () => {
    const selected = $(kind).checked;
    for (const s of modeState.values()) s[kind] = selected;
    syncLayerControls(kind);
    redraw();
  };
for (const [id, enabled] of [
  ['select-all', true],
  ['select-none', false],
])
  $(id).onclick = () => {
    for (const s of modeState.values()) {
      s.enabled = enabled;
      if (enabled) s.lines = s.stops = s.vehicles = true;
    }
    document.querySelectorAll('[data-mode-toggle]').forEach((c) => (c.checked = enabled));
    if (enabled) {
      for (const id of routeState.keys()) routeState.set(id, true);
      document.querySelectorAll('[data-route]').forEach((c) => (c.checked = true));
      for (const kind of ['lines', 'stops', 'vehicles']) syncLayerControls(kind);
    }
    redraw();
  };
$('collapse').onclick = () => {
  const closed = document.querySelector('.panel').classList.toggle('collapsed');
  $('collapse').textContent = closed ? '+' : '−';
  $('collapse').setAttribute('aria-expanded', String(!closed));
};
$('fit').onclick = () => {
  const extent = ol.extent.createEmpty();
  for (const f of routeSource.getFeatures())
    if (visibleColor(f, 'lines')) ol.extent.extend(extent, f.getGeometry().getExtent());
  if (!ol.extent.isEmpty(extent))
    map.getView().fit(extent, {
      padding: innerWidth > 750 ? [110, 370, 100, 70] : [90, 30, 110, 30],
      maxZoom: 13,
      duration: 500,
    });
};
// ---- Bulk network loading and targeted retries ----
function addStops(data, routeId) {
  const added = [];
  for (const s of data) {
    const a = s.attributes;
    if (!Number.isFinite(a.longitude) || !Number.isFinite(a.latitude)) continue;
    let f = stopsById.get(s.id);
    if (f) {
      const ids = f.get('routeIds');
      if (!ids.includes(routeId)) ids.push(routeId);
    } else {
      f = new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([a.longitude, a.latitude])),
        kind: 'stop',
        name: a.name,
        municipality: a.municipality,
        routeIds: [routeId],
      });
      f.setId(s.id);
      stopsById.set(s.id, f);
      added.push(f);
    }
  }
  if (added.length) stopSource.addFeatures(added);
  stopLayer.changed();
}
function addShapes(data, routeId) {
  const added = [],
    format = new ol.format.Polyline({ factor: 1e5 });
  for (const s of data) {
    if (!s.attributes?.polyline) continue;
    const key = routeId + '|' + s.id;
    if (routeSource.getFeatureById(key)) continue;
    const geometry = format.readGeometry(s.attributes.polyline, {
      dataProjection: 'EPSG:4326',
      featureProjection: 'EPSG:3857',
    });
    const f = new ol.Feature({
      geometry,
      kind: 'line',
      routeId,
      name: routeById.get(routeId)?.attributes.long_name,
    });
    f.setId(key);
    added.push(f);
  }
  if (added.length) routeSource.addFeatures(added);
}
const BULK_PARAMS = {
  'filter[type]': '0,1,2,3,4',
  include:
    'route_patterns.representative_trip.shape,route_patterns.representative_trip.stops',
};
async function applyNetwork(document) {
  const resources = new Map(document.included.map((x) => [x.type + ':' + x.id, x]));
  let processed = 0;
  for (const r of document.data) {
    if (!routeById.has(r.id)) continue;
    const current = routeById.get(r.id),
      shapes = new Map(),
      stops = new Map();
    let complete = true;
    const patterns = r.relationships?.route_patterns?.data || [];
    for (const ref of patterns) {
      const pattern = resources.get('route_pattern:' + ref.id),
        trip = resources.get(
          'trip:' + pattern?.relationships?.representative_trip?.data?.id,
        );
      if (!trip) {
        complete = false;
        continue;
      }
      const shape = resources.get('shape:' + trip.relationships?.shape?.data?.id);
      if (shape) shapes.set(shape.id, shape);
      else complete = false;
      for (const stopRef of trip.relationships?.stops?.data || []) {
        const stop = resources.get('stop:' + stopRef.id);
        if (stop) stops.set(stop.id, stop);
        else complete = false;
      }
    }
    addShapes([...shapes.values()], r.id);
    addStops([...stops.values()], r.id);
    current._loaded = {
      shapes: complete && shapes.size > 0,
      stops: complete && stops.size > 0,
    };
    current._error =
      patterns.length && current._loaded.shapes && current._loaded.stops
        ? ''
        : 'No complete representative network supplied';
    if (++processed % 4 === 0) {
      updateCounts();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  updateCounts();
}
function updateCounts() {
  loaded = [...routeById.values()].filter(
    (r) => r._loaded?.shapes && r._loaded?.stops,
  ).length;
  failed = [...routeById.values()].filter((r) => r._error).length;
  updateStatus();
}
async function loadRoute(r) {
  const state = r._loaded || (r._loaded = {}),
    tasks = [];
  if (!state.shapes)
    tasks.push(
      (async () => {
        const data = await allPages('/shapes', { 'filter[route]': r.id }, true);
        addShapes(data, r.id);
        state.shapes = true;
      })(),
    );
  if (!state.stops)
    tasks.push(
      (async () => {
        const data = await allPages(
          '/stops',
          { 'filter[route]': r.id, 'filter[location_type]': '0,1' },
          true,
        );
        addStops(data, r.id);
        state.stops = true;
      })(),
    );
  const results = await Promise.allSettled(tasks);
  r._error = results.find((x) => x.status === 'rejected')?.reason.message || '';
}
async function loadNetwork() {
  if (networkBusy) return;
  networkBusy = true;
  $('retry').disabled = true;
  try {
    const queue = [...routeById.values()].filter(
      (r) => !r._loaded?.shapes || !r._loaded?.stops,
    );
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length) {
        await loadRoute(queue[cursor++]);
        updateCounts();
        if (direct) await wait(1500);
      }
    }
    await Promise.all(Array.from({ length: direct ? 1 : 2 }, worker));
  } finally {
    networkBusy = false;
    $('retry').disabled = false;
    updateCounts();
  }
}
// ---- Live polling and bounded position interpolation ----
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  nextFetchAt = 0;
  if (liveEnabled && !document.hidden) {
    nextFetchAt = Date.now() + intervalSeconds * 1000;
    refreshTimer = setTimeout(() => refreshVehicles(), intervalSeconds * 1000);
  }
  updateStatus();
}
/** Accept valid source samples without ever resetting the animation clock. */
function receiveVehiclePosition(feature, attributes) {
  const id = feature.getId();
  const coordinates = ol.proj.fromLonLat([attributes.longitude, attributes.latitude]);
  const old = reportedPositions.get(id);
  const reportTime = Date.parse(attributes.updated_at);
  const receivedAt = Date.now();
  let history = recordPosition(old?.history || [], coordinates, reportTime, receivedAt);
  const duplicate = old && history === old.history;
  if (duplicate) return; // Cached/void updates cannot restart playback.

  const discontinuity =
    old &&
    Math.hypot(
      coordinates[0] - old.coordinates[0],
      coordinates[1] - old.coordinates[1],
    ) >= 10000;
  if (discontinuity) {
    history = history.slice(-1);
    playbackStates.delete(id);
  }
  reportedPositions.set(id, {
    coordinates: coordinates.slice(),
    reportTime,
    receivedAt,
    history,
  });
  const canSmooth =
    smoothMovement &&
    liveEnabled &&
    !reducedMotion.matches &&
    !isStale(feature) &&
    history.length >= 2;
  if (!canSmooth || discontinuity || !feature.getGeometry()) {
    playbackStates.delete(id);
    feature.setGeometry(new ol.geom.Point(coordinates));
    return;
  }
  if (!playbackStates.has(id)) {
    playbackStates.set(
      id,
      createPlayback(history, feature.getGeometry().getCoordinates(), performance.now()),
    );
  }
}

function snapToReportedPositions() {
  playbackStates.clear();
  for (const [id, report] of reportedPositions) {
    const feature = vehicleSource.getFeatureById(id);
    if (feature) feature.setGeometry(new ol.geom.Point(report.coordinates.slice()));
  }
}

function updateMovementButton() {
  $('smooth-movement').setAttribute('aria-checked', String(smoothMovement));
  $('smooth-movement').querySelector('.switch-status').firstChild.textContent =
    smoothMovement ? 'On ' : 'Off ';
  $('movement-note').textContent = smoothMovement
    ? 'Continuous estimated motion from valid reports; may lag.'
    : 'Showing the latest MBTA-reported positions.';
}

function setSmoothMovement(enabled) {
  smoothMovement = enabled;
  try {
    localStorage.setItem('mbta-smooth-movement', enabled ? 'on' : 'off');
  } catch {}
  if (!enabled) snapToReportedPositions();
  else {
    for (const [id, report] of reportedPositions) {
      const feature = vehicleSource.getFeatureById(id);
      if (feature && report.history.length >= 2 && !isStale(feature)) {
        playbackStates.set(
          id,
          createPlayback(
            report.history,
            feature.getGeometry().getCoordinates(),
            performance.now(),
          ),
        );
      }
    }
  }
  updateMovementButton();
  if (popupFeature?.get('kind') === 'vehicle') showPopup(popupFeature);
  vehicleLayer.changed();
}

$('smooth-movement').onclick = () => setSmoothMovement(!smoothMovement);
updateMovementButton();

async function refreshVehicles() {
  if (vehicleBusy || document.hidden || !liveEnabled) return;
  clearTimeout(refreshTimer);
  nextFetchAt = 0;
  vehicleBusy = true;
  $('refresh').disabled = true;
  const generation = refreshGeneration;

  try {
    const reports = await allPages('/vehicles');
    if (generation !== refreshGeneration || !liveEnabled || document.hidden) return;
    // A void feed is not evidence that every vehicle disappeared.
    if (!reports.length) {
      vehicleError = 'No positions returned · retaining last valid reports';
      return;
    }
    const receivedIds = new Set(reports.map((vehicle) => vehicle.id));
    let validReports = 0;

    for (const vehicle of reports) {
      const attributes = vehicle.attributes || {};
      const routeId = vehicle.relationships?.route?.data?.id;
      if (
        !routeById.has(routeId) ||
        !Number.isFinite(attributes.latitude) ||
        !Number.isFinite(attributes.longitude) ||
        (attributes.latitude === 0 && attributes.longitude === 0) ||
        Math.abs(attributes.latitude) > 90 ||
        Math.abs(attributes.longitude) > 180
      )
        continue;

      let feature = vehicleSource.getFeatureById(vehicle.id);
      const isNew = !feature;
      if (isNew) {
        feature = new ol.Feature();
        feature.setId(vehicle.id);
      }

      const oldReport = reportedPositions.get(vehicle.id);
      const reportTime = Date.parse(attributes.updated_at);
      if (!Number.isFinite(reportTime)) continue; // Incomplete reports cannot replace valid samples.
      feature.set('_missingSince', null, true);
      if (
        oldReport &&
        Number.isFinite(reportTime) &&
        Number.isFinite(oldReport.reportTime) &&
        reportTime < oldReport.reportTime
      )
        continue;

      feature.setProperties({
        ...attributes,
        kind: 'vehicle',
        name: attributes.label ? 'Vehicle ' + attributes.label : 'Vehicle ' + vehicle.id,
        routeId,
        stopId: vehicle.relationships?.stop?.data?.id,
      });
      receiveVehiclePosition(feature, attributes);
      validReports++;
      if (isNew) vehicleSource.addFeature(feature);
    }

    // Allow brief omissions/partial responses instead of blinking a marker off.
    // Persistently absent vehicles still release all history and playback state.
    const missingGrace = Math.min(120000, Math.max(30000, intervalSeconds * 2000));
    for (const feature of vehicleSource.getFeatures()) {
      const id = feature.getId();
      if (receivedIds.has(id)) {
        feature.set('_missingSince', null, true);
        continue;
      }
      const missingSince = feature.get('_missingSince') ?? Date.now();
      feature.set('_missingSince', missingSince, true);
      if (Date.now() - missingSince >= missingGrace) {
        vehicleSource.removeFeature(feature);
        playbackStates.delete(id);
        reportedPositions.delete(id);
      }
    }

    lastFetch = Date.now();
    vehicleError = validReports ? '' : 'No valid locations · retaining last reports';
    if (!direct) warning('');
    if (popupFeature?.get('kind') === 'vehicle') {
      const current = vehicleSource.getFeatureById(popupFeature.getId());
      if (current) showPopup(current);
      else closePopup();
    }
  } catch (error) {
    vehicleError = 'Live update failed · showing last received positions';
    console.warn(error.message);
    warning(error.message);
  } finally {
    vehicleBusy = false;
    $('refresh').disabled = !liveEnabled;
    vehicleLayer.changed();
    scheduleRefresh();
  }
}
$('refresh').onclick = refreshVehicles;
$('retry').onclick = loadNetwork;
$('pause').onclick = () => {
  liveEnabled = !liveEnabled;
  const now = performance.now();
  for (const state of playbackStates.values()) state.lastFrame = now;
  refreshGeneration++;
  clearTimeout(refreshTimer);
  nextFetchAt = 0;
  $('pause').setAttribute('aria-checked', String(liveEnabled));
  $('pause').querySelector('.switch-status').firstChild.textContent = liveEnabled
    ? 'On '
    : 'Off ';
  $('refresh').disabled = !liveEnabled || vehicleBusy;
  updateStatus();
  if (liveEnabled) refreshVehicles();
};
function setIntervalSeconds(value) {
  if (!Number.isFinite(value)) return;
  intervalSeconds = Math.max(1, Math.min(300, Math.round(value)));
  $('refresh-interval').value = String(intervalSeconds);
  $('refresh-slider').value = String(intervalSeconds);
  $('interval-text').textContent = intervalSeconds;
  try {
    localStorage.setItem('mbta-refresh-seconds', String(intervalSeconds));
  } catch {}
  if (!vehicleBusy) scheduleRefresh();
}
$('refresh-slider').oninput = () => setIntervalSeconds(Number($('refresh-slider').value));
$('refresh-interval').oninput = () => {
  const value = $('refresh-interval').valueAsNumber;
  if (Number.isInteger(value) && value >= 1 && value <= 300) setIntervalSeconds(value);
};
$('refresh-interval').onchange = $('refresh-interval').onblur = () => {
  const value = $('refresh-interval').valueAsNumber;
  setIntervalSeconds(Number.isFinite(value) ? value : intervalSeconds);
};
document.addEventListener('visibilitychange', () => {
  for (const state of playbackStates.values()) state.lastFrame = performance.now();
  refreshGeneration++;
  clearTimeout(refreshTimer);
  nextFetchAt = 0;
  if (!document.hidden && liveEnabled) refreshVehicles();
  updateStatus();
});
// Animate halos on a separate canvas so static route/stop layers are not repainted every frame.
// ---- Lightweight halo canvas and animation loop ----
const haloCanvas = document.createElement('canvas');
haloCanvas.className = 'vehicle-halos';
haloCanvas.setAttribute('aria-hidden', 'true');
map.getViewport().append(haloCanvas);
const haloContext = haloCanvas.getContext('2d');
function drawHalos(now) {
  const size = map.getSize();
  if (!size || !haloContext) return;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  if (
    haloCanvas.width !== Math.round(size[0] * ratio) ||
    haloCanvas.height !== Math.round(size[1] * ratio)
  ) {
    haloCanvas.width = Math.round(size[0] * ratio);
    haloCanvas.height = Math.round(size[1] * ratio);
  }
  haloContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  haloContext.clearRect(0, 0, size[0], size[1]);
  if (reducedMotion.matches || !vehicleLayer.getVisible() || document.hidden) return;
  const phase = (1 + Math.sin(now / 650)) / 2,
    extent = map.getView().calculateExtent(size);
  for (const f of vehicleSource.getFeaturesInExtent(extent)) {
    const c = visibleColor(f, 'vehicles');
    if (!c || isStale(f)) continue;
    const pixel = map.getPixelFromCoordinate(f.getGeometry().getCoordinates());
    if (!pixel) continue;
    haloContext.beginPath();
    haloContext.arc(pixel[0], pixel[1], 5 + phase * 4, 0, Math.PI * 2);
    haloContext.fillStyle = rgba(c, 0.12 + (1 - phase) * 0.1);
    haloContext.fill();
  }
}
let lastFrame = 0;
function animate(now) {
  requestAnimationFrame(animate);
  if (document.hidden || now - lastFrame < 33) return;
  lastFrame = now;
  const extent = ol.extent.buffer(
    map.getView().calculateExtent(map.getSize()),
    map.getView().getResolution() * 30,
  );
  for (const [id, state] of playbackStates) {
    const feature = vehicleSource.getFeatureById(id);
    const report = reportedPositions.get(id);
    if (!feature || !report) {
      playbackStates.delete(id);
      continue;
    }
    if (!liveEnabled) {
      state.lastFrame = now;
      continue;
    }
    if (isStale(feature) && smoothMovement && !reducedMotion.matches) {
      state.lastFrame = now;
      state.kind = 'held';
      continue; // Gray and hold the display; a stale/void poll must not jump it backward.
    }
    if (!smoothMovement || reducedMotion.matches) {
      feature.getGeometry().setCoordinates(report.coordinates.slice());
      playbackStates.delete(id);
      continue;
    }
    advancePlayback(
      state,
      report.history,
      now,
      intervalSeconds * 1000,
      feature.get('current_status') === 'STOPPED_AT',
    );
    // Retain clock/speed everywhere; redraw geometry only where it matters.
    const current = feature.getGeometry().getCoordinates();
    if (
      vehicleLayer.getVisible() &&
      visibleColor(feature, 'vehicles') &&
      (ol.extent.containsCoordinate(extent, state.position) ||
        ol.extent.containsCoordinate(extent, current))
    ) {
      if (
        Math.hypot(state.position[0] - current[0], state.position[1] - current[1]) > 0.01
      ) {
        feature.getGeometry().setCoordinates(state.position.slice());
      }
    }
  }
  if (popupFeature?.get('kind') === 'vehicle')
    popup.setPosition(popupFeature.getGeometry().getCoordinates());
  drawHalos(now);
}
requestAnimationFrame(animate);
setInterval(() => {
  let changed = false;
  for (const f of vehicleSource.getFeatures()) {
    const stale = isStale(f);
    if (f.get('_stale') !== stale) {
      f.set('_stale', stale, true);
      changed = true;
    }
  }
  if (changed) vehicleLayer.changed();
  updateStatus();
}, 1000);
// ---- Startup ----
async function start() {
  networkBusy = true;
  $('retry').disabled = true;
  try {
    const document = await allPages('/routes', BULK_PARAMS, true, true);
    const routes = document.data.sort(
      (a, b) => (a.attributes.sort_order || 0) - (b.attributes.sort_order || 0),
    );
    for (const r of routes) {
      routeById.set(r.id, r);
      routeState.set(r.id, true);
    }
    buildControls();
    refreshVehicles();
    await applyNetwork(document);
    networkBusy = false;
    $('retry').disabled = false;
    updateCounts();
    if (failed) loadNetwork();
  } catch (e) {
    vehicleError = 'Unable to load MBTA network';
    warning(e.message + ' — deploy cloudflare/worker.js from this update, then reload.');
    networkBusy = false;
    $('retry').disabled = false;
    updateStatus();
    $('retry').onclick = () => location.reload();
  }
}
start();

// Public integration context for your custom tools. Existing MBTA layers remain separate.
export const interactionContext = {
  map,
  routeSource,
  stopSource,
  vehicleSource,
  routeLayer,
  stopLayer,
  vehicleLayer,
  refreshVehicles,
  getSelectedRouteIds: () =>
    [...routeState]
      .filter(([id, on]) => on && modeState.get(modeType(routeById.get(id)))?.enabled)
      .map(([id]) => id),
  getRefreshSeconds: () => intervalSeconds,
  setRefreshSeconds: setIntervalSeconds,
  setSmoothMovement,
};
