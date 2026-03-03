# Monitoring Guide

## Overview
This project exposes Prometheus metrics at `/metrics` and structured logs through Pino.

## Assets
- Prometheus scrape config example: `backend/observability/prometheus/prometheus.example.yml`
- Prometheus alert rules example: `backend/observability/prometheus/alerts.example.yml`
- Grafana dashboard template: `backend/observability/grafana/vaidyadrishti-dashboard.json`

## Key Signals
- API latency and error rate:
  - `vaidyadrishti_http_request_duration_seconds`
  - `vaidyadrishti_http_errors_total`
- Queue health:
  - `vaidyadrishti_queue_job_duration_seconds`
  - `vaidyadrishti_queue_job_failures_total`
  - `vaidyadrishti_queue_active_jobs`
- DB and Redis:
  - `vaidyadrishti_db_query_duration_seconds`
  - `vaidyadrishti_db_slow_queries_total`
  - `vaidyadrishti_redis_latency_seconds`
- Resource pressure:
  - `vaidyadrishti_process_heap_used_bytes`
  - `vaidyadrishti_process_rss_bytes`
  - `vaidyadrishti_event_loop_delay_seconds`

## Error Tracking (Pluggable)
- Set `ERROR_TRACKER_PROVIDER=sentry` and `SENTRY_DSN=<dsn>` to enable Sentry.
- Default is disabled (`ERROR_TRACKER_PROVIDER=none`), so no external calls are made.
- This integration is non-blocking; failures in tracker initialization do not break API/worker startup.

## High-load Safety
- Metrics snapshots are cached for a short window (`METRICS_SNAPSHOT_CACHE_MS`, default `1000ms`) to reduce collection overhead under heavy scrape concurrency.
- `/metrics` sets `Cache-Control: no-store` to avoid stale intermediary cache behavior.

## Recommended Alerts
- Sustained 5xx error rate > 2%
- Redis p95 latency > 200ms
- Elevated DB slow-query rate

