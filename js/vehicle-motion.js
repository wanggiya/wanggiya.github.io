/**
 * Rolling three-report history and bounded cubic Hermite interpolation.
 * Coordinates are projected map coordinates; timestamps are milliseconds.
 * Playback is buffered; brief gaps use capped, decaying speed estimates.
 * No unlimited trail or indefinite dead reckoning is retained.
 */
export function recordPosition(history, coordinates, timestamp, receivedAt) {
  const time = Number.isFinite(timestamp) ? timestamp : receivedAt;
  const last = history.at(-1);
  if (last && time < last.timestamp) return history;

  const samePosition =
    last &&
    Math.hypot(
      coordinates[0] - last.coordinates[0],
      coordinates[1] - last.coordinates[1],
    ) <= 0.5;
  if (last && time === last.timestamp && samePosition) return history;

  // A correction with the same timestamp replaces that report instead of
  // manufacturing another sample with a zero-length time interval.
  const retained = last && time === last.timestamp ? history.slice(0, -1) : history;
  const next = [
    ...retained.slice(-2),
    {
      coordinates: coordinates.slice(),
      timestamp: time,
      receivedAt,
      velocity: [0, 0],
    },
  ];
  next.at(-1).velocity = estimateVelocity(next);
  return next;
}

/** Estimate speed using both recent intervals, including L(n-2t). */
export function estimateVelocity(history) {
  if (history.length < 2) return [0, 0];
  const oldest = history[0];
  const latest = history.at(-1);
  const elapsed = latest.timestamp - oldest.timestamp;
  if (elapsed <= 0) return [0, 0];
  return [
    (latest.coordinates[0] - oldest.coordinates[0]) / elapsed,
    (latest.coordinates[1] - oldest.coordinates[1]) / elapsed,
  ];
}

/** Keep tangents monotone per axis so curves cannot overshoot report bounds. */
function limitTangents(from, to, startTangent, endTangent) {
  const start = startTangent.slice();
  const end = endTangent.slice();
  for (let axis = 0; axis < 2; axis++) {
    const difference = to[axis] - from[axis];
    if (Math.abs(difference) < 1e-8) {
      start[axis] = 0;
      end[axis] = 0;
      continue;
    }
    let alpha = Math.max(0, start[axis] / difference);
    let beta = Math.max(0, end[axis] / difference);
    const magnitude = Math.hypot(alpha, beta);
    if (magnitude > 3) {
      alpha *= 3 / magnitude;
      beta *= 3 / magnitude;
    }
    start[axis] = alpha * difference;
    end[axis] = beta * difference;
  }
  return { start, end };
}

/** Return both the interpolated location and speed at progress 0..1. */
export function interpolateMotion(segment, progress) {
  const u = Math.max(0, Math.min(1, progress));
  const u2 = u * u;
  const u3 = u2 * u;
  const position = [];
  const velocity = [];
  for (let axis = 0; axis < 2; axis++) {
    const from = segment.from[axis];
    const to = segment.to[axis];
    const start = segment.startTangent[axis];
    const end = segment.endTangent[axis];
    position[axis] =
      (2 * u3 - 3 * u2 + 1) * from +
      (u3 - 2 * u2 + u) * start +
      (-2 * u3 + 3 * u2) * to +
      (u3 - u2) * end;
    velocity[axis] =
      ((6 * u2 - 6 * u) * from +
        (3 * u2 - 4 * u + 1) * start +
        (-6 * u2 + 6 * u) * to +
        (3 * u2 - 2 * u) * end) /
      segment.duration;
  }
  return { position, velocity };
}

/** Estimate the interval between real reports, rather than between fetch attempts. */
function reportInterval(history, fallback) {
  if (history.length < 2) return fallback;
  const intervals = history
    .slice(1)
    .map((sample, index) => sample.timestamp - history[index].timestamp)
    .filter((value) => value > 0);
  return intervals.length
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : fallback;
}

/** Find the sample time closest to the already displayed point. */
function initialPlaybackTime(history, displayed) {
  let bestTime = history.at(-1).timestamp;
  let bestDistance = Infinity;
  for (const sample of history) {
    const distance = Math.hypot(
      displayed[0] - sample.coordinates[0],
      displayed[1] - sample.coordinates[1],
    );
    if (distance <= bestDistance) {
      bestTime = sample.timestamp;
      bestDistance = distance;
    }
  }
  return bestTime;
}

export function createPlayback(history, displayedPosition, now) {
  return {
    position: displayedPosition.slice(),
    velocity: [0, 0],
    playbackTime: initialPlaybackTime(history, displayedPosition),
    lastFrame: now,
    kind: 'buffered',
  };
}

/** Interpolate historical reports, allowing only a short, decaying speed projection. */
export function samplePlayback(history, time, pollingMilliseconds, stopped = false) {
  const latest = history.at(-1);
  if (!latest) return null;
  if (history.length === 1 || time <= history[0].timestamp) {
    return {
      position: history[0].coordinates.slice(),
      velocity: [0, 0],
      kind: 'buffered',
    };
  }
  for (let index = 1; index < history.length; index++) {
    const left = history[index - 1];
    const right = history[index];
    if (time > right.timestamp) continue;
    const duration = Math.max(1, right.timestamp - left.timestamp);
    const tangents = limitTangents(
      left.coordinates,
      right.coordinates,
      left.velocity.map((value) => value * duration),
      right.velocity.map((value) => value * duration),
    );
    const curve = {
      from: left.coordinates,
      to: right.coordinates,
      startTangent: tangents.start,
      endTangent: tangents.end,
      duration,
    };
    return {
      ...interpolateMotion(curve, (time - left.timestamp) / duration),
      kind: 'buffered',
    };
  }

  const previous = history.at(-2);
  const stationary =
    stopped ||
    Math.hypot(
      latest.coordinates[0] - previous.coordinates[0],
      latest.coordinates[1] - previous.coordinates[1],
    ) <= 0.5;
  const limit = Math.min(
    15000,
    Math.max(3000, pollingMilliseconds, reportInterval(history, pollingMilliseconds)),
  );
  const elapsed = Math.max(0, time - latest.timestamp);
  const u = Math.min(1, elapsed / limit);
  const speed = stationary ? [0, 0] : estimateVelocity(history);
  // Linear decay of speed integrates to this displacement. At the limit,
  // speed is zero and the marker holds rather than drifting indefinitely.
  const distanceTime = limit * (u - 0.5 * u * u);
  return {
    position: latest.coordinates.map((value, axis) => value + speed[axis] * distanceTime),
    velocity: speed.map((value) => value * (1 - u)),
    kind: stationary || elapsed >= limit ? 'held' : 'estimated',
  };
}

/**
 * A persistent clock and critically damped position filter.
 * Fetching a new report NEVER restarts this clock or discards display velocity.
 */
export function advancePlayback(
  state,
  history,
  now,
  pollingMilliseconds,
  stopped = false,
) {
  const elapsed = Math.max(0, Math.min(100, now - state.lastFrame));
  state.lastFrame = now;
  if (!elapsed) return state;
  const latest = history.at(-1);
  if (!latest) return state;
  const expectedInterval = reportInterval(history, pollingMilliseconds);
  const remaining = latest.timestamp - state.playbackTime;
  // Mild clock correction absorbs source jitter without visible stops/jumps.
  const rate =
    remaining > expectedInterval * 1.5
      ? 1.12
      : remaining < expectedInterval * 0.3
        ? 0.92
        : 1;
  state.playbackTime = Math.max(
    history[0].timestamp,
    state.playbackTime + elapsed * rate,
  );
  const target = samplePlayback(
    history,
    state.playbackTime,
    pollingMilliseconds,
    stopped,
  );
  const seconds = elapsed / 1000;
  const omega = 12;
  const decay = Math.exp(-omega * seconds);
  for (let axis = 0; axis < 2; axis++) {
    const offset = state.position[axis] - target.position[axis];
    const term = state.velocity[axis] + omega * offset;
    state.position[axis] = target.position[axis] + (offset + term * seconds) * decay;
    state.velocity[axis] = (state.velocity[axis] - omega * term * seconds) * decay;
  }
  state.kind = target.kind;
  return state;
}
