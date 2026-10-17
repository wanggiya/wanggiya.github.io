/** Coalesces source events into snapshot jobs. No fetches, frame loops or camera
 * changes. One job at a time; at most one completed/start window per 10 seconds.
 */
export function createAutoAnalysis({
  run,
  canRun,
  isPaused,
  isWorking = () => false,
  onStatus,
  minIntervalMs = 10000,
  debounceMs = 800,
}) {
  let enabled = false,
    pending = false,
    busy = false,
    timer = null;
  let lastStarted = -Infinity,
    controller = null;
  const status = (message) => onStatus?.(message);
  function stopTimer() {
    clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    stopTimer();
    if (!enabled) return;
    if (!canRun()) {
      status('On · draw a grid to start.');
      return;
    }
    if (isPaused()) {
      status('On · waiting while live updates or this tab are paused.');
      return;
    }
    if (busy || isWorking() || !pending) return;
    timer = setTimeout(
      tick,
      Math.max(debounceMs, lastStarted + minIntervalMs - Date.now()),
    );
    status('On · waiting for the next analysis update.');
  }
  async function tick() {
    timer = null;
    if (!enabled || !pending || isPaused() || !canRun() || busy || isWorking()) {
      schedule();
      return;
    }
    pending = false;
    busy = true;
    lastStarted = Date.now();
    const current = new AbortController();
    controller = current;
    status('On · updating the vehicle analysis…');
    try {
      await run(current.signal);
      if (enabled && !current.signal.aborted)
        status('On · updated; watching existing vehicle reports.');
    } catch (error) {
      if (enabled && error.name !== 'AbortError')
        status(`On · update failed: ${error.message}`);
    } finally {
      busy = false;
      if (controller === current) controller = null;
      if (enabled && pending) schedule();
    }
  }
  return {
    notify() {
      if (enabled) {
        pending = true;
        schedule();
      }
    },
    setEnabled(value) {
      enabled = Boolean(value);
      stopTimer();
      if (!enabled) {
        pending = false;
        controller?.abort();
        status('Off · use Recalculate for a manual snapshot.');
      } else {
        pending = true;
        schedule();
      }
    },
    // Call after a manual draw/recalculate so auto work does not immediately
    // repeat the same snapshot. New source events during work remain queued.
    manualCompleted() {
      if (enabled) {
        lastStarted = Date.now();
        schedule();
      }
    },
    get enabled() {
      return enabled;
    },
    destroy() {
      enabled = false;
      pending = false;
      stopTimer();
      controller?.abort();
    },
  };
}
