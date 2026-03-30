import type { Registry } from 'prom-client';
import type CircuitBreaker from 'opossum';

/** Circuit breaker state constants */
export declare const STATE: {
  readonly CLOSED: 0;
  readonly OPEN: 1;
  readonly HALF_OPEN: 2;
};

export interface InstrumentOptions {
  /** Metric name prefix — used as the `name` label on all metrics */
  name: string;
  /** prom-client registry (defaults to globalRegistry) */
  registry?: Registry;
  /** Histogram duration buckets in seconds */
  buckets?: number[];
}

export interface InstrumentHandle {
  /** Remove all event listeners and unregister all metrics */
  deregister(): void;
}

export interface BreakerEntry {
  breaker: CircuitBreaker;
  name: string;
}

/**
 * Instrument a single opossum CircuitBreaker with Prometheus metrics.
 *
 * Registers the following metrics:
 * - `circuit_breaker_state`              Gauge  — 0=closed, 1=open, 2=half-open
 * - `circuit_breaker_requests_total`     Counter — by result label
 * - `circuit_breaker_failures_total`     Counter — failure events
 * - `circuit_breaker_fallbacks_total`    Counter — fallback executions
 * - `circuit_breaker_timeouts_total`     Counter — timed-out calls
 * - `circuit_breaker_duration_seconds`   Histogram — execution latency
 */
export declare function instrument(
  breaker: CircuitBreaker,
  options: InstrumentOptions
): InstrumentHandle;

/**
 * Instrument multiple circuit breakers at once with a shared registry.
 */
export declare function instrumentAll(
  list: BreakerEntry[],
  shared?: Omit<InstrumentOptions, 'name'>
): InstrumentHandle;
