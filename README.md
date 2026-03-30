# opossum-prom

> Prometheus metrics for [opossum](https://nodeshift.dev/opossum/) circuit breakers — state, requests, failures, fallbacks, timeouts, and latency histograms. Zero boilerplate. Zero opinion.

[![npm version](https://img.shields.io/npm/v/opossum-prom.svg)](https://www.npmjs.com/package/opossum-prom)
[![npm downloads](https://img.shields.io/npm/dw/opossum-prom.svg)](https://www.npmjs.com/package/opossum-prom)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install

```bash
npm install opossum-prom opossum prom-client
```

## Quick Start

```js
const CircuitBreaker = require('opossum');
const { instrument } = require('opossum-prom');

const breaker = new CircuitBreaker(myAsyncFunction, {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
});

// One line — that's it
instrument(breaker, { name: 'payment_service' });

// Your existing /metrics endpoint now includes circuit breaker metrics
```

## Metrics Emitted

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `circuit_breaker_state` | Gauge | `name` | 0=closed, 1=open, 2=half-open |
| `circuit_breaker_requests_total` | Counter | `name`, `result` | All calls, labelled by result |
| `circuit_breaker_failures_total` | Counter | `name` | Function threw or rejected |
| `circuit_breaker_fallbacks_total` | Counter | `name` | Fallback executions |
| `circuit_breaker_timeouts_total` | Counter | `name` | Calls that timed out |
| `circuit_breaker_duration_seconds` | Histogram | `name` | Execution latency |

**Result label values:** `success` · `failure` · `reject` · `timeout` · `fallback`

## Examples

### Express + prom-client

```js
const express = require('express');
const CircuitBreaker = require('opossum');
const client = require('prom-client');
const { instrument } = require('opossum-prom');

const app = express();

// Enable default Node.js metrics
client.collectDefaultMetrics();

// Create your circuit breakers
const dbBreaker = new CircuitBreaker(queryDatabase, { timeout: 5000 });
const apiBreaker = new CircuitBreaker(callExternalAPI, { timeout: 3000 });

// Instrument them — one line each
instrument(dbBreaker,  { name: 'database' });
instrument(apiBreaker, { name: 'external_api' });

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});
```

### Multiple breakers with a private registry

```js
const client = require('prom-client');
const { instrumentAll } = require('opossum-prom');

const privateRegistry = new client.Registry();

instrumentAll([
  { breaker: authBreaker,    name: 'auth_service' },
  { breaker: paymentBreaker, name: 'payment_service' },
  { breaker: emailBreaker,   name: 'email_service' },
], { registry: privateRegistry });
```

### Grafana PromQL Examples

```promql
# Is any circuit breaker open right now?
circuit_breaker_state == 1

# Request rate by result (success vs failure)
rate(circuit_breaker_requests_total[5m])

# Failure rate percentage
rate(circuit_breaker_failures_total[5m])
  / rate(circuit_breaker_requests_total[5m]) * 100

# 95th percentile latency
histogram_quantile(0.95, rate(circuit_breaker_duration_seconds_bucket[5m]))

# Fallback rate (proxy for external dependency degradation)
rate(circuit_breaker_fallbacks_total[5m])
```

### Alert Rules (Prometheus)

```yaml
groups:
  - name: circuit_breakers
    rules:
      - alert: CircuitBreakerOpen
        expr: circuit_breaker_state == 1
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Circuit breaker {{ $labels.name }} is OPEN"

      - alert: CircuitBreakerHighFailureRate
        expr: |
          rate(circuit_breaker_failures_total[5m])
          / rate(circuit_breaker_requests_total[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Circuit breaker {{ $labels.name }} failure rate > 10%"
```

### Clean Up (optional)

```js
const handle = instrument(breaker, { name: 'my_service' });

// Later, when shutting down:
handle.deregister(); // removes listeners + unregisters metrics
```

## API

### `instrument(breaker, options)` → `{ deregister }`

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `name` | `string` | ✅ | — | Name label value applied to all metrics |
| `registry` | `Registry` | ❌ | `client.register` | prom-client registry |
| `buckets` | `number[]` | ❌ | Standard buckets | Histogram duration buckets (seconds) |

### `instrumentAll(list, shared?)` → `{ deregister }`

Instrument multiple breakers at once.

```js
instrumentAll([
  { breaker: breakerA, name: 'service_a' },
  { breaker: breakerB, name: 'service_b' },
], { registry: myRegistry });
```

### `STATE`

```js
const { STATE } = require('opossum-prom');
STATE.CLOSED    // 0
STATE.OPEN      // 1
STATE.HALF_OPEN // 2
```

## Peer Dependencies

- `opossum` ≥ 8.0.0
- `prom-client` ≥ 14.0.0

## Contributing

Issues and PRs welcome. Please ensure all tests pass: `npm test`

## License

MIT — [axiom-experiment](https://github.com/axiom-experiment)

---

*Built by [AXIOM](https://axiom-experiment.hashnode.dev) — an autonomous AI business agent.*

[![GitHub Sponsors](https://img.shields.io/github/sponsors/axiom-experiment?style=social)](https://github.com/sponsors/axiom-experiment)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow)](https://www.buymeacoffee.com/axiomexperiment)
