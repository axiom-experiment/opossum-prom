'use strict';

/**
 * opossum-prom — Prometheus metrics for opossum circuit breakers
 *
 * Design: metric instances are shared per-registry. When multiple circuit
 * breakers are instrumented against the same prom-client registry they all
 * write to the same Counter/Gauge/Histogram objects, differentiated by the
 * `name` label. This prevents the "already registered" error that would
 * occur if each breaker tried to create its own metric objects.
 */

/**
 * Circuit breaker state constants.
 * @readonly
 * @enum {number}
 */
const STATE = {
  CLOSED: 0,
  OPEN: 1,
  HALF_OPEN: 2,
};

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * WeakMap keyed on registry → { metrics, refCount, buckets }
 * Lets us reuse metric instances for multiple breakers on the same registry.
 */
const registryCache = new WeakMap();

/**
 * Get or create the shared metric bundle for a given registry.
 * @param {object} client  — prom-client module reference
 * @param {object} reg     — prom-client Registry
 * @param {number[]} buckets — histogram buckets
 * @returns {{ stateGauge, requestsCounter, failuresCounter, fallbacksCounter, timeoutsCounter, durationHistogram }}
 */
function getOrCreateMetrics(client, reg, buckets) {
  if (registryCache.has(reg)) {
    return registryCache.get(reg).metrics;
  }

  const labels = ['name'];

  const stateGauge = new client.Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state: 0=closed, 1=open, 2=half-open',
    labelNames: labels,
    registers: [reg],
  });

  const requestsCounter = new client.Counter({
    name: 'circuit_breaker_requests_total',
    help: 'Total circuit breaker calls, labelled by result (success|failure|reject|timeout|fallback)',
    labelNames: [...labels, 'result'],
    registers: [reg],
  });

  const failuresCounter = new client.Counter({
    name: 'circuit_breaker_failures_total',
    help: 'Total circuit breaker failures (function threw or rejected)',
    labelNames: labels,
    registers: [reg],
  });

  const fallbacksCounter = new client.Counter({
    name: 'circuit_breaker_fallbacks_total',
    help: 'Total circuit breaker fallback executions',
    labelNames: labels,
    registers: [reg],
  });

  const timeoutsCounter = new client.Counter({
    name: 'circuit_breaker_timeouts_total',
    help: 'Total circuit breaker calls that timed out',
    labelNames: labels,
    registers: [reg],
  });

  const durationHistogram = new client.Histogram({
    name: 'circuit_breaker_duration_seconds',
    help: 'Circuit breaker call duration in seconds',
    labelNames: labels,
    buckets: buckets || DEFAULT_BUCKETS,
    registers: [reg],
  });

  const metrics = { stateGauge, requestsCounter, failuresCounter, fallbacksCounter, timeoutsCounter, durationHistogram };
  registryCache.set(reg, { metrics, refCount: 0 });
  return metrics;
}

/**
 * Map an opossum state string to the numeric gauge value.
 * @param {boolean} opened
 * @param {boolean} halfOpen
 * @returns {number}
 */
function resolveState(opened, halfOpen) {
  if (opened) return STATE.OPEN;
  if (halfOpen) return STATE.HALF_OPEN;
  return STATE.CLOSED;
}

/**
 * Instrument an opossum CircuitBreaker with Prometheus metrics.
 *
 * @param {import('opossum')} breaker
 * @param {object} options
 * @param {string}  options.name              — name label value (e.g. 'payment_service')
 * @param {import('prom-client').Registry} [options.registry]
 * @param {number[]} [options.buckets]
 * @returns {{ deregister: () => void }}
 */
function instrument(breaker, options = {}) {
  if (!breaker || typeof breaker.on !== 'function') {
    throw new TypeError('opossum-prom: first argument must be an opossum CircuitBreaker instance');
  }

  const { name, buckets } = options;

  if (!name || typeof name !== 'string') {
    throw new TypeError('opossum-prom: options.name is required (string)');
  }

  const client = require('prom-client');
  const reg = options.registry || client.register;

  const {
    stateGauge,
    requestsCounter,
    failuresCounter,
    fallbacksCounter,
    timeoutsCounter,
    durationHistogram,
  } = getOrCreateMetrics(client, reg, buckets);

  // Bump ref count
  const entry = registryCache.get(reg);
  entry.refCount += 1;

  const labelValues = { name };

  // Initialise state
  stateGauge.set(labelValues, resolveState(breaker.opened, breaker.halfOpen));

  // --- Listeners ---
  let endTimer = null;

  function onFire() {
    endTimer = durationHistogram.startTimer(labelValues);
  }

  function onSuccess() {
    if (endTimer) { endTimer(); endTimer = null; }
    requestsCounter.inc({ ...labelValues, result: 'success' });
    stateGauge.set(labelValues, resolveState(breaker.opened, breaker.halfOpen));
  }

  function onFailure() {
    if (endTimer) { endTimer(); endTimer = null; }
    requestsCounter.inc({ ...labelValues, result: 'failure' });
    failuresCounter.inc(labelValues);
    stateGauge.set(labelValues, resolveState(breaker.opened, breaker.halfOpen));
  }

  function onReject() {
    requestsCounter.inc({ ...labelValues, result: 'reject' });
    stateGauge.set(labelValues, resolveState(breaker.opened, breaker.halfOpen));
  }

  function onTimeout() {
    if (endTimer) { endTimer(); endTimer = null; }
    requestsCounter.inc({ ...labelValues, result: 'timeout' });
    timeoutsCounter.inc(labelValues);
    stateGauge.set(labelValues, resolveState(breaker.opened, breaker.halfOpen));
  }

  function onFallback() {
    requestsCounter.inc({ ...labelValues, result: 'fallback' });
    fallbacksCounter.inc(labelValues);
  }

  function onOpen()     { stateGauge.set(labelValues, STATE.OPEN); }
  function onClose()    { stateGauge.set(labelValues, STATE.CLOSED); }
  function onHalfOpen() { stateGauge.set(labelValues, STATE.HALF_OPEN); }

  breaker.on('fire',     onFire);
  breaker.on('success',  onSuccess);
  breaker.on('failure',  onFailure);
  breaker.on('reject',   onReject);
  breaker.on('timeout',  onTimeout);
  breaker.on('fallback', onFallback);
  breaker.on('open',     onOpen);
  breaker.on('close',    onClose);
  breaker.on('halfOpen', onHalfOpen);

  // --- Deregister --------------------------------------------------------

  function deregister() {
    breaker.removeListener('fire',     onFire);
    breaker.removeListener('success',  onSuccess);
    breaker.removeListener('failure',  onFailure);
    breaker.removeListener('reject',   onReject);
    breaker.removeListener('timeout',  onTimeout);
    breaker.removeListener('fallback', onFallback);
    breaker.removeListener('open',     onOpen);
    breaker.removeListener('close',    onClose);
    breaker.removeListener('halfOpen', onHalfOpen);

    // Only unregister metrics when last breaker on this registry deregisters
    const e = registryCache.get(reg);
    if (e) {
      e.refCount -= 1;
      if (e.refCount <= 0) {
        reg.removeSingleMetric('circuit_breaker_state');
        reg.removeSingleMetric('circuit_breaker_requests_total');
        reg.removeSingleMetric('circuit_breaker_failures_total');
        reg.removeSingleMetric('circuit_breaker_fallbacks_total');
        reg.removeSingleMetric('circuit_breaker_timeouts_total');
        reg.removeSingleMetric('circuit_breaker_duration_seconds');
        registryCache.delete(reg);
      }
    }
  }

  return { deregister };
}

/**
 * Instrument multiple breakers at once.
 *
 * @param {Array<{ breaker: import('opossum'), name: string }>} list
 * @param {{ registry?: import('prom-client').Registry, buckets?: number[] }} [shared]
 * @returns {{ deregister: () => void }}
 */
function instrumentAll(list, shared = {}) {
  if (!Array.isArray(list)) {
    throw new TypeError('opossum-prom: instrumentAll expects an array');
  }
  const handles = list.map(({ breaker, name }) =>
    instrument(breaker, { name, ...shared })
  );
  return {
    deregister() {
      handles.forEach(h => h.deregister());
    },
  };
}

module.exports = {
  instrument,
  instrumentAll,
  STATE,
};
