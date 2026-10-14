// Massachusetts center coordinates (longitude, latitude)
const massCenter = [139.77, 35.68];
// const massCenter = [-11000000, 5000000];

const CSV_URL = './data/output.csv';
const GEOJSON_URL = './data/US_Court_pop_4326.geojson'


let animationTimer = null;

let csvRows = [];
let monthlyLookup = {};
let featureAliasMap = new ol.Map();

let yearMonthKeys = [];

// // WKT rectangle
// const wkt = 'POLYGON((139.75 36.0, 140.5 36.0, 140.5 35.5, 139.75 35.5, 139.75 36.0))';
// const format = new ol.format.WKT();
// const feature = format.readFeature(wkt, {
//     dataProjection: 'EPSG:4326',
//     featureProjection: 'EPSG:3857'
// });
const baseColors5 = [
  '#f7fbff',
  '#c6dbef',
  '#6baed6',
  '#2171b5',
  '#08306b'
];

// for chart

let selectedFeature = null;
let playbackHistory = [];
let playbackStartIndex = null;

const trendCanvas = document.getElementById('trendChart');
const compositionCanvas = document.getElementById('compositionChart');
const chartTitle = document.getElementById('chartTitle');

// set hover show info
let hoveredFeature = null;
let hoverEnabled = true;
const hoverLabel = document.getElementById('hoverLabel');

// for about
const aboutPanel = document.getElementById('aboutPanel');
const aboutHeader = document.getElementById('aboutHeader');
const aboutToggle = document.getElementById('aboutToggle');

// add listeners
// document.getElementById('fieldSelect').addEventListener('change', applyClassification);
document.getElementById('classCount').addEventListener('change', stopAnimationAndApply);
//  add listener for new palette selector
document.getElementById('paletteSelect').addEventListener('change', stopAnimationAndApply);

document.getElementById('yearSelect').addEventListener('change', function () {
  rebuildMonthSelect();
  stopAnimationAndApply();
});

document.getElementById('monthSelect').addEventListener('change', stopAnimationAndApply);
document.getElementById('debtorTypeSelect').addEventListener('change', stopAnimationAndApply);
document.getElementById('chapterSelect').addEventListener('change', stopAnimationAndApply);
document.getElementById('metricSelect').addEventListener('change', stopAnimationAndApply);


// change composition chart color
function getCompositionColors() {
  return {
    B7:   '#3Bcfd4',
    B11:  '#58cc9a',
    B13:  '#84c95f',
    BOTH: '#b9b737',

    N7:   '#fc9305',
    N11:  '#fa7a2a',
    N13:  '#f44767',
    NOTH: '#f20094',

    A9:   '#7a7a7a',
    A12:  '#9a9a9a',
    A15:  '#b5b5b5'
  };
}

// csv parser
function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  result.push(current);
  return result;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);

  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    const row = {};

    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }

    rows.push(row);
  }

  return rows;
}

// add chart helper
function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// calculate rank for month
function getRankForMonth(targetFeature, ym) {
  const values = vectorSource.getFeatures().map(feature => {
    return {
      feature: feature,
      value: getMetricValueForMonth(feature, ym)
    };
  });

  const valid = values.filter(d => Number.isFinite(d.value));
  valid.sort((a, b) => b.value - a.value);

  for (let i = 0; i < valid.length; i++) {
    if (valid[i].feature === targetFeature) {
      return i + 1;
    }
  }

  return null;
}

// add helper to compute metric for any month
function getMetricValueForMonth(feature, ym) {
  const debtorType = document.getElementById('debtorTypeSelect').value;
  const chapter = document.getElementById('chapterSelect').value;
  const metric = document.getElementById('metricSelect').value;

  const initial = feature.get('Initial');
  const currentRows = monthlyLookup[initial] ? monthlyLookup[initial][ym] : null;
  const currentCases = getCasesFromRows(currentRows, debtorType, chapter);

  const population = Number(feature.get('Population')) || null;
  const households = Number(feature.get('1101C11E_s')) || null;
  const laborForce = Number(feature.get('LaborForce')) || null;
  const unemployed = Number(feature.get('Unemployed')) || null;
  const pop16over = Number(feature.get('2301C11E_s')) || null;
  const aggIncome = Number(feature.get('B19025_1E_')) || null;

  if (metric === 'cases') return currentCases;

  if (metric === 'per100pop') {
    if (!population || population === 0) return null;
    return currentCases / population * 100;
  }

  if (metric === 'per100hh') {
    if (!households || households === 0) return null;
    return currentCases / households * 100;
  }

  if (metric === 'per100labor') {
    if (!laborForce || laborForce === 0) return null;
    return currentCases / laborForce * 100;
  }

  if (metric === 'per100unemp') {
    if (!unemployed || unemployed === 0) return null;
    return currentCases / unemployed * 100;
  }

  if (metric === 'per100pop16') {
    if (!pop16over || pop16over === 0) return null;
    return currentCases / pop16over * 100;
  }

  if (metric === 'perIncomeBillion') {
    if (!aggIncome || aggIncome === 0) return null;
    return currentCases / aggIncome * 1000000000;
  }

  if (metric === 'share') {
    const totalAllCases = getCasesFromRows(currentRows, 'all', 'all');
    if (!totalAllCases || totalAllCases === 0) return null;
    return currentCases / totalAllCases;
  }

  const parts = ym.split('-');
  const year = parts[0];
  const month = parts[1];

  const prevMonthObj = getPreviousMonth(year, month);
  const prevYm = prevMonthObj.year + '-' + prevMonthObj.month;
  const prevRows = monthlyLookup[initial] ? monthlyLookup[initial][prevYm] : null;
  const prevCases = getCasesFromRows(prevRows, debtorType, chapter);

  if (metric === 'momAbs') return currentCases - prevCases;
  if (metric === 'momPct') {
    if (!prevCases || prevCases === 0) return null;
    return (currentCases - prevCases) / prevCases * 100;
  }

  const prevYearObj = getPreviousYearSameMonth(year, month);
  const prevYearYm = prevYearObj.year + '-' + prevYearObj.month;
  const prevYearRows = monthlyLookup[initial] ? monthlyLookup[initial][prevYearYm] : null;
  const prevYearCases = getCasesFromRows(prevYearRows, debtorType, chapter);

  if (metric === 'yoyAbs') return currentCases - prevYearCases;
  if (metric === 'yoyPct') {
    if (!prevYearCases || prevYearCases === 0) return null;
    return (currentCases - prevYearCases) / prevYearCases * 100;
  }

  return currentCases;
}

// add composition calculation for current month
function getCurrentComposition(feature) {
  const year = document.getElementById('yearSelect').value;
  const month = document.getElementById('monthSelect').value;
  const ym = year + '-' + month;

  const initial = feature.get('Initial');
  const rows = monthlyLookup[initial] ? monthlyLookup[initial][ym] : null;

  const parts = [
    { key: 'B7',   label: 'B7',    value: getCasesFromRows(rows, 'business', '7') },
    { key: 'B11',  label: 'B11',   value: getCasesFromRows(rows, 'business', '11') },
    { key: 'B13',  label: 'B13',   value: getCasesFromRows(rows, 'business', '13') },
    { key: 'BOTH', label: 'B Oth', value: getCasesFromRows(rows, 'business', 'OTH') },

    { key: 'N7',   label: 'N7',    value: getCasesFromRows(rows, 'nonbusiness', '7') },
    { key: 'N11',  label: 'N11',   value: getCasesFromRows(rows, 'nonbusiness', '11') },
    { key: 'N13',  label: 'N13',   value: getCasesFromRows(rows, 'nonbusiness', '13') },
    { key: 'NOTH', label: 'N Oth', value: getCasesFromRows(rows, 'nonbusiness', 'OTH') },

    { key: 'A9',   label: 'A9',    value: getCasesFromRows(rows, 'all', '9') },
    { key: 'A12',  label: 'A12',   value: getCasesFromRows(rows, 'all', '12') },
    { key: 'A15',  label: 'A15',   value: getCasesFromRows(rows, 'all', '15') }
  ];

  // IMPORTANT: use only displayed parts as denominator
  const displayedTotal = parts.reduce((sum, p) => sum + (Number(p.value) || 0), 0);

  parts.forEach(p => {
    p.share = displayedTotal > 0 ? p.value / displayedTotal : 0;
  });

  return {
    total: displayedTotal,
    parts: parts
  };
}

// add trend chart drawing
function drawTrendChart() {
  clearCanvas(trendCanvas);
  const ctx = trendCanvas.getContext('2d');

  if (!selectedFeature) {
    ctx.fillStyle = '#666';
    ctx.font = '12px Arial';
    ctx.fillText('No district selected', 10, 20);
    return;
  }

  // Use full history instead of only playbackHistory
  const fullSeries = yearMonthKeys.map(ym => {
    return {
      ym: ym,
      value: getMetricValueForMonth(selectedFeature, ym),
      rank: getRankForMonth(selectedFeature, ym)
    };
  });

  const valid = fullSeries.filter(d => Number.isFinite(d.value));
  if (!valid.length) {
    ctx.fillStyle = '#666';
    ctx.font = '12px Arial';
    ctx.fillText('No valid values yet', 10, 20);
    return;
  }

  const width = trendCanvas.width;
  const height = trendCanvas.height;
  const padL = 42;
  const padR = 14;
  const padT = 24;
  const padB = 26;

  const minVal = Math.min(...valid.map(d => d.value));
  const maxVal = Math.max(...valid.map(d => d.value));
  const range = (maxVal - minVal) || 1;

  // axes
  ctx.strokeStyle = '#b5b5b5';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, height - padB);
  ctx.lineTo(width - padR, height - padB);
  ctx.stroke();

  // line
  ctx.strokeStyle = '#2171b5';
  ctx.lineWidth = 2;
  ctx.beginPath();

  valid.forEach((d, i) => {
    const x = padL + (i / Math.max(valid.length - 1, 1)) * (width - padL - padR);
    const y = height - padB - ((d.value - minVal) / range) * (height - padT - padB);

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.stroke();

  // highlight current month if present
  const currentYm =
    document.getElementById('yearSelect').value + '-' +
    document.getElementById('monthSelect').value;

  const currentIndex = valid.findIndex(d => d.ym === currentYm);
  if (currentIndex >= 0) {
    const d = valid[currentIndex];
    const x = padL + (currentIndex / Math.max(valid.length - 1, 1)) * (width - padL - padR);
    const y = height - padB - ((d.value - minVal) / range) * (height - padT - padB);

    ctx.fillStyle = '#f20094';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // labels
  ctx.fillStyle = '#111';
  ctx.font = '11px Arial';
  ctx.fillText(minVal.toFixed(2), 2, height - padB);
  ctx.fillText(maxVal.toFixed(2), 2, padT + 4);

  const firstLabel = valid[0].ym;
  const lastLabel = valid[valid.length - 1].ym;
  ctx.fillText(firstLabel, padL, height - 6);
  ctx.fillText(lastLabel, width - padR - 44, height - 6);

  const currentRank = getRankForMonth(selectedFeature, currentYm);
  if (currentRank != null) {
    ctx.fillStyle = '#666';
    ctx.font = '12px Arial';
    ctx.fillText(`Rank: ${currentRank} / 93`, width - 95, 16);
  }
}

// add composition chart drawing
function getSelectedCompositionKey() {
  const debtorType = document.getElementById('debtorTypeSelect').value;
  const chapter = document.getElementById('chapterSelect').value;

  if (debtorType === 'all' || chapter === 'all') return null;
  if (debtorType === 'business') return 'B' + chapter;
  if (debtorType === 'nonbusiness') return 'N' + chapter;
  return null;
}

function drawCompositionChart() {
  clearCanvas(compositionCanvas);
  const ctx = compositionCanvas.getContext('2d');

  if (!selectedFeature) {
    ctx.fillStyle = '#666';
    ctx.font = '12px Arial';
    ctx.fillText('No district selected', 10, 20);
    return;
  }

  const comp = getCurrentComposition(selectedFeature);
  const parts = comp.parts;
  const selectedKey = getSelectedCompositionKey();
  const colorMap = getCompositionColors();

  const width = compositionCanvas.width;

  const barX = 10;
  const barY = 34;
  const barW = width - 20;

  const normalH = 18;
  const selectedH = 34;

  let currentX = barX;

  ctx.fillStyle = '#111';
  ctx.font = '12px Arial';
  ctx.fillText('Current-month composition', 10, 15);

  parts.forEach(part => {
    if (part.share <= 0) return;

    const segW = Math.max(1, barW * part.share);
    const baseColor = colorMap[part.key] || '#999';

    const isSelected = part.key === selectedKey;
    const segH = isSelected ? selectedH : normalH;
    const segY = isSelected ? barY - (selectedH - normalH) : barY;

    ctx.fillStyle = baseColor;
    ctx.fillRect(currentX, segY, segW, segH);

    ctx.strokeStyle = isSelected ? '#666' : '#d0d0d0';
    ctx.lineWidth = isSelected ? 1.5 : 0.8;
    ctx.strokeRect(currentX, segY, segW, segH);

    currentX += segW;
  });

  // legend text below
  let y = 82;
  parts.forEach(part => {
    if (part.share <= 0) return;

    const baseColor = colorMap[part.key] || '#999';
    const isSelected = part.key === selectedKey;

    ctx.fillStyle = baseColor;
    ctx.fillRect(10, y - 9, 10, 10);

    ctx.strokeStyle = isSelected ? '#666' : '#d0d0d0';
    ctx.lineWidth = isSelected ? 1.2 : 0.6;
    ctx.strokeRect(10, y - 9, 10, 10);

    ctx.fillStyle = '#111';
    ctx.font = isSelected ? 'bold 12px Arial' : '12px Arial';
    ctx.fillText(`${part.label}: ${(part.share * 100).toFixed(1)}%`, 26, y);

    y += 14;
  });
}
function resetPlaybackHistory() {
  playbackHistory = [];
  playbackStartIndex = yearMonthKeys.indexOf(
    document.getElementById('yearSelect').value + '-' +
    document.getElementById('monthSelect').value
  );
}

function appendPlaybackPoint() {
  if (!selectedFeature) return;

  const ym = document.getElementById('yearSelect').value + '-' +
             document.getElementById('monthSelect').value;

  const value = getMetricValue(selectedFeature);
  const rank = getRankForMonth(selectedFeature, ym);

  playbackHistory.push({
    ym: ym,
    value: value,
    rank: rank
  });

  drawTrendChart();
}

// patch click behavior

// connect geojson
function normalizeText(v) {
  return String(v || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\./g, '')
    .trim();
}

function buildFeatureAliasMap() {
  featureAliasMap = new ol.Map();

  vectorSource.getFeatures().forEach(feature => {
    const aliases = new Set();

    const initial = feature.get('Initial');
    const name = feature.get('NAME');

    if (initial) aliases.add(normalizeText(initial));
    if (name) aliases.add(normalizeText(name));

    aliases.forEach(a => {
      featureAliasMap.set(a, feature);
    });
  });
}

function getFeatureFromDistrictValue(districtValue) {
  return featureAliasMap.get(normalizeText(districtValue)) || null;
}

// add a monthly lookup builder
function makeYearMonth(row) {
  const y = String(row.year).trim();
  const m = String(row.month).trim().padStart(2, '0');
  return `${y}-${m}`;
}

function buildMonthlyLookup(rows) {
  monthlyLookup = {};
  yearMonthKeys = [];

  const ymSeen = {};

  rows.forEach(row => {
    const feature = getFeatureFromDistrictValue(row.district);
    if (!feature) return;

    const initial = feature.get('Initial');
    const ym = makeYearMonth(row);

    if (!monthlyLookup[initial]) monthlyLookup[initial] = {};
    if (!monthlyLookup[initial][ym]) monthlyLookup[initial][ym] = [];

    monthlyLookup[initial][ym].push(row);

    if (!ymSeen[ym]) {
      ymSeen[ym] = true;
      yearMonthKeys.push(ym);
    }
  });
  yearMonthKeys.sort();
}
function initializeTimeSlider() {
  const slider = document.getElementById('timeSlider');
  const label = document.getElementById('timeLabel');

  slider.min = 0;
  slider.max = Math.max(0, yearMonthKeys.length - 1);
  slider.value = 0;

  if (yearMonthKeys.length > 0) {
    label.textContent = yearMonthKeys[0];
  }
}
// function to move to next month
function stepMonthForward() {
  const current = document.getElementById('yearSelect').value + '-' +
                  document.getElementById('monthSelect').value;

  const idx = yearMonthKeys.indexOf(current);
  if (idx < 0) return;

  const nextIndex = idx + 1;

  if (nextIndex >= yearMonthKeys.length) {
    stopAnimation();
    return;
  }

  const next = yearMonthKeys[(idx + 1) % yearMonthKeys.length];
  const parts = next.split('-');
  const nextYear = parts[0];
  const nextMonth = parts[1];

  document.getElementById('yearSelect').value = nextYear;
  rebuildMonthSelect();
  document.getElementById('monthSelect').value = nextMonth;

  applyClassification();
}

// add a stop function
function stopAnimation() {
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }

  document.getElementById('playToggle').textContent = 'Play';
}

// add play/pause button logic
document.getElementById('playToggle').addEventListener('click', function () {
  if (animationTimer) {
    stopAnimation();
    return;
  }

  const current = document.getElementById('yearSelect').value + '-' +
                  document.getElementById('monthSelect').value;
  const idx = yearMonthKeys.indexOf(current);

  if (idx === yearMonthKeys.length - 1 && yearMonthKeys.length > 0) {
    const first = yearMonthKeys[0].split('-');
    document.getElementById('yearSelect').value = first[0];
    rebuildMonthSelect();
    document.getElementById('monthSelect').value = first[1];
    applyClassification();
  }

  // for chart?
  resetPlaybackHistory();
  appendPlaybackPoint();


  this.textContent = 'Pause';

  const speed = Number(document.getElementById('speedSelect').value) || 1000;

  animationTimer = setInterval(function () {
    stepMonthForward();
    appendPlaybackPoint();
    drawCompositionChart();
  }, speed);
  // }, 1000); // 1 second per month
});

// slider control map
document.getElementById('timeSlider').addEventListener('input', function () {
  stopAnimation();

  const idx = Number(this.value);
  const ym = yearMonthKeys[idx];
  if (!ym) return;

  const parts = ym.split('-');
  const y = parts[0];
  const m = parts[1];

  document.getElementById('yearSelect').value = y;
  rebuildMonthSelect();
  document.getElementById('monthSelect').value = m;
  document.getElementById('timeLabel').textContent = ym;

  applyClassification();
});

// stop animation when user chagnes control manually
function stopAnimationAndApply() {
  stopAnimation();
  applyClassification();
}

// add helper to sync slider from current year/month
function syncSliderToCurrentMonth() {
  const current = document.getElementById('yearSelect').value + '-' +
                  document.getElementById('monthSelect').value;

  const idx = yearMonthKeys.indexOf(current);
  const slider = document.getElementById('timeSlider');
  const label = document.getElementById('timeLabel');

  if (idx >= 0) {
    slider.value = idx;
    label.textContent = current;
  }
}

// populate year and month selectors
function populateYearMonthControls() {
  const years = [];
  const seenYears = {};

  yearMonthKeys.forEach(ym => {
    const y = ym.split('-')[0];
    if (!seenYears[y]) {
      seenYears[y] = true;
      years.push(y);
    }
  });

  const yearSelect = document.getElementById('yearSelect');
  yearSelect.innerHTML = '';

  years.forEach(y => {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    yearSelect.appendChild(opt);
  });

  if (years.length) {
    yearSelect.value = years[years.length - 1];
  }

  rebuildMonthSelect();
}

function rebuildMonthSelect() {
  const yearSelect = document.getElementById('yearSelect');
  const monthSelect = document.getElementById('monthSelect');

  const selectedYear = yearSelect.value;
  monthSelect.innerHTML = '';

  yearMonthKeys.forEach(ym => {
    const parts = ym.split('-');
    const y = parts[0];
    const m = parts[1];

    if (y === selectedYear) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      monthSelect.appendChild(opt);
    }
  });
}

// csv loader
async function loadMonthlyCsv() {
  const text = await fetch(CSV_URL).then(r => r.text());
  csvRows = parseCsv(text);
  buildMonthlyLookup(csvRows);

  console.log('CSV rows loaded:', csvRows.length);
  console.log('Random CSV rows:', csvRows[Math.floor(Math.random() * csvRows.length)])
  console.log('Monthly lookup sample:', monthlyLookup);
  // test connection
  testMonthlyConnection();
  populateYearMonthControls();
  initializeTimeSlider();
}

// add record summarizer
function normalizeDebtorType(v) {
  const s = String(v || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (s.includes('non')) return 'nonbusiness';
  if (s.includes('business')) return 'business';
  return 'unknown';
}

function normalizeChapter(v) {
  const s = String(v || '').toLowerCase().trim();

  if (s === '7' || s.includes('chapter 7')) return '7';
  if (s === '9' || s.includes('chapter 9')) return '9';
  if (s === '11' || s.includes('chapter 11')) return '11';
  if (s === '12' || s.includes('chapter 12')) return '12';
  if (s === '13' || s.includes('chapter 13')) return '13';
  if (s === '15' || s.includes('chapter 15')) return '15';

  return 'OTH';
}

function getCasesFromRows(rows, debtorType, chapter) {
  if (!rows || !rows.length) return 0;

  let total = 0;

  rows.forEach(row => {
    const rowType = normalizeDebtorType(row.debtor_type);
    const rowChapter = normalizeChapter(row.chapter);
    const cases = Number(row.cases) || 0;

    const typeMatch = debtorType === 'all' || rowType === debtorType;
    const chapterMatch = chapter === 'all' || rowChapter === chapter;

    if (typeMatch && chapterMatch) {
      total += cases;
    }
  });

  return total;
}

// //  add current selection to features
// function updateSelectedCasesToFeatures() {
//   const year = document.getElementById('yearSelect').value;
//   const month = document.getElementById('monthSelect').value;
//   const debtorType = document.getElementById('debtorTypeSelect').value;
//   const chapter = document.getElementById('chapterSelect').value;

//   const ym = year + '-' + month;

//   vectorSource.getFeatures().forEach(feature => {
//     const initial = feature.get('Initial');
//     const rows = monthlyLookup[initial] ? monthlyLookup[initial][ym] : null;
//     const value = getCasesFromRows(rows, debtorType, chapter);
//     feature.set('__displayValue', value);
//   });
// }
function updateSelectedValueToFeatures() {
  vectorSource.getFeatures().forEach(feature => {
    const value = getMetricValue(feature);
    feature.set('__displayValue', value);
  });
}

// get from past month
function getPreviousMonth(year, month) {
  let y = Number(year);
  let m = Number(month);

  m = m - 1;
  if (m < 1) {
    m = 12;
    y = y - 1;
  }

  return {
    year: String(y),
    month: String(m).padStart(2, '0')
  };
}
function getPreviousYearSameMonth(year, month) {
  return {
    year: String(Number(year) - 1),
    month: String(month).padStart(2, '0')
  };
}
function getMetricValue(feature) {
  const year = document.getElementById('yearSelect').value;
  const month = document.getElementById('monthSelect').value;
  const debtorType = document.getElementById('debtorTypeSelect').value;
  const chapter = document.getElementById('chapterSelect').value;
  const metric = document.getElementById('metricSelect').value;

  const initial = feature.get('Initial');
  const ym = year + '-' + month;

  const currentRows = monthlyLookup[initial] ? monthlyLookup[initial][ym] : null;
  const currentCases = getCasesFromRows(currentRows, debtorType, chapter);

  const population = Number(feature.get('Population')) || null;
  const households = Number(feature.get('1101C11E_s')) || null;
  const laborForce = Number(feature.get('LaborForce')) || null;
  const unemployed = Number(feature.get('Unemployed')) || null;
  const pop16over = Number(feature.get('2301C11E_s')) || null;
  const aggIncome = Number(feature.get('B19025_1E_')) || null;

  if (metric === 'cases') {
    return currentCases;
  }

  if (metric === 'per100pop') {
    if (!population || population === 0) return null;
    return currentCases / population * 100;
  }

  if (metric === 'per100hh') {
    if (!households || households === 0) return null;
    return currentCases / households * 100;
  }

  if (metric === 'per100labor') {
    if (!laborForce || laborForce === 0) return null;
    return currentCases / laborForce * 100;
  }

  if (metric === 'per100unemp') {
    if (!unemployed || unemployed === 0) return null;
    return currentCases / unemployed * 100;
  }

  if (metric === 'per100pop16') {
    if (!pop16over || pop16over === 0) return null;
    return currentCases / pop16over * 100;
  }

  if (metric === 'perIncomeBillion') {
    if (!aggIncome || aggIncome === 0) return null;
    return currentCases / aggIncome * 1000000000;
  }

  if (metric === 'share') {
    const totalAllCases = getCasesFromRows(currentRows, 'all', 'all');
    if (!totalAllCases || totalAllCases === 0) return null;
    return currentCases / totalAllCases;
  }

  const prevMonthObj = getPreviousMonth(year, month);
  const prevYm = prevMonthObj.year + '-' + prevMonthObj.month;
  const prevRows = monthlyLookup[initial] ? monthlyLookup[initial][prevYm] : null;
  const prevCases = getCasesFromRows(prevRows, debtorType, chapter);

  if (metric === 'momAbs') {
    return currentCases - prevCases;
  }

  if (metric === 'momPct') {
    if (!prevCases || prevCases === 0) return null;
    return (currentCases - prevCases) / prevCases * 100;
  }

  const prevYearObj = getPreviousYearSameMonth(year, month);
  const prevYearYm = prevYearObj.year + '-' + prevYearObj.month;
  const prevYearRows = monthlyLookup[initial] ? monthlyLookup[initial][prevYearYm] : null;
  const prevYearCases = getCasesFromRows(prevYearRows, debtorType, chapter);

  if (metric === 'yoyAbs') {
    return currentCases - prevYearCases;
  }

  if (metric === 'yoyPct') {
    if (!prevYearCases || prevYearCases === 0) return null;
    return (currentCases - prevYearCases) / prevYearCases * 100;
  }

  return currentCases;
}

// expands any class count 3–7 from a light→dark ramp
function getColorRamp(n, paletteName = 'turquoisePink') {
  const palettes  ={ 
    turquoisePink: {
      3: ['#3Bcfd4', '#fc9305', '#f20094'],
      4: ['#3Bcfd4', '#9cc047', '#fc9305', '#f20094'],
      5: ['#3Bcfd4', '#6cc881', '#fc9305', '#f85f4d', '#f20094'],
      6: ['#3Bcfd4', '#58cc9a', '#b9b737', '#fc9305', '#f85f4d', '#f20094'],
      7: ['#3Bcfd4', '#4fcdae', '#84c95f', '#fc9305', '#fa7a2a', '#f44767', '#f20094']
    },
    greenYellowRed: {
      3: ['#2A8D08', '#F2E713', '#F91E07'],
      4: ['#2A8D08', '#97bf10', '#F2E713', '#F91E07'],
      5: ['#2A8D08', '#6ea60c', '#F2E713', '#f59b0e', '#F91E07'],
      6: ['#2A8D08', '#54990a', '#b8ce11', '#F2E713', '#f59b0e', '#F91E07'],
      7: ['#2A8D08', '#438f09', '#7fb20d', '#F2E713', '#f7bc11', '#f47a0c', '#F91E07']
    },
    purpleRoseOrange: {
      3: ['#832388', '#E3436B', '#F17C2E'],
      4: ['#832388', '#b4337a', '#E3436B', '#F17C2E'],
      5: ['#832388', '#a62d80', '#E3436B', '#ea614d', '#F17C2E'],
      6: ['#832388', '#962a83', '#c53a76', '#E3436B', '#ea614d', '#F17C2E'],
      7: ['#832388', '#912985', '#af317d', '#E3436B', '#e8535c', '#ed6847', '#F17C2E']
    }
  };
  const selectedPalette = palettes[paletteName] || palettes.turquoisePink;
  return selectedPalette[n] || selectedPalette[5];
}

function getNameOfData(n){
    const ramps = {
        'ALL_24': 'All chapters total, 2024',
        'ALL_25': 'All chapters total, 2025',
        'A7_24': 'Chapter 7 total, 2024',
        'A7_25': 'Chapter 7 total, 2025',
        'A11_24': 'Chapter 11 total, 2024',
        'A11_25': 'Chapter 11 total, 2025',
        'A13_24': 'Chapter 13 total, 2024',
        'A13_25': 'Chapter 13 total, 2025',
        'AOTH24': 'Other chapters total, 2024',
        'AOTH25': 'Other chapters total, 2025',
        'A9_24': 'Chapter 9 total, 2024',
        'A9_25': 'Chapter 9 total, 2025',
        'A12_24': 'Chapter 12 total, 2024',
        'A12_25': 'Chapter 12 total, 2025',
        'A15_24': 'Chapter 15 total, 2024',
        'A15_25': 'Chapter 15 total, 2025',
        
        'BALL24': 'Business all chapters total, 2024',
        'BALL25': 'Business all chapters total, 2025',
        'B7_24': 'Business Chapter 7, 2024',
        'B7_25': 'Business Chapter 7, 2025',
        'B11_24': 'Business Chapter 11, 2024',
        'B11_25': 'Business Chapter 11, 2025',
        'B13_24': 'Business Chapter 13, 2024',
        'B13_25': 'Business Chapter 13, 2025',
        'BOTH24': 'Business other chapters total, 2024',
        'BOTH25': 'Business other chapters total, 2025',

        'NALL24': 'Nonbusiness all chapters total, 2024',
        'NALL25': 'Nonbusiness all chapters total, 2025',
        'N7_24': 'Nonbusiness Chapter 7, 2024',
        'N7_25': 'Nonbusiness Chapter 7, 2025',
        'N11_24': 'Nonbusiness Chapter 11, 2024',
        'N11_25': 'Nonbusiness Chapter 11, 2025',
        'N13_24': 'Nonbusiness Chapter 13, 2024',
        'N13_25': 'Nonbusiness Chapter 13, 2025',
        'NOTH24': 'Nonbusiness other chapters total, 2024',
        'NOTH25': 'Nonbusiness other chapters total, 2025',

        'A7SH24': 'Chapter 7 share of ALL_24',
        'A7SH25': 'Chapter 7 share of ALL_25',
        'A11SH24': 'Chapter 11 share of ALL_24',
        'A11SH25': 'Chapter 11 share of ALL_25',
        'A13SH24': 'Chapter 13 share of ALL_24',
        'A13SH25': 'Chapter 13 share of ALL_25',
        'AOTH24S': 'Other chapters share of ALL_24',
        'AOTH25S': 'Other chapters share of ALL_25',
        'A9SH24': 'Chapter 9 share of ALL_24',
        'A9SH25': 'Chapter 9 share of ALL_25',
        'A12SH24': 'Chapter 12 share of ALL_24',
        'A12SH25': 'Chapter 12 share of ALL_25',
        'A15SH24': 'Chapter 15 share of ALL_24',
        'A15SH25': 'Chapter 15 share of ALL_25',
        'B7SH24': 'Business Chapter 7 share of BALL24',
        'B7SH25': 'Business Chapter 7 share of BALL25',
        'B11SH24': 'Business Chapter 11 share of BALL24',
        'B11SH25': 'Business Chapter 11 share of BALL25',
        'B13SH24': 'Business Chapter 13 share of BALL24',
        'B13SH25': 'Business Chapter 13 share of BALL25',
        'BOTH24S': 'Business other chapters share of BALL24',
        'BOTH25S': 'Business other chapters share of BALL25',
        'N7SH24': 'Nonbusiness Chapter 7 share of NALL24',
        'N7SH25': 'Nonbusiness Chapter 7 share of NALL25',
        'N11SH24': 'Nonbusiness Chapter 11 share of NALL24',
        'N11SH25': 'Nonbusiness Chapter 11 share of NALL25',
        'N13SH24': 'Nonbusiness Chapter 13 share of NALL24',
        'N13SH25': 'Nonbusiness Chapter 13 share of NALL25',
        'NOTH24S': 'Nonbusiness other chapters share of NALL24',
        'NOTH25S': 'Nonbusiness other chapters share of NALL25',

        'ALLPC24': 'All chapters per 100 population, 2024',
        'ALLPC25': 'All chapters per 100 population, 2025',
        'A7PC24': 'Chapter 7 per 100 population, 2024',
        'A7PC25': 'Chapter 7 per 100 population, 2025',
        'A11PC24': 'Chapter 11 per 100 population, 2024',
        'A11PC25': 'Chapter 11 per 100 population, 2025',
        'A13PC24': 'Chapter 13 per 100 population, 2024',
        'A13PC25': 'Chapter 13 per 100 population, 2025',
        'AOTHPC24': 'Other chapters per 100 population, 2024',
        'AOTHPC25': 'Other chapters per 100 population, 2025',
        'A9PC24': 'Chapter 9 per 100 population, 2024',
        'A9PC25': 'Chapter 9 per 100 population, 2025',
        'A12PC24': 'Chapter 12 per 100 population, 2024',
        'A12PC25': 'Chapter 12 per 100 population, 2025',
        'A15PC24': 'Chapter 15 per 100 population, 2024',
        'A15PC25': 'Chapter 15 per 100 population, 2025',
        'BALLPC24': 'Business all chapters per 100 population, 2024',
        'BALLPC25': 'Business all chapters per 100 population, 2025',
        'B7PC24': 'Business Chapter 7 per 100 population, 2024',
        'B7PC25': 'Business Chapter 7 per 100 population, 2025',
        'B11PC24': 'Business Chapter 11 per 100 population, 2024',
        'B11PC25': 'Business Chapter 11 per 100 population, 2025',
        'B13PC24': 'Business Chapter 13 per 100 population, 2024',
        'B13PC25': 'Business Chapter 13 per 100 population, 2025',
        'BOTHPC24': 'Business other chapters per 100 population, 2024',
        'BOTHPC25': 'Business other chapters per 100 population, 2025',
        'NALLPC24': 'Nonbusiness all chapters per 100 population, 2024',
        'NALLPC25': 'Nonbusiness all chapters per 100 population, 2025',
        'N7PC24': 'Nonbusiness Chapter 7 per 100 population, 2024',
        'N7PC25': 'Nonbusiness Chapter 7 per 100 population, 2025',
        'N11PC24': 'Nonbusiness Chapter 11 per 100 population, 2024',
        'N11PC25': 'Nonbusiness Chapter 11 per 100 population, 2025',
        'N13PC24': 'Nonbusiness Chapter 13 per 100 population, 2024',
        'N13PC25': 'Nonbusiness Chapter 13 per 100 population, 2025',
        'NOTHPC24': 'Nonbusiness other chapters per 100 population, 2024',
        'NOTHPC25': 'Nonbusiness other chapters per 100 population, 2025',

        'ALLACHG': 'Absolute change in all chapters total',
        'A7ACHG': 'Absolute change in Chapter 7',
        'A11ACHG': 'Absolute change in Chapter 11',
        'A13ACHG': 'Absolute change in Chapter 13',
        'AOTHCHG': 'Absolute change in other chapters total',
        'A9ACHG': 'Absolute change in Chapter 9',
        'A12ACHG': 'Absolute change in Chapter 12',
        'A15ACHG': 'Absolute change in Chapter 15',
        'BALLCHG': 'Absolute change in business all chapters total',
        'B7ACHG': 'Absolute change in business Chapter 7',
        'B11ACHG': 'Absolute change in business Chapter 11',
        'B13ACHG': 'Absolute change in business Chapter 13',
        'BOTHCHG': 'Absolute change in business other chapters total',
        'NALLCHG': 'Absolute change in nonbusiness all chapters total',
        'N7ACHG': 'Absolute change in nonbusiness Chapter 7',
        'N11ACHG': 'Absolute change in nonbusiness Chapter 11',
        'N13ACHG': 'Absolute change in nonbusiness Chapter 13',
        'NOTHCHG': 'Absolute change in nonbusiness other chapters total',

        'ALLPCHG': 'Percent change in all chapters total',
        'A7PCHG': 'Percent change in Chapter 7',
        'A11PCHG': 'Percent change in Chapter 11',
        'A13PCHG': 'Percent change in Chapter 13',
        'AOTHPCHG': 'Percent change in other chapters total',
        'A9PCHG': 'Percent change in Chapter 9',
        'A12PCHG': 'Percent change in Chapter 12',
        'A15PCHG': 'Percent change in Chapter 15',
        'BALLPCHG': 'Percent change in business all chapters total',
        'B7PCHG': 'Percent change in business Chapter 7',
        'B11PCHG': 'Percent change in business Chapter 11',
        'B13PCHG': 'Percent change in business Chapter 13',
        'BOTHPCHG': 'Percent change in business other chapters total',
        'NALLPCHG': 'Percent change in nonbusiness all chapters total',
        'N7PCHG': 'Percent change in nonbusiness Chapter 7',
        'N11PCHG': 'Percent change in nonbusiness Chapter 11',
        'N13PCHG': 'Percent change in nonbusiness Chapter 13',
        'NOTHPCHG': 'Percent change in nonbusiness other chapters total',

        'ALLCCHG': 'Change in all chapters per 100 population',
        'A7CCHG': 'Change in Chapter 7 per 100 population',
        'A11CCHG': 'Change in Chapter 11 per 100 population',
        'A13CCHG': 'Change in Chapter 13 per 100 population',
        'AOTHCCHG': 'Change in other chapters per 100 population',
        'A9CCHG': 'Change in Chapter 9 per 100 population',
        'A12CCHG': 'Change in Chapter 12 per 100 population',
        'A15CCHG': 'Change in Chapter 15 per 100 population',
        'BALLCCHG': 'Change in business all chapters per 100 population',
        'B7CCHG': 'Change in business Chapter 7 per 100 population',
        'B11CCHG': 'Change in business Chapter 11 per 100 population',
        'B13CCHG': 'Change in business Chapter 13 per 100 population',
        'BOTHCCHG': 'Change in business other chapters per 100 population',
        'NALLCCHG': 'Change in nonbusiness all chapters per 100 population',
        'N7CCHG': 'Change in nonbusiness Chapter 7 per 100 population',
        'N11CCHG': 'Change in nonbusiness Chapter 11 per 100 population',
        'N13CCHG': 'Change in nonbusiness Chapter 13 per 100 population',
        'NOTHCCHG': 'Change in nonbusiness other chapters per 100 population'
    };
    return ramps[n] || 'Chapter 7 total, 2024'
}

const vectorSource = new ol.source.Vector({
    // features: [feature]
    // url: './data/USCourtDistrict1.geojson',
    url: GEOJSON_URL,
    format: new ol.format.GeoJSON(),
});

const vectorLayer = new ol.layer.Vector({
    source: vectorSource,
    style: new ol.style.Style({
        stroke: new ol.style.Stroke({
            color: '#004a99',
            width: 2
        }),
        fill: new ol.style.Fill({
            color: 'rgba(0, 123, 255, 0.20)',
        })
    })
});


// Create the map
const map = new ol.Map({
    target: 'map',
    layers: [
        new ol.layer.Tile({
            source: new ol.source.OSM()
        }),
        vectorLayer
    ],
    view: new ol.View({
        center: ol.proj.fromLonLat(massCenter),
        zoom: 8
    })
});

// asynchronized
// connect after geojson loads
vectorSource.once('change', async function () {
  if (vectorSource.getState() === 'ready') {
    map.getView().fit(vectorSource.getExtent(), {
      padding: [20, 20, 20, 20],
      maxZoom: 8,
    });

    buildFeatureAliasMap();
    await loadMonthlyCsv();

    applyClassification();
    syncSliderToCurrentMonth();
  }
});

// this is for test monthly connection
function testMonthlyConnection() {
  const feature = vectorSource.getFeatures()[0];
  if (!feature) {
    console.log('No features loaded');
    return;
  }

  const initial = feature.get('Initial');
  console.log('Testing feature Initial:', initial);
  console.log('Monthly rows for this feature:', monthlyLookup[initial]);
}

function getNumericValues(fieldName) {
  return vectorSource.getFeatures()
    .map(f => Number(f.get(fieldName)))
    .filter(v => Number.isFinite(v))
    .sort((a, b) => a - b);
}

// equal-interval breaks
function buildBreaks(values, classCount) {
  if (!values.length) return [];
  const min = values[0];
  const max = values[values.length - 1];
  const step = (max - min) / classCount;
  const breaks = [];
  for (let i = 0; i <= classCount; i++) {
    breaks.push(min + step * i);
  }
  return breaks;
}

// quantile
function buildQuantileBreaks(values, classCount) {
  if (!values.length) return [];

  const sorted = [...values].sort((a, b) => a - b);
  const breaks = [sorted[0]];

  for (let i = 1; i < classCount; i++) {
    const idx = Math.floor((i * sorted.length) / classCount);
    breaks.push(sorted[idx]);
  }

  breaks.push(sorted[sorted.length - 1]);

  // make breaks non-decreasing and avoid weird backwards labels
  for (let i = 1; i < breaks.length; i++) {
    if (breaks[i] < breaks[i - 1]) {
      breaks[i] = breaks[i - 1];
    }
  }

  return breaks;
}

function getClassIndex(value, breaks) {
  if (!Number.isFinite(value)) return 0;
  for (let i = 0; i < breaks.length - 1; i++) {
    const low = breaks[i];
    const high = breaks[i + 1];
    const isLast = i === breaks.length - 2;
    if ((value >= low && value < high) || (isLast && value <= high)) {
      return i;
    }
  }
  return 0;
}

// this is for legend
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function updateLegend(title, breaks, colors) {
  const legend = document.getElementById('legend');
  // legend.innerHTML = `<strong>${getNameOfData(fieldName)}</strong><br>`;
  legend.innerHTML = `<strong>${title}</strong><br>`;

  for (let i = 0; i < colors.length; i++) {
    const low = breaks[i];
    const high = breaks[i + 1];
    const label = `${low.toFixed(2)} – ${high.toFixed(2)}`;

    const row = document.createElement('div');
    row.className = 'legend-row';

    const swatch = document.createElement('div');
    swatch.className = 'legend-swatch';
    swatch.style.borderColor = colors[i];
    swatch.style.backgroundColor = hexToRgba(colors[i], 0.28);

    const text = document.createElement('div');
    text.textContent = label;

    row.appendChild(swatch);
    row.appendChild(text);
    legend.appendChild(row);
  }
}

// get Debtor type
function getDebtorTypeLabel(v) {
  const labels = {
    all: 'all debtors',
    business: 'business filings',
    nonbusiness: 'nonbusiness filings'
  };
  return labels[v] || v;
}
function getChapterLabel(v) {
  const labels = {
    all: 'all chapters',
    '7': 'Chapter 7',
    '9': 'Chapter 9',
    '11': 'Chapter 11',
    '12': 'Chapter 12',
    '13': 'Chapter 13',
    '15': 'Chapter 15',
    OTH: 'other chapters'
  };
  return labels[v] || v;
}
function getMetricLabel(v) {
  const labels = {
    cases: 'total amount',
    per100pop: 'per 100 population',
    per100hh: 'per 100 households',
    per100labor: 'per 100 labor force',
    per100unemp: 'per 100 unemployed',
    per100pop16: 'per 100 population age 16+',
    perIncomeBillion: 'cases per $1B aggregate household income',
    share: 'share of all filings',
    momAbs: 'month-to-month change',
    momPct: 'month-to-month % change',
    yoyAbs: 'year-over-year change',
    yoyPct: 'year-over-year % change'
  };
  return labels[v] || v;
}
function buildLegendTitle() {
  const year = document.getElementById('yearSelect').value;
  const month = document.getElementById('monthSelect').value;
  const debtorType = document.getElementById('debtorTypeSelect').value;
  const chapter = document.getElementById('chapterSelect').value;
  const metric = document.getElementById('metricSelect').value;

  return `${year}-${month} ${getMetricLabel(metric)} for ${getDebtorTypeLabel(debtorType)} in ${getChapterLabel(chapter)}`;
  // return `${year}-${month} for ${getDebtorTypeLabel(debtorType)} in ${getChapterLabel(chapter)}`;
}

function applyClassification() {
  // updateSelectedCasesToFeatures();
  updateSelectedValueToFeatures()

  const classCount = Number(document.getElementById('classCount').value);
  const paletteName = document.getElementById('paletteSelect').value;

  const values = vectorSource.getFeatures()
    .map(f => Number(f.get('__displayValue')))
    .filter(v => Number.isFinite(v))
    .sort((a, b) => a - b);

  // const breaks = buildBreaks(values, classCount); // equal-interval
  const breaks = buildQuantileBreaks(values, classCount);
  // const colors = getColorRamp(classCount);
  const colors = getColorRamp(classCount, paletteName);

  const styleCache = new Map();

  vectorLayer.setStyle((feature) => {
    // const value = Number(feature.get(fieldName));
    const value = Number(feature.get('__displayValue'));
    const classIndex = getClassIndex(value, breaks);
    const color = colors[classIndex] || colors[0];
    const key = `${classIndex}`;

    if (!styleCache.has(key)) {
      styleCache.set(key, new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: color,
          width: 2,
        }),
        fill: new ol.style.Fill({
          color: hexToRgba(color, 0.28),
        }),
      }));
    }

    return styleCache.get(key);
  });

  const legendTitle = buildLegendTitle();

  updateLegend(
    // `Cases (${year}-${month}) — ${debtorType} — ${chapter}`,
    // `${year}-${month} ${debtorType} ${chapter}`,
    legendTitle,
    breaks,
    colors
  );

  syncSliderToCurrentMonth();
  drawCompositionChart();
}



// add function toggle about panel
function toggleAboutPanel() {
  const collapsed = aboutPanel.classList.toggle('collapsed');
  aboutToggle.textContent = collapsed ? '+' : '−';
}

//  show hover label
function getHoverLabelHtml(feature) {
  // // const fieldName = document.getElementById('fieldSelect').value;
  // const year = document.getElementById('yearSelect').value;
  // const month = document.getElementById('monthSelect').value;
  // const debtorType = document.getElementById('debtorTypeSelect').value;
  // const chapter = document.getElementById('chapterSelect').value;

  const districtName =
    feature.get('Initial') || 'District';

  // const value = feature.get(fieldName);
  const value = feature.get('__displayValue');

  // const debtorLabel =
  //   debtorType === 'all' ? 'All debtors' :
  //   debtorType === 'business' ? 'Business' :
  //   'Nonbusiness';

  // const chapterLabel =
  //   chapter === 'all' ? 'All chapters' :
  //   chapter === 'OTH' ? 'Other chapters' :
  //   `Chapter ${chapter}`;

  return `
    <div class="hover-title">${districtName}</div>
    <div class="hover-value">${buildLegendTitle()}</div>
    <div class="hover-value">Cases: ${value ?? 'N/A'}</div>
  `;
}

// highlight stroke
function getHoverStyle(feature) {
  const color = getFeatureColor(feature);
  // const baseColor = getCurrentFeatureColor(feature);
  const baseFill = getCurrentFeatureFill(feature);

  return new ol.style.Style({
    stroke: new ol.style.Stroke({
      color: color,
      width: 4,
    }),
    fill: new ol.style.Fill({
      // color: hexToRgba(color, alpha),
      color: baseFill,
    }),
  });
}

// get color of feature
function getFeatureColor(feature) {
  const style = getCurrentFeatureStyle(feature);
  if (!style) return '#333';

  const stroke = style.getStroke();
  if (!stroke) return '#333';

  return stroke.getColor() || '#333';
}

function getCurrentFeatureFill(feature) {
  const style = getCurrentFeatureStyle(feature);
  if (!style) return 'rgba(255,255,255,0.25)';

  const fill = style.getFill();
  if (!fill) return 'rgba(255,255,255,0.25)';

  return fill.getColor() || 'rgba(255,255,255,0.25)';
}

function getCurrentFeatureStyle(feature) {
  const styleFunction = vectorLayer.getStyleFunction();
  if (!styleFunction) return null;

  const resolution = map.getView().getResolution();
  const styleResult = styleFunction(feature, resolution);

  if (Array.isArray(styleResult)) {
    return styleResult[0] || null;
  }

  return styleResult || null;
}

// add trigger / function / listener
document.getElementById('hoverToggle').addEventListener('click', function () {
  hoverEnabled = !hoverEnabled;
  this.textContent = `Hover labels: ${hoverEnabled ? 'On' : 'Off'}`;

  if (!hoverEnabled) {
    if (hoveredFeature) {
      hoveredFeature.setStyle(undefined);
      hoveredFeature = null;
    }
    hoverLabel.style.display = 'none';
  }
});

// add toggle function
aboutToggle.addEventListener('click', function (evt) {
  evt.stopPropagation();
  toggleAboutPanel();
});

aboutHeader.addEventListener('click', toggleAboutPanel);

// hover and show
map.on('pointermove', function (evt) {
  if (!hoverEnabled || evt.dragging) return;

  const feature = map.forEachFeatureAtPixel(evt.pixel, function (feature) {
    return feature;
  });

  // mouse is no longer over a feature
  if (!feature) {
    if (hoveredFeature) {
      hoveredFeature.setStyle(undefined);
      hoveredFeature = null;
    }

    hoverLabel.style.display = 'none';
    return;
  }

  // const currentColor = getFeatureColor(feature);

  // restore previous hovered feature if moved to another one
  if (hoveredFeature && hoveredFeature !== feature) {
    hoveredFeature.setStyle(undefined);
  }

  // set new hovered feature
  if (hoveredFeature !== feature) {
    hoveredFeature = feature;
    hoveredFeature.setStyle(getHoverStyle(feature));
  }

  // update floating label
  hoverLabel.innerHTML = getHoverLabelHtml(feature);
  
  hoverLabel.style.display = 'block';
  hoverLabel.style.left = `${evt.pixel[0] + 15}px`;
  hoverLabel.style.top = `${evt.pixel[1] + 15}px`;

  const color = getFeatureColor(feature);
  hoverLabel.querySelector('.hover-title').style.color = color;
  hoverLabel.style.borderColor = color;
});

// dedicated info-panel updater
function updateInfoPanel(feature) {
  if (!feature) {
    info.textContent = 'Click a feature to get info';
    return;
  }

  const props = feature.getProperties();
  const currentYm =
    document.getElementById('yearSelect').value + '-' +
    document.getElementById('monthSelect').value;

  const currentRank = getRankForMonth(feature, currentYm);
  const currentValue = props.__displayValue;

  info.textContent =
    `District: ${feature.get('Initial') || 'N/A'}\n` +
    `${buildLegendTitle()}: ${currentValue ?? 'N/A'}\n` +
    `Rank: ${currentRank ?? 'N/A'} / 93\n` +
    `Population: ${props.Population ?? 'N/A'}\n` +
    `Households: ${props['1101C11E_s'] ?? 'N/A'}\n` +
    `LaborForce: ${props.LaborForce ?? 'N/A'}\n` +
    `Unemployed: ${props.Unemployed ?? 'N/A'}`;
}

// dedicated chart-panel updater
function updateChartPanel(feature) {
  if (!feature) {
    chartTitle.innerHTML = '<strong>District charts</strong>';
    clearCanvas(trendCanvas);
    clearCanvas(compositionCanvas);
    return;
  }

  chartTitle.innerHTML = `<strong>District charts — ${feature.get('Initial') || 'District'}</strong>`;

  // reset the playback-recorded trend for this newly selected district
  playbackHistory = [];
  appendPlaybackPoint();

  // draw current-month composition immediately
  drawCompositionChart();
}

// get info
const info = document.getElementById('info');

// click and show info
map.on('singleclick', function (evt) {
  const feature = map.forEachFeatureAtPixel(evt.pixel, function (feature) {
    return feature;
  });

  if (!feature) {
    selectedFeature = null;
    updateInfoPanel(null);
    updateChartPanel(null);
    return;
  }

  selectedFeature = feature;
  updateInfoPanel(feature);
  updateChartPanel(feature);

  // if (!feature) {
  //   info.textContent = 'Click a feature to get info';
  //   selectedFeature = null;
  //   playbackHistory = [];
  //   chartTitle.innerHTML = '<strong>District charts</strong>';
  //   clearCanvas(trendCanvas);
  //   clearCanvas(compositionCanvas);
  //   return;
  // }

  // selectedFeature = feature;
  // chartTitle.innerHTML = `<strong>District charts — ${feature.get('Initial') || 'District'}</strong>`;

  // // const props = feature.getProperties();
  // // const entries = Object.entries(props).filter(([key]) => key !== 'geometry');
  // // const firstSeven = entries.slice(0, 7);

  // info.textContent = firstSeven
  //   .map(([key, value]) => `${key}: ${value}`)
  //   .join('\n');
});
