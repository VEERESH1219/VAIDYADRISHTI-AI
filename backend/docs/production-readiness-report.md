# Production Readiness Report

Date: 2026-03-03
Project: VAIDYADRISHTI AI (`backend`)
Branch: `main`

## What Is Done
- Stability hardening, observability, and safe performance tuning from previous passes are present in current `main`.
- Final audit pass completed for:
  - startup validation behavior
  - `/health/live`, `/health/ready`, `/metrics`
  - worker startup behavior
  - tuning env variable consistency across `.env` templates
- Safe minimal fix applied:
  - Added `recordQueueJobRetry` export alias in `observability/metrics.js` to match worker import and prevent worker startup crash.

## What Is Verified

### 1. Startup Validation
- API startup fails fast when required env values are placeholder/missing (verified by direct `node server.js` run with placeholder secrets).
- Worker env validation path is active (worker starts only with required worker vars; with valid env it boots and logs expected startup).

### 2. Health and Metrics Endpoints
- `GET /health/live` returns `200` with liveness JSON.
- `GET /health/ready` returns `503` with degraded JSON when Redis/DB are unavailable in audit environment.
- `GET /metrics` returns `200` with Prometheus content type:
  - `text/plain; charset=utf-8; version=0.0.4`
- Compression behavior check:
  - `/metrics` response omits gzip/content-encoding even when `Accept-Encoding: gzip` is sent (expected due exclusion).

### 3. Worker Startup Behavior
- Worker now starts successfully after metrics export fix.
- Concurrency capping works as designed:
  - With `WORKER_CONCURRENCY=20` and `DB_POOL_MAX=10`, worker logs `appliedConcurrency=8`.
- Redis unavailable scenario produces connection/worker error logs without process crash.

### 4. Env Tuning Consistency
- Verified presence of tuning vars in:
  - `.env.example`
  - `.env.development.example`
  - `.env.production.example`
- Variables checked:
  - `DB_POOL_MAX`, `DB_POOL_MIN`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONN_TIMEOUT_MS`
  - `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_TX_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`
  - `REDIS_CONNECT_TIMEOUT_MS`, `REDIS_RETRY_BASE_MS`, `REDIS_RETRY_MAX_MS`
  - `RATE_LIMIT_WINDOW_SECONDS`, `RATE_LIMIT_PUBLIC_MAX`, `RATE_LIMIT_TENANT_MAX`, `RATE_LIMIT_TIMEOUT_MS`
  - `GLOBAL_REQUEST_TIMEOUT_MS`, `WORKER_CONCURRENCY`, `JOB_MAX_ATTEMPTS`, `JOB_BACKOFF_MS`
  - `COMPRESSION_THRESHOLD_BYTES`

## Known Risks / Follow-ups
- Audit environment currently had Redis/DB endpoints unavailable; readiness stayed `503` as expected.
- Some local `.env` values are placeholders (secrets/DB creds), which intentionally block API startup until replaced.
- Worker logs can be noisy during prolonged Redis outage (`worker_error` repeats frequently). Consider future log-throttling for worker reconnect errors.

## Recommended Production Env Values (Safe Defaults)
Use as baseline; adjust with observed load and DB capacity.

- `NODE_ENV=production`
- `PORT=3001`
- `LOG_LEVEL=info`
- `GLOBAL_REQUEST_TIMEOUT_MS=45000`

- `DB_POOL_MAX=20`
- `DB_POOL_MIN=4`
- `DB_POOL_IDLE_TIMEOUT_MS=30000`
- `DB_POOL_CONN_TIMEOUT_MS=5000`
- `DB_STATEMENT_TIMEOUT_MS=10000`
- `DB_IDLE_TX_TIMEOUT_MS=12000`
- `DB_LOCK_TIMEOUT_MS=5000`

- `WORKER_CONCURRENCY=4`
  - Keep this less than DB pool with headroom; current worker also enforces a safe cap.
- `JOB_MAX_ATTEMPTS=3`
- `JOB_BACKOFF_MS=2000`

- `REDIS_CONNECT_TIMEOUT_MS=5000`
- `REDIS_RETRY_BASE_MS=200`
- `REDIS_RETRY_MAX_MS=2000`

- `RATE_LIMIT_WINDOW_SECONDS=60`
- `RATE_LIMIT_PUBLIC_MAX=120`
- `RATE_LIMIT_TENANT_MAX=500`
- `RATE_LIMIT_TIMEOUT_MS=800`

- `COMPRESSION_THRESHOLD_BYTES=1024`

## Final Audit Outcome
- Status: Conditionally production-ready.
- Condition: Replace placeholders with real secrets/credentials and validate with live PostgreSQL + Redis infrastructure where `/health/ready` should return `200`.
