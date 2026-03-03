# Performance Baseline

This guide defines repeatable baseline load measurements. It does not optimize runtime behavior.

## 1. Prerequisites
- Start the stack (`api`, `worker`, `postgres`, `redis`).
- Use a non-production tenant token for protected routes.
- Export token before running tests:
  - PowerShell: `$env:LOAD_JWT_TOKEN="<JWT_TOKEN>"`
  - Bash: `export LOAD_JWT_TOKEN="<JWT_TOKEN>"`

## 2. Run Autocannon Baselines
These scripts run sequentially across concurrency levels `10,50,100,200`.

- Sync endpoint baseline:
```bash
npm run load:sync
```

- Async enqueue baseline:
```bash
npm run load:async
```

- Auth route baseline:
```bash
npm run load:auth
```

### Optional knobs
- `LOAD_BASE_URL` (default: `http://127.0.0.1:3001`)
- `LOAD_CONCURRENCY_LEVELS` (default: `10,50,100,200`)
- `LOAD_DURATION_SEC` (default: `20`)
- `LOAD_PIPELINING` (default: `1`)

## 3. Run Artillery Scenarios
- Sync scenario:
```bash
npx artillery run load-tests/artillery.sync.yml
```

- Async scenario:
```bash
npx artillery run load-tests/artillery.async.yml
```

- Auth route scenario:
```bash
npx artillery run load-tests/artillery.auth.yml
```

## 4. Safety Guard
Load scripts are blocked when `NODE_ENV=production` unless explicitly overridden:
- `LOAD_TEST_ALLOW_PROD=true`

Use override only in controlled performance environments.

## 5. What to Observe
- `/metrics` endpoint:
  - `vaidyadrishti_http_request_duration_seconds`
  - `vaidyadrishti_http_errors_total`
  - `vaidyadrishti_queue_job_duration_seconds`
  - `vaidyadrishti_db_query_duration_seconds`
  - `vaidyadrishti_db_slow_queries_total`
  - `vaidyadrishti_redis_latency_seconds`
- Structured logs:
  - `durationMs`, `requestId`, `tenantId`
  - `resource_monitor_threshold_exceeded`

## 6. Interpreting p95 Latency
- p95 means 95% of requests complete below this time.
- Compare p95 across `10 -> 50 -> 100 -> 200` concurrency.
- Stable baseline pattern:
  - moderate p95 increase with higher concurrency
  - low 5xx rate
  - no sustained queue failure spikes

## 7. Bottleneck Identification Checklist
- High HTTP p95 + normal DB latency:
  - check OCR/NLP queue and worker concurrency pressure.
- High DB query duration + slow-query counter growth:
  - check DB pool sizing (`DB_POOL_MAX`) and query hotspots.
- High Redis latency + rate limiter warnings:
  - check Redis health/network saturation.
- Rising event loop delay and memory warnings:
  - inspect CPU pressure and heap growth patterns.

## 8. Performance Config Section
Use env vars to tune test environment shape (not business logic):
- DB pool: `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONN_TIMEOUT_MS`
- DB safety timeouts: `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_TX_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`
- Worker parallelism: `WORKER_CONCURRENCY`
- Rate limiter traffic controls: `RATE_LIMIT_PUBLIC_MAX`, `RATE_LIMIT_TENANT_MAX`, `RATE_LIMIT_WINDOW_SECONDS`
- Redis reconnect/timeout: `REDIS_CONNECT_TIMEOUT_MS`, `REDIS_RETRY_BASE_MS`, `REDIS_RETRY_MAX_MS`
- API compression threshold: `COMPRESSION_THRESHOLD_BYTES`
- Rate limiter latency guard: `RATE_LIMIT_TIMEOUT_MS`

## 9. Safe Tuning Notes
- Worker concurrency is capped against DB pool size to reduce connection starvation.
- Keep `DB_POOL_MAX` above worker concurrency with headroom for API queries.
- Statement and lock timeouts protect request latency during DB contention.
- Compression is enabled with a low threshold to reduce payload transfer time; `/metrics` is excluded.
- Redis client reuses one shared connection per process and uses bounded reconnect backoff.

## 10. Before vs After Template
Use this template for each tuning iteration:

| Scenario | Concurrency | p50 (ms) Before | p95 (ms) Before | p50 (ms) After | p95 (ms) After | Error % Before | Error % After | Notes |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `/api/process-prescription` sync | 10 |  |  |  |  |  |  |  |
| `/api/process-prescription` sync | 50 |  |  |  |  |  |  |  |
| `/api/process-prescription-async` | 100 |  |  |  |  |  |  |  |
| `/api/tenant/usage` auth | 200 |  |  |  |  |  |  |  |

Checklist per row:
- Validate no API schema change.
- Validate business behavior unchanged.
- Validate slow query counter trend.
- Validate queue failure/retry trend.
