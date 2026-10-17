/**
 * 2D constant-velocity Kalman tracking, independent of OpenLayers.
 * State: [east meters, north meters, east m/s, north m/s].
 * Source timestamps and sample() timestamps are Unix milliseconds.
 * No raw GPS coordinate is ever returned as a rendering fallback.
 */
export const TRACKER_OPTIONS = Object.freeze({
  measurementStdM: 15, // R = sigma^2 I, meters (1-sigma).
  processNoise: 1.5, // Continuous acceleration spectral density, m^2/s^3.
  initialVelocityStdMps: 20,
  gateChiSquare: 13.815510558, // Squared Mahalanobis gate: 99.9%, 2 DOF.
  headingMinSpeedMps: 0.5,
  maxPredictionSeconds: 60, // Hold after a GPS outage; never drift forever.
  maxFutureSeconds: 5,
  maxSpeedMps: 100, // Additional physical plausibility gate.
  maxRadiusM: 250000, // Valid local operating region about each track origin.
});

const A = 6378137;
const E2 = 6.6943799901413165e-3;
const B = A * Math.sqrt(1 - E2);
const RAD = Math.PI / 180;
const validLonLat = (p) =>
  Array.isArray(p) &&
  p.length >= 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) < 89;
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

function ecef([longitude, latitude]) {
  const lon = longitude * RAD,
    lat = latitude * RAD;
  const sin = Math.sin(lat),
    cos = Math.cos(lat);
  const radius = A / Math.sqrt(1 - E2 * sin * sin);
  return [
    radius * cos * Math.cos(lon),
    radius * cos * Math.sin(lon),
    radius * (1 - E2) * sin,
  ];
}

/** WGS84 surface lon/lat <-> local East/North, via ECEF rotation.
 * GPS altitude is deliberately ignored: this is a horizontal 2D tracker.
 * Inverse solves the missing Up component on the WGS84 ellipsoid instead
 * of assuming Up=0 (which introduces a curvature error over long distances).
 */
export class LocalENU {
  constructor(originLonLat) {
    if (!validLonLat(originLonLat)) throw new RangeError('Invalid ENU origin');
    this.origin = ecef(originLonLat);
    const lon = originLonLat[0] * RAD,
      lat = originLonLat[1] * RAD;
    this.east = [-Math.sin(lon), Math.cos(lon), 0];
    this.north = [
      -Math.sin(lat) * Math.cos(lon),
      -Math.sin(lat) * Math.sin(lon),
      Math.cos(lat),
    ];
    this.up = [
      Math.cos(lat) * Math.cos(lon),
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat),
    ];
  }
  toLocal(lonLat) {
    if (!validLonLat(lonLat)) throw new RangeError('Invalid longitude/latitude');
    const delta = ecef(lonLat).map((v, i) => v - this.origin[i]);
    return [dot(delta, this.east), dot(delta, this.north)];
  }
  toLonLat([east, north]) {
    if (!Number.isFinite(east) || !Number.isFinite(north))
      throw new RangeError('Invalid ENU position');
    const p = this.origin.map((v, i) => v + east * this.east[i] + north * this.north[i]);
    const weights = [1 / (A * A), 1 / (A * A), 1 / (B * B)];
    let a = 0,
      b = 0,
      c = -1;
    for (let i = 0; i < 3; i++) {
      a += this.up[i] * this.up[i] * weights[i];
      b += 2 * p[i] * this.up[i] * weights[i];
      c += p[i] * p[i] * weights[i];
    }
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) throw new RangeError('Outside local ENU domain');
    const up = (-2 * c) / (b + Math.sqrt(discriminant));
    const xyz = p.map((v, i) => v + up * this.up[i]);
    const lon = Math.atan2(xyz[1], xyz[0]);
    const lat = Math.atan2(xyz[2], Math.hypot(xyz[0], xyz[1]) * (1 - E2));
    return [lon / RAD, lat / RAD];
  }
}

const identity = () =>
  Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => +(i === j)));
const transpose = (a) => a[0].map((_, j) => a.map((row) => row[j]));
const multiply = (a, b) =>
  a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
const add = (a, b) => a.map((row, i) => row.map((v, j) => v + b[i][j]));
const clone = (s) => ({ x: s.x.slice(), P: s.P.map((row) => row.slice()), time: s.time });

function validateOptions(options) {
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(`Invalid tracker option: ${key}`);
  }
  if (
    options.measurementStdM <= 0 ||
    options.initialVelocityStdMps <= 0 ||
    options.gateChiSquare <= 0 ||
    options.maxRadiusM <= 0 ||
    options.maxSpeedMps <= 0
  )
    throw new RangeError('Noise, gate, speed and radius limits must be positive');
  return Object.freeze(options);
}

/** Exact discretization of continuous white acceleration, independent of FPS.
 * Q for each [position, velocity] axis = q*[dt^3/3, dt^2/2; dt^2/2, dt].
 */
function predict(state, time, q) {
  const dt = (time - state.time) / 1000;
  if (dt <= 0) return state;
  // Sparse F*P*F' avoids two generic matrix products per vehicle per frame.
  const old = state.P;
  state.P = old.map((row, i) =>
    row.map(
      (value, j) =>
        value +
        (i < 2 ? dt * old[i + 2][j] : 0) +
        (j < 2 ? dt * old[i][j + 2] : 0) +
        (i < 2 && j < 2 ? dt * dt * old[i + 2][j + 2] : 0),
    ),
  );
  for (let axis = 0; axis < 2; axis++) {
    state.P[axis][axis] += (q * dt ** 3) / 3;
    state.P[axis][axis + 2] += (q * dt ** 2) / 2;
    state.P[axis + 2][axis] += (q * dt ** 2) / 2;
    state.P[axis + 2][axis + 2] += q * dt;
    state.x[axis] += state.x[axis + 2] * dt;
  }
  state.time = time;
  return state;
}

export class VehicleTracker {
  constructor(options = {}) {
    this.options = validateOptions({ ...TRACKER_OPTIONS, ...options });
    this.frame = null;
    this.posterior = null; // Accepted GPS-time posterior, never advanced by rendering.
    this.display = null; // Filter prediction advanced every animation frame.
    this.lastSeenTime = -Infinity;
    this.lastGPS = null;
    this.heading = null;
    this.diagnostics = {
      accepted: 0,
      rejected: 0,
      reason: 'uninitialized',
      innovationSquared: null,
    };
  }

  /** Delayed measurements update at source time, then rendering predicts forward.
   * This avoids assimilating a 10-second-old GPS fix as if it were current.
   * Rejected, duplicate, future and out-of-order reports cannot reset a track.
   */
  updateGPS(
    lonLat,
    timestamp,
    receivedAt = Date.now(),
    measurementStdM = this.options.measurementStdM,
  ) {
    const reject = (reason, innovationSquared = null) => {
      this.diagnostics.rejected++;
      this.diagnostics.reason = reason;
      this.diagnostics.innovationSquared = innovationSquared;
      return { accepted: false, reason, innovationSquared };
    };
    if (
      !validLonLat(lonLat) ||
      !Number.isFinite(timestamp) ||
      !Number.isFinite(receivedAt) ||
      !Number.isFinite(measurementStdM) ||
      measurementStdM <= 0
    )
      return reject('invalid');
    if (timestamp > receivedAt + this.options.maxFutureSeconds * 1000)
      return reject('future');
    if (timestamp <= this.lastSeenTime)
      return { accepted: false, reason: 'duplicate-or-old' };
    this.lastSeenTime = timestamp;
    if (!this.posterior) {
      this.frame = new LocalENU(lonLat);
      const variance = measurementStdM ** 2,
        v = this.options.initialVelocityStdMps ** 2;
      this.posterior = {
        x: [0, 0, 0, 0],
        P: [
          [variance, 0, 0, 0],
          [0, variance, 0, 0],
          [0, 0, v, 0],
          [0, 0, 0, v],
        ],
        time: timestamp,
      };
      this.lastGPS = { position: [0, 0], time: timestamp };
      this.display = clone(this.posterior);
      this.diagnostics.accepted++;
      this.diagnostics.reason = 'initialized';
      return { accepted: true, reason: 'initialized', innovationSquared: 0 };
    }
    const z = this.frame.toLocal(lonLat);
    if (Math.hypot(...z) > this.options.maxRadiusM) return reject('outside-local-domain');
    const elapsed = (timestamp - this.lastGPS.time) / 1000;
    if (
      Math.hypot(z[0] - this.lastGPS.position[0], z[1] - this.lastGPS.position[1]) >
      this.options.maxSpeedMps * elapsed + 6 * measurementStdM
    )
      return reject('implausible-speed');
    const prior = predict(clone(this.posterior), timestamp, this.options.processNoise);
    const residual = [z[0] - prior.x[0], z[1] - prior.x[1]];
    const R = measurementStdM ** 2;
    const S = [
      [prior.P[0][0] + R, prior.P[0][1]],
      [prior.P[1][0], prior.P[1][1] + R],
    ];
    const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    if (!Number.isFinite(det) || det <= 0) return reject('singular-innovation');
    const invS = [
      [S[1][1] / det, -S[0][1] / det],
      [-S[1][0] / det, S[0][0] / det],
    ];
    const distance = dot(
      residual,
      invS.map((row) => dot(row, residual)),
    );
    if (distance > this.options.gateChiSquare) return reject('innovation-gate', distance);
    const K = multiply(
      prior.P.map((row) => row.slice(0, 2)),
      invS,
    );
    const x = prior.x.map((v, i) => v + dot(K[i], residual));
    const residualMatrix = identity();
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 2; j++) residualMatrix[i][j] -= K[i][j];
    // Joseph covariance update: (I-KH)P(I-KH)' + KRK'.
    const covariance = add(
      multiply(multiply(residualMatrix, prior.P), transpose(residualMatrix)),
      multiply(
        K.map((row) => row.map((v) => v * R)),
        transpose(K),
      ),
    );
    // Remove roundoff asymmetry, preserving cross-covariances.
    const P = covariance.map((row, i) => row.map((v, j) => (v + covariance[j][i]) / 2));
    if (![...x, ...P.flat()].every(Number.isFinite)) return reject('non-finite-state');
    this.posterior = { x, P, time: timestamp };
    this.display = clone(this.posterior);
    this.lastGPS = { position: z, time: timestamp };
    this.diagnostics.accepted++;
    this.diagnostics.reason = 'accepted';
    this.diagnostics.innovationSquared = distance;
    return { accepted: true, reason: 'accepted', innovationSquared: distance };
  }

  /** Filter-only output: longitude/latitude, local position, m/s, heading.
   * Heading is clockwise from local ENU north; null until motion is observable.
   * Rendering never feeds a synthetic measurement back into the filter.
   */
  sample(time = Date.now(), predictBetweenReports = true) {
    if (!this.posterior || !Number.isFinite(time)) return null;
    const limit = this.posterior.time + this.options.maxPredictionSeconds * 1000;
    const target = predictBetweenReports
      ? Math.max(this.posterior.time, Math.min(time, limit))
      : this.posterior.time;
    if (target < this.display.time) this.display = clone(this.posterior);
    predict(this.display, target, this.options.processNoise);
    const [east, north, vx, vy] = this.display.x;
    const speedMps = Math.hypot(vx, vy);
    if (speedMps >= this.options.headingMinSpeedMps && speedMps > 0)
      this.heading = (Math.atan2(vx, vy) / RAD + 360) % 360;
    return {
      position: [east, north],
      lonLat: this.frame.toLonLat([east, north]),
      velocity: [vx, vy],
      speedMps,
      heading: this.heading,
      covariance: this.display.P.map((row) => row.slice()),
      timestamp: target,
      sourceTimestamp: this.posterior.time,
      held: !predictBetweenReports || time >= limit,
    };
  }
}
