import { WORKER_URL, REFRESH_MS } from './config.js';
import { VehicleTracker, TRACKER_OPTIONS } from './vehicle-motion.js';
import {
  VehicleDisplay,
  MOTION_PROFILES,
  DISPLAY_OPTIONS,
  profileForRoute,
} from './vehicle-display.js';
const $ = (id) => document.getElementById(id);
// ---- Modes, configuration and saved preferences ----
const MODES = [
  { type: 0, name: 'Light rail', icon: 'LR', color: '#00843d' },
  { type: 1, name: 'Subway', icon: 'T', color: '#da291c' },
  { type: 2, name: 'Commuter rail', icon: 'CR', color: '#80276c' },
  { type: 3, name: 'Bus', icon: 'B', color: '#aa7200' },
  // UI-only group 5; the API and motion profile still treat Silver Line as bus.
  { type: 5, name: 'Silver Line', icon: 'SL', color: '#7c878e' },
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
  if (isSilverLine(route)) return 5;
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
// One independent local-meter Kalman filter per vehicle. No raw-position fallback.
const reportedPositions = new Map();
const vehicleTrackers = new Map();
const vehicleDisplays = new Map();
const drawEntries = new Map();
let canvasHits = [];
let paintRevision = 0;
vehicleSource.on('removefeature', ({ feature }) => {
  const id = feature.getId();
  vehicleTrackers.delete(id);
  vehicleDisplays.delete(id);
  drawEntries.delete(id);
  reportedPositions.delete(id);
});

// Anchor wall time to a monotonic clock; OS clock changes cannot reverse prediction.
const trackingEpoch = Date.now() - performance.now();
const trackingTime = () => trackingEpoch + performance.now();
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
  const blackOutline = route?.attributes.type === 3 || route.id === 'Orange';
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
    kind === 'stops' && !dark && route?.attributes.type === 3
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
  zIndex: 2,
  style: (f) => styleFor('lines', f),
});
const stopLayer = new ol.layer.Vector({
  source: stopSource,
  zIndex: 3,
  style: (f) => styleFor('stops', f),
  renderBuffer: 20,
  declutter: true,
});
const vehicleLayer = new ol.layer.Vector({
  source: vehicleSource,
  // Vehicle bodies and halos are drawn together on the dedicated canvas.
  style: () => null,
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
    const speed = drawEntries.get(f.getId())?.speedMps ?? f.get('filteredSpeedMps');
    if (typeof speed === 'number')
      line(`Estimated speed: ${(speed * 3.6).toFixed(0)} km/h`, node);
    const heading = drawEntries.get(f.getId())?.heading ?? f.get('filteredHeading');
    if (Number.isFinite(heading)) line(`Estimated heading: ${heading.toFixed(0)}°`, node);
    line('Next/current stop ID: ' + (f.get('stopId') || 'Not reported'), node);
    line('Vehicle ID: ' + f.getId(), node);
    line(
      smoothMovement
        ? 'Display: buffered Kalman estimates'
        : 'Display: Kalman-filtered GPS updates',
      node,
    );
  } else if (kind === 'stop') {
    line('Stop ID: ' + f.getId(), node);
    if (f.get('municipality')) line(f.get('municipality'), node);
  }
  $('popup').hidden = false;
  popup.setPosition(
    (kind === 'vehicle' && drawEntries.get(f.getId())?.coordinate) ||
      (f.getGeometry().getType() === 'Point'
        ? f.getGeometry().getCoordinates()
        : map.getView().getCenter()),
  );
  popupFeature = f;
}
map.on('singleclick', (event) => {
  let nearest = null;
  let distance = 11;
  for (const hit of canvasHits) {
    const d = Math.hypot(hit.pixel[0] - event.pixel[0], hit.pixel[1] - event.pixel[1]);
    if (d < distance) {
      nearest = hit.feature;
      distance = d;
    }
  }
  const f =
    nearest ||
    map.forEachFeatureAtPixel(event.pixel, (f) => f, {
      hitTolerance: 5,
      layerFilter: (l) => l === stopLayer || l === vehicleLayer,
    });
  if (f) showPopup(f);
  else closePopup();
});
// Avoid full-network hit detection on every mouse movement; points remain clickable.

function redraw() {
  paintRevision++;
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
        `${r.id} ${r.attributes.short_name || ''} ${r.attributes.long_name || ''} ${isSilverLine(r) ? 'silver line silverline' : ''}`.toLowerCase();
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
// ---- Live polling and local-meter Kalman tracking ----
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  nextFetchAt = 0;
  if (liveEnabled && !document.hidden) {
    nextFetchAt = Date.now() + intervalSeconds * 1000;
    refreshTimer = setTimeout(() => refreshVehicles(), intervalSeconds * 1000);
  }
  updateStatus();
}
/** GPS-rate geometry for indexing/integration only. Animated drawing does
 * not mutate OpenLayers features, so the vector layer is not rebuilt per frame.
 */
function renderVehicleTrack(feature, tracker) {
  const filtered = tracker.sample(tracker.posterior.time, false);
  const coordinate = ol.proj.fromLonLat(filtered.lonLat);
  if (!feature.getGeometry()) feature.setGeometry(new ol.geom.Point(coordinate));
  else feature.getGeometry().setCoordinates(coordinate);
  feature.setProperties(
    { filteredHeading: filtered.heading, filteredSpeedMps: filtered.speedMps },
    true,
  );
}

/** GPS is assimilated once per distinct source timestamp, never once per poll. */
function receiveVehiclePosition(feature, attributes) {
  const id = feature.getId();
  let tracker = vehicleTrackers.get(id);
  const route = routeById.get(attributes._routeId || feature.get('routeId'));
  const profileName = profileForRoute(route);
  const profile = MOTION_PROFILES[profileName];
  if (!tracker)
    tracker = new VehicleTracker({
      ...TRACKER_OPTIONS,
      processNoise: profile.processNoise,
      maxPredictionSeconds: profile.seconds,
    });
  tracker.options = Object.freeze({
    ...tracker.options,
    processNoise: profile.processNoise,
    maxPredictionSeconds: profile.seconds,
  });
  const reportTime = Date.parse(attributes.updated_at);
  const result = tracker.updateGPS(
    [attributes.longitude, attributes.latitude],
    reportTime,
    trackingTime(),
  );
  feature.set('trackingStatus', result.reason, true);
  if (!result.accepted) return false;
  vehicleTrackers.set(id, tracker);
  reportedPositions.set(id, { reportTime, receivedAt: trackingTime() });
  renderVehicleTrack(feature, tracker);
  let display = vehicleDisplays.get(id);
  if (!display) {
    display = new VehicleDisplay(profile);
    vehicleDisplays.set(id, display);
  }
  display.profile = profile;
  display.push(
    tracker.sample(reportTime, false),
    trackingTime(),
    attributes.current_status === 'STOPPED_AT',
  );
  const previous = drawEntries.get(id);
  const projected = display.samples.map((sample) =>
    ol.proj.fromLonLat(tracker.frame.toLonLat(sample.position)),
  );
  const bounds = ol.extent.boundingExtent(projected);
  drawEntries.set(id, {
    feature,
    tracker,
    display,
    profileName,
    bounds: ol.extent.buffer(bounds, profile.meters * 2 + 50),
    coordinate: previous?.coordinate || feature.getGeometry().getCoordinates().slice(),
    appearanceRevision: -1,
  });
  return true;
}

function updateMovementButton() {
  $('smooth-movement').setAttribute('aria-checked', String(smoothMovement));
  $('smooth-movement').querySelector('span').textContent = 'Smooth vehicle motion';
  $('smooth-movement').querySelector('.switch-status').firstChild.textContent =
    smoothMovement ? 'On ' : 'Off ';
  $('movement-note').textContent = smoothMovement
    ? `Buffered filtered motion (about ${Math.max(2, intervalSeconds) + DISPLAY_OPTIONS.jitterSeconds}s or more behind live); prediction limits vary by mode.`
    : 'Filtered GPS positions; animated presentation is off.';
}

function setSmoothMovement(enabled) {
  smoothMovement = Boolean(enabled);
  try {
    localStorage.setItem('mbta-smooth-movement', smoothMovement ? 'on' : 'off');
  } catch {}
  paintRevision++;
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

      if (!receiveVehiclePosition(feature, { ...attributes, _routeId: routeId })) {
        // A cached timestamp is normal when polling faster than the feed updates.
        if (feature.get('trackingStatus') === 'duplicate-or-old') validReports++;
        continue;
      }
      feature.setProperties({
        ...attributes,
        kind: 'vehicle',
        name: attributes.label ? 'Vehicle ' + attributes.label : 'Vehicle ' + vehicle.id,
        routeId,
        stopId: vehicle.relationships?.stop?.data?.id,
      });
      validReports++;
      if (isNew) vehicleSource.addFeature(feature);
    }

    // Allow brief omissions/partial responses instead of blinking a marker off.
    // Persistently absent vehicles still release all report and Kalman state.
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
        vehicleTrackers.delete(id);
        vehicleDisplays.delete(id);
        drawEntries.delete(id);
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
  updateMovementButton();
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
  refreshGeneration++;
  clearTimeout(refreshTimer);
  nextFetchAt = 0;
  if (!document.hidden && liveEnabled) refreshVehicles();
  updateStatus();
});
// ---- One canvas for vehicle bodies, halos and screen-space picking ----
const haloCanvas = document.createElement('canvas');
haloCanvas.className = 'vehicle-halos';
haloCanvas.setAttribute('aria-hidden', 'true');
// Keep the canvas below OpenLayers popups/controls, with no pointer interception.
map
  .getViewport()
  .insertBefore(haloCanvas, map.getViewport().querySelector('.ol-overlaycontainer'));
const haloContext = haloCanvas.getContext('2d');
const renderingStats = { visible: 0, total: 0, drawMilliseconds: 0 };
let lastAppearanceUpdate = 0;

function drawVehicles(now) {
  const start = performance.now();
  const size = map.getSize();
  if (!size) return;
  const ratio = Math.min(DISPLAY_OPTIONS.pixelRatioCap, devicePixelRatio || 1);
  const width = Math.round(size[0] * ratio),
    height = Math.round(size[1] * ratio);
  if (haloCanvas.width !== width || haloCanvas.height !== height) {
    haloCanvas.width = width;
    haloCanvas.height = height;
  }
  haloContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  haloContext.clearRect(0, 0, size[0], size[1]);
  canvasHits = [];
  renderingStats.total = drawEntries.size;
  if (!vehicleLayer.getVisible()) {
    renderingStats.visible = 0;
    return;
  }
  const extent = map.getView().calculateExtent(size);
  const margin = map.getView().getResolution() * 40;
  const padded = ol.extent.buffer(extent, margin);
  const time = trackingTime();
  const refreshAppearance = now - lastAppearanceUpdate >= 200;
  if (refreshAppearance) lastAppearanceUpdate = now;
  const phase = (1 + Math.sin(now / 650)) / 2;
  const animated = smoothMovement && !reducedMotion.matches;
  // Painting styles are cached and paths batched by color/outline/staleness.
  const groups = new Map();
  for (const entry of drawEntries.values()) {
    if (refreshAppearance || entry.appearanceRevision !== paintRevision) {
      entry.color = visibleColor(entry.feature, 'vehicles');
      const appearance = appearanceFor(routeById.get(entry.feature.get('routeId')));
      entry.outline = appearance.outline || (dark ? '#f2f8fa' : '#fff');
      entry.stale = isStale(entry.feature);
      entry.appearanceRevision = paintRevision;
    }
    if (!entry.color) continue;
    // Historical filtered positions bound the buffered path. Offscreen tracks
    // retain measurements but require no per-frame Kalman/projection work.
    if (
      !ol.extent.intersects(padded, entry.bounds) &&
      !ol.extent.containsCoordinate(padded, entry.coordinate)
    )
      continue;
    const sample = entry.display.sample(time, intervalSeconds, animated, !liveEnabled);
    if (!sample) continue;
    entry.coordinate = ol.proj.fromLonLat(entry.tracker.frame.toLonLat(sample.position));
    entry.heading = sample.heading;
    entry.speedMps = sample.speedMps;
    const pixel = map.getPixelFromCoordinate(entry.coordinate);
    if (
      !pixel ||
      pixel[0] < -12 ||
      pixel[1] < -12 ||
      pixel[0] > size[0] + 12 ||
      pixel[1] > size[1] + 12
    )
      continue;
    canvasHits.push({ feature: entry.feature, pixel });
    const fill = entry.stale ? '#849298' : entry.color;
    const key = `${fill}|${entry.outline}|${entry.stale}`;
    let group = groups.get(key);
    if (!group) {
      group = { fill, outline: entry.outline, stale: entry.stale, pixels: [] };
      groups.set(key, group);
    }
    group.pixels.push(pixel);
  }
  for (const group of groups.values()) {
    if (!reducedMotion.matches && !group.stale) {
      haloContext.beginPath();
      const radius = 5 + phase * 4;
      for (const [x, y] of group.pixels) {
        haloContext.moveTo(x + radius, y);
        haloContext.arc(x, y, radius, 0, Math.PI * 2);
      }
      haloContext.fillStyle = rgba(group.fill, 0.12 + (1 - phase) * 0.1);
      haloContext.fill();
    }
    haloContext.beginPath();
    for (const [x, y] of group.pixels) {
      haloContext.moveTo(x + 3.4, y);
      haloContext.arc(x, y, 3.4, 0, Math.PI * 2);
    }
    haloContext.fillStyle = group.fill;
    haloContext.strokeStyle = group.outline;
    haloContext.lineWidth = 1.2;
    haloContext.fill();
    haloContext.stroke();
  }
  if (popupFeature?.get('kind') === 'vehicle') {
    const entry = drawEntries.get(popupFeature.getId());
    if (entry) popup.setPosition(entry.coordinate);
  }
  renderingStats.visible = canvasHits.length;
  renderingStats.drawMilliseconds = performance.now() - start;
}
function animate(now) {
  requestAnimationFrame(animate);
  if (!document.hidden) drawVehicles(now);
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

/** A snapshot of exactly the enabled layers/routes. A shared stop is emitted
 * once with its visible modes; the analysis can assign one explicit weight.
 */
function getVisibleNetworkSnapshot() {
  const modeKey = (route) =>
    isSilverLine(route)
      ? 'silver'
      : route?.id === 'Mattapan'
        ? 'subway'
        : { 0: 'lightRail', 1: 'subway', 2: 'commuter', 3: 'bus', 4: 'ferry' }[
            route?.attributes.type
          ];
  const lines = [],
    stops = [],
    vehicles = [];
  const enabledKinds = {};
  for (const kind of ['lines', 'stops', 'vehicles']) {
    const layer = { lines: routeLayer, stops: stopLayer, vehicles: vehicleLayer }[kind];
    enabledKinds[kind] =
      layer.getVisible() && [...routeById.keys()].some((id) => visibleRoute(id, kind));
  }
  if (enabledKinds.lines)
    for (const feature of routeSource.getFeatures()) {
      const id = feature.get('routeId');
      if (visibleRoute(id, 'lines'))
        lines.push({
          routeId: id,
          mode: modeKey(routeById.get(id)),
          coordinates: feature
            .getGeometry()
            .getCoordinates()
            .map((point) => ol.proj.toLonLat(point)),
        });
    }
  if (enabledKinds.stops)
    for (const feature of stopSource.getFeatures()) {
      const ids = routeIds(feature).filter((id) => visibleRoute(id, 'stops'));
      if (ids.length)
        stops.push({
          id: String(feature.getId()),
          coordinate: ol.proj.toLonLat(feature.getGeometry().getCoordinates()),
          modes: [...new Set(ids.map((id) => modeKey(routeById.get(id))))],
        });
    }
  let excludedStaleVehicles = 0;
  if (enabledKinds.vehicles)
    for (const feature of vehicleSource.getFeatures()) {
      const id = feature.get('routeId');
      if (!visibleRoute(id, 'vehicles')) continue;
      if (isStale(feature)) {
        excludedStaleVehicles++;
        continue;
      }
      const coordinate =
        drawEntries.get(feature.getId())?.coordinate ||
        feature.getGeometry().getCoordinates();
      vehicles.push({
        id: String(feature.getId()),
        mode: modeKey(routeById.get(id)),
        coordinate: ol.proj.toLonLat(coordinate),
      });
    }
  return {
    lines,
    stops,
    vehicles,
    enabledKinds,
    capturedAt: new Date().toISOString(),
    excludedStaleVehicles,
    loadedRoutes: loaded,
    totalRoutes: routeById.size,
  };
}

// Public integration context for your custom tools. Existing MBTA layers remain separate.
export const interactionContext = {
  getVisibleNetworkSnapshot,
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
  // Returns a defensive snapshot: local ENU meters, filtered lon/lat, velocity,
  // heading (degrees clockwise from local ENU north), covariance and gating diagnostics.
  getDisplayedVehicle: (id) => {
    const entry = drawEntries.get(String(id));
    if (!entry) return null;
    return {
      lonLat: ol.proj.toLonLat(entry.coordinate),
      heading: entry.heading,
      speedMps: entry.speedMps,
      profile: entry.profileName,
      delaySeconds: entry.display.last?.delaySeconds || 0,
      kind: entry.display.last?.kind || 'initializing',
    };
  },
  getVehicleRenderStats: () => ({ ...renderingStats }),
  getVehicleTrack: (id) => {
    const tracker = vehicleTrackers.get(String(id));
    if (!tracker) return null;
    return {
      ...tracker.sample(trackingTime(), smoothMovement && !reducedMotion.matches),
      diagnostics: { ...tracker.diagnostics },
    };
  },
};
