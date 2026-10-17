/** Presentation of filtered positions only; never consumes raw GPS coordinates.
 * A short source-time buffer absorbs polling gaps. When drained, extrapolation
 * decays to a stop and is limited by both distance and seconds per mode.
 */
export const MOTION_PROFILES = Object.freeze({
  bus: { seconds: 3, meters: 30, processNoise: 3 },
  lightRail: { seconds: 5, meters: 60, processNoise: 1.5 },
  subway: { seconds: 7, meters: 120, processNoise: 1 },
  commuter: { seconds: 10, meters: 200, processNoise: 0.7 },
  ferry: { seconds: 6, meters: 40, processNoise: 0.35 },
});
export const DISPLAY_OPTIONS = Object.freeze({
  correctionSeconds: 0.65,
  maxBufferSeconds: 120,
  jitterSeconds: 1,
  pixelRatioCap: 2,
});
export function profileForRoute(route) {
  const type = route?.attributes?.type;
  if (route?.id === 'Mattapan' || type === 0) return 'lightRail';
  if (type === 1) return 'subway';
  if (type === 2) return 'commuter';
  if (type === 4) return 'ferry';
  return 'bus'; // Includes every Silver Line variant (MBTA bus type).
}
const copy = (p) => p.slice();
const lerp = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);

export class VehicleDisplay {
  constructor(profile = MOTION_PROFILES.bus) {
    this.profile = profile;
    this.samples = []; // At most four accepted filter posteriors, not GPS fixes.
    this.intervalSeconds = 0;
    this.latencySeconds = 0;
    this.position = null;
    this.velocity = [0, 0];
    this.cursor = null;
    this.lastFrame = null;
    this.heading = null;
    this.last = null;
  }
  push(sample, receivedAt, stopped = false) {
    const previous = this.samples.at(-1);
    if (previous && sample.sourceTimestamp <= previous.time) return false;
    if (previous) {
      const interval = (sample.sourceTimestamp - previous.time) / 1000;
      this.intervalSeconds = this.intervalSeconds
        ? this.intervalSeconds * 0.7 + interval * 0.3
        : interval;
    }
    const latency = Math.max(0, (receivedAt - sample.sourceTimestamp) / 1000);
    this.latencySeconds = this.samples.length
      ? this.latencySeconds * 0.7 + latency * 0.3
      : latency;
    this.samples.push({
      position: copy(sample.position),
      velocity: stopped ? [0, 0] : copy(sample.velocity),
      time: sample.sourceTimestamp,
      stopped,
    });
    this.samples = this.samples.slice(-4);
    if (!this.position) this.position = copy(sample.position);
    return true;
  }
  delaySeconds(pollSeconds) {
    return Math.min(
      DISPLAY_OPTIONS.maxBufferSeconds,
      Math.max(2, pollSeconds, this.intervalSeconds) +
        this.latencySeconds +
        DISPLAY_OPTIONS.jitterSeconds,
    );
  }
  target(time) {
    const first = this.samples[0],
      latest = this.samples.at(-1);
    if (!latest) return null;
    if (time <= first.time)
      return { position: copy(first.position), velocity: [0, 0], kind: 'buffered' };
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1],
        b = this.samples[i];
      if (time > b.time) continue;
      const seconds = (b.time - a.time) / 1000;
      const u = Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time)));
      return {
        position: lerp(a.position, b.position, u),
        velocity: b.position.map((v, axis) => (v - a.position[axis]) / seconds),
        kind: 'buffered',
      };
    }
    const speed = Math.hypot(...latest.velocity);
    let factor = 1;
    const previous = this.samples.at(-2);
    if (previous) {
      const previousSpeed = Math.hypot(...previous.velocity);
      if (previousSpeed > 0.5 && speed > 0.5) {
        const cosine =
          (latest.velocity[0] * previous.velocity[0] +
            latest.velocity[1] * previous.velocity[1]) /
          (speed * previousSpeed);
        if (cosine < Math.cos(Math.PI / 6)) factor = 0.4;
        if (speed < previousSpeed * 0.6) factor = Math.min(factor, 0.5);
      }
    }
    const duration = Math.min(
      this.profile.seconds * factor,
      speed > 0 ? (this.profile.meters * factor) / speed : 0,
    );
    const elapsed = Math.max(0, (time - latest.time) / 1000);
    const u = duration > 0 ? Math.min(1, elapsed / duration) : 1;
    const travelSeconds = duration * (u - 0.5 * u * u);
    return {
      position: latest.position.map((v, i) => v + latest.velocity[i] * travelSeconds),
      velocity: latest.velocity.map((v) => v * (1 - u)),
      kind: elapsed >= duration ? 'held' : 'estimated',
    };
  }
  /** A closed-form critically damped follower preserves position/velocity at
   * packet arrival. This is display easing of the filter, not a new GPS update.
   */
  sample(now, pollSeconds, enabled = true, paused = false) {
    if (!this.samples.length) return null;
    const dt = this.lastFrame === null ? 0 : Math.max(0, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (paused && this.last) {
      this.wasPaused = true;
      return this.last;
    }
    const delaySeconds = this.delaySeconds(pollSeconds);
    const desired = now - delaySeconds * 1000;
    if (this.wasPaused) {
      this.cursor = desired;
      this.wasPaused = false;
    }
    if (this.cursor === null || dt > 2) this.cursor = desired;
    else {
      // A modest playback rate adjustment prevents buffer changes reversing time.
      const rate = Math.max(0.85, Math.min(1.15, 1 + (desired - this.cursor) / 20000));
      this.cursor += dt * 1000 * rate;
    }
    const latest = this.samples.at(-1);
    const target = enabled
      ? this.target(this.cursor)
      : {
          position: copy(latest.position),
          velocity: copy(latest.velocity),
          kind: 'filtered',
        };
    if (!enabled || dt > 2) {
      this.position = copy(target.position);
      this.velocity = copy(target.velocity);
    } else if (dt > 0) {
      const omega = 4 / DISPLAY_OPTIONS.correctionSeconds;
      const decay = Math.exp(-omega * dt);
      for (let axis = 0; axis < 2; axis++) {
        // Solve the spring relative to a linearly moving target. The previous
        // target position is reconstructed so constant-speed motion has no lag.
        const offset =
          this.position[axis] - (target.position[axis] - target.velocity[axis] * dt);
        const relativeVelocity = this.velocity[axis] - target.velocity[axis];
        const term = relativeVelocity + omega * offset;
        this.position[axis] = target.position[axis] + (offset + term * dt) * decay;
        this.velocity[axis] =
          target.velocity[axis] + (relativeVelocity - omega * term * dt) * decay;
      }
      // Keep correction easing inside the buffered path envelope plus the
      // mode's prediction allowance, even after a large filter correction.
      const min = [0, 1].map(
        (axis) =>
          Math.min(...this.samples.map((s) => s.position[axis])) - this.profile.meters,
      );
      const max = [0, 1].map(
        (axis) =>
          Math.max(...this.samples.map((s) => s.position[axis])) + this.profile.meters,
      );
      this.position = this.position.map((v, axis) =>
        Math.max(min[axis], Math.min(max[axis], v)),
      );
    }
    const speed = Math.hypot(...this.velocity);
    if (speed >= 0.5)
      this.heading =
        ((Math.atan2(this.velocity[0], this.velocity[1]) * 180) / Math.PI + 360) % 360;
    this.last = {
      position: copy(this.position),
      velocity: copy(this.velocity),
      heading: this.heading,
      speedMps: speed,
      kind: target.kind,
      delaySeconds: enabled ? delaySeconds : 0,
    };
    return this.last;
  }
}
