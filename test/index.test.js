'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const CircuitBreaker = require('opossum');
const client = require('prom-client');
const { instrument, instrumentAll, STATE } = require('../src/index.js');

// Helper — always-resolves function
const SUCCESS_FN = async (x) => x * 2;
// Helper — always-rejects function
const FAIL_FN = async () => { throw new Error('simulated failure'); };
// Helper — slow function (for timeout tests)
const SLOW_FN = (ms) => async () => new Promise(r => setTimeout(r, ms));

// Read a metric value by name + labels from a private registry
async function getMetricValue(registry, metricName, labels = {}) {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find(m => m.name === metricName);
  if (!metric) return null;
  const labelKeys = Object.keys(labels);
  const value = metric.values.find(v =>
    labelKeys.every(k => String(v.labels[k]) === String(labels[k]))
  );
  return value ? value.value : null;
}

// -----------------------------------------------------------------------
// STATE constants
// -----------------------------------------------------------------------
describe('STATE constants', () => {
  it('CLOSED is 0', () => assert.equal(STATE.CLOSED, 0));
  it('OPEN is 1', () => assert.equal(STATE.OPEN, 1));
  it('HALF_OPEN is 2', () => assert.equal(STATE.HALF_OPEN, 2));
});

// -----------------------------------------------------------------------
// instrument() — argument validation
// -----------------------------------------------------------------------
describe('instrument() validation', () => {
  it('throws if no breaker provided', () => {
    assert.throws(() => instrument(null, { name: 'svc' }), /CircuitBreaker instance/);
  });

  it('throws if breaker is a plain object (not EventEmitter)', () => {
    assert.throws(() => instrument({}, { name: 'svc' }), /CircuitBreaker instance/);
  });

  it('throws if name is missing', () => {
    const breaker = new CircuitBreaker(SUCCESS_FN);
    assert.throws(() => instrument(breaker, {}), /options\.name is required/);
    breaker.shutdown();
  });

  it('throws if name is not a string', () => {
    const breaker = new CircuitBreaker(SUCCESS_FN);
    assert.throws(() => instrument(breaker, { name: 42 }), /options\.name is required/);
    breaker.shutdown();
  });
});

// -----------------------------------------------------------------------
// instrument() — metrics registration
// -----------------------------------------------------------------------
describe('instrument() — metrics registered', () => {
  let registry, breaker, handle;

  beforeEach(() => {
    registry = new client.Registry();
    breaker = new CircuitBreaker(SUCCESS_FN);
    handle = instrument(breaker, { name: 'test_svc', registry });
  });

  afterEach(() => {
    handle.deregister();
    breaker.shutdown();
  });

  it('registers circuit_breaker_state gauge', async () => {
    const v = await getMetricValue(registry, 'circuit_breaker_state', { name: 'test_svc' });
    assert.equal(v, 0, 'initial state should be closed (0)');
  });

  it('registers circuit_breaker_requests_total counter', async () => {
    const metrics = await registry.getMetricsAsJSON();
    assert.ok(metrics.find(m => m.name === 'circuit_breaker_requests_total'));
  });

  it('registers circuit_breaker_failures_total counter', async () => {
    const metrics = await registry.getMetricsAsJSON();
    assert.ok(metrics.find(m => m.name === 'circuit_breaker_failures_total'));
  });

  it('registers circuit_breaker_fallbacks_total counter', async () => {
    const metrics = await registry.getMetricsAsJSON();
    assert.ok(metrics.find(m => m.name === 'circuit_breaker_fallbacks_total'));
  });

  it('registers circuit_breaker_timeouts_total counter', async () => {
    const metrics = await registry.getMetricsAsJSON();
    assert.ok(metrics.find(m => m.name === 'circuit_breaker_timeouts_total'));
  });

  it('registers circuit_breaker_duration_seconds histogram', async () => {
    const metrics = await registry.getMetricsAsJSON();
    assert.ok(metrics.find(m => m.name === 'circuit_breaker_duration_seconds'));
  });
});

// -----------------------------------------------------------------------
// Success path
// -----------------------------------------------------------------------
describe('instrument() — success tracking', () => {
  let registry, breaker, handle;

  beforeEach(() => {
    registry = new client.Registry();
    breaker = new CircuitBreaker(SUCCESS_FN, { volumeThreshold: 1 });
    handle = instrument(breaker, { name: 'svc', registry });
  });

  afterEach(() => {
    handle.deregister();
    breaker.shutdown();
  });

  it('increments requests_total with result=success on success', async () => {
    await breaker.fire(5);
    const v = await getMetricValue(registry, 'circuit_breaker_requests_total', { name: 'svc', result: 'success' });
    assert.equal(v, 1);
  });

  it('does NOT increment failures_total on success', async () => {
    await breaker.fire(5);
    const v = await getMetricValue(registry, 'circuit_breaker_failures_total', { name: 'svc' });
    assert.equal(v, null); // no sample emitted = 0
  });

  it('records duration after success', async () => {
    await breaker.fire(5);
    const metrics = await registry.getMetricsAsJSON();
    const hist = metrics.find(m => m.name === 'circuit_breaker_duration_seconds');
    const count = hist.values.find(v => v.labels.name === 'svc' && v.metricName === 'circuit_breaker_duration_seconds_count');
    assert.equal(count.value, 1);
  });
});

// -----------------------------------------------------------------------
// Failure path
// -----------------------------------------------------------------------
describe('instrument() — failure tracking', () => {
  let registry, breaker, handle;

  beforeEach(() => {
    registry = new client.Registry();
    breaker = new CircuitBreaker(FAIL_FN, { volumeThreshold: 10 });
    handle = instrument(breaker, { name: 'svc', registry });
  });

  afterEach(() => {
    handle.deregister();
    breaker.shutdown();
  });

  it('increments failures_total on failure', async () => {
    try { await breaker.fire(); } catch (_) {}
    const v = await getMetricValue(registry, 'circuit_breaker_failures_total', { name: 'svc' });
    assert.equal(v, 1);
  });

  it('increments requests_total with result=failure', async () => {
    try { await breaker.fire(); } catch (_) {}
    const v = await getMetricValue(registry, 'circuit_breaker_requests_total', { name: 'svc', result: 'failure' });
    assert.equal(v, 1);
  });

  it('accumulates multiple failures', async () => {
    for (let i = 0; i < 3; i++) { try { await breaker.fire(); } catch (_) {} }
    const v = await getMetricValue(registry, 'circuit_breaker_failures_total', { name: 'svc' });
    assert.equal(v, 3);
  });
});

// -----------------------------------------------------------------------
// Open state transitions
// -----------------------------------------------------------------------
describe('instrument() — state transitions', () => {
  let registry, breaker, handle;

  beforeEach(() => {
    registry = new client.Registry();
    // Low thresholds so we can open the breaker quickly
    breaker = new CircuitBreaker(FAIL_FN, {
      errorThresholdPercentage: 1,
      volumeThreshold: 1,
      resetTimeout: 5000,
    });
    handle = instrument(breaker, { name: 'svc', registry });
  });

  afterEach(() => {
    handle.deregister();
    breaker.shutdown();
  });

  it('state gauge = OPEN after breaker trips', async () => {
    try { await breaker.fire(); } catch (_) {}
    try { await breaker.fire(); } catch (_) {}
    const v = await getMetricValue(registry, 'circuit_breaker_state', { name: 'svc' });
    assert.equal(v, STATE.OPEN, 'gauge should be 1 (OPEN)');
  });

  it('increments requests_total with result=reject when open', async () => {
    // Trip the breaker
    try { await breaker.fire(); } catch (_) {}
    try { await breaker.fire(); } catch (_) {}
    // Now fire again — should be rejected
    try { await breaker.fire(); } catch (_) {}
    const v = await getMetricValue(registry, 'circuit_breaker_requests_total', { name: 'svc', result: 'reject' });
    assert.ok(v >= 1, 'should have at least one rejected call');
  });
});

// -----------------------------------------------------------------------
// Fallback tracking
// -----------------------------------------------------------------------
describe('instrument() — fallback tracking', () => {
  let registry, breaker, handle;

  beforeEach(() => {
    registry = new client.Registry();
    breaker = new CircuitBreaker(FAIL_FN, { volumeThreshold: 10 });
    breaker.fallback(() => 'fallback-value');
    handle = instrument(breaker, { name: 'svc', registry });
  });

  afterEach(() => {
    handle.deregister();
    breaker.shutdown();
  });

  it('increments fallbacks_total when fallback fires', async () => {
    await breaker.fire(); // falls back, no throw
    const v = await getMetricValue(registry, 'circuit_breaker_fallbacks_total', { name: 'svc' });
    assert.equal(v, 1);
  });

  it('increments requests_total with result=fallback', async () => {
    await breaker.fire();
    const v = await getMetricValue(registry, 'circuit_breaker_requests_total', { name: 'svc', result: 'fallback' });
    assert.equal(v, 1);
  });
});

// -----------------------------------------------------------------------
// deregister()
// -----------------------------------------------------------------------
describe('deregister()', () => {
  it('removes all metrics from the registry', async () => {
    const registry = new client.Registry();
    const breaker = new CircuitBreaker(SUCCESS_FN);
    const handle = instrument(breaker, { name: 'to_remove', registry });

    // Metrics exist
    let metrics = await registry.getMetricsAsJSON();
    assert.ok(metrics.length >= 6);

    handle.deregister();

    // Metrics gone
    metrics = await registry.getMetricsAsJSON();
    assert.equal(metrics.length, 0);

    breaker.shutdown();
  });

  it('removes event listeners from breaker after deregister', () => {
    const registry = new client.Registry();
    const breaker = new CircuitBreaker(SUCCESS_FN);
    const handle = instrument(breaker, { name: 'listener_test', registry });

    const countBefore = breaker.listenerCount('success');
    handle.deregister();
    const countAfter = breaker.listenerCount('success');

    assert.ok(countAfter < countBefore, 'listener count should decrease');
    breaker.shutdown();
  });
});

// -----------------------------------------------------------------------
// instrumentAll()
// -----------------------------------------------------------------------
describe('instrumentAll()', () => {
  it('throws if list is not an array', () => {
    assert.throws(() => instrumentAll(null), /expects an array/);
  });

  it('instruments multiple breakers', async () => {
    const registry = new client.Registry();
    const b1 = new CircuitBreaker(SUCCESS_FN);
    const b2 = new CircuitBreaker(FAIL_FN, { volumeThreshold: 10 });

    const handle = instrumentAll(
      [{ breaker: b1, name: 'svc_a' }, { breaker: b2, name: 'svc_b' }],
      { registry }
    );

    await b1.fire(3);

    const v = await getMetricValue(registry, 'circuit_breaker_requests_total', { name: 'svc_a', result: 'success' });
    assert.equal(v, 1);

    handle.deregister();
    b1.shutdown();
    b2.shutdown();
  });

  it('deregister() removes all breakers metrics', async () => {
    const registry = new client.Registry();
    const b1 = new CircuitBreaker(SUCCESS_FN);
    const b2 = new CircuitBreaker(SUCCESS_FN);

    const handle = instrumentAll(
      [{ breaker: b1, name: 'alpha' }, { breaker: b2, name: 'beta' }],
      { registry }
    );

    let metrics = await registry.getMetricsAsJSON();
    assert.ok(metrics.length >= 6);

    handle.deregister();

    metrics = await registry.getMetricsAsJSON();
    assert.equal(metrics.length, 0);

    b1.shutdown();
    b2.shutdown();
  });
});

// -----------------------------------------------------------------------
// Custom registry + custom buckets
// -----------------------------------------------------------------------
describe('custom options', () => {
  it('uses custom histogram buckets', async () => {
    const registry = new client.Registry();
    const breaker = new CircuitBreaker(SUCCESS_FN);
    const handle = instrument(breaker, {
      name: 'custom_buckets',
      registry,
      buckets: [0.1, 0.5, 1],
    });

    // Fire the breaker so the histogram emits values
    await breaker.fire(3);

    const metrics = await registry.getMetricsAsJSON();
    const hist = metrics.find(m => m.name === 'circuit_breaker_duration_seconds');
    // prom-client stores le as a number (except '+Inf' which is a string)
    const bucketValues = hist.values
      .filter(v => v.metricName === 'circuit_breaker_duration_seconds_bucket')
      .map(v => Number(v.labels.le));

    assert.ok(bucketValues.includes(0.1));
    assert.ok(bucketValues.includes(0.5));
    assert.ok(bucketValues.includes(1));

    handle.deregister();
    breaker.shutdown();
  });
});
