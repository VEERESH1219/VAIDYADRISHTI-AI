# Load Testing Guide

This document provides safe baseline load-testing commands for production-style validation.

## Preconditions
- Start full stack (`api`, `worker`, `postgres`, `redis`).
- Use a non-production tenant and token.
- Disable expensive OCR images for baseline API tests (`raw_text` payload).

## Autocannon Baseline

Install:
```bash
npm i -g autocannon
```

Health endpoint throughput:
```bash
autocannon -c 100 -d 30 -p 10 http://127.0.0.1:3001/health/live
```

Authenticated sync API baseline:
```bash
autocannon -c 30 -d 60 -p 5 \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -m POST \
  -b '{"raw_text":"Paracetamol 500mg BD x 5 days"}' \
  http://127.0.0.1:3001/api/process-prescription
```

Authenticated async enqueue baseline:
```bash
autocannon -c 50 -d 60 -p 10 \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -m POST \
  -b '{"raw_text":"Paracetamol 500mg BD x 5 days"}' \
  http://127.0.0.1:3001/api/process-prescription-async
```

## Artillery Scenario

Install:
```bash
npm i -g artillery
```

Example config (`artillery-observability.yml`):
```yaml
config:
  target: "http://127.0.0.1:3001"
  phases:
    - duration: 60
      arrivalRate: 10
  defaults:
    headers:
      Authorization: "Bearer <JWT_TOKEN>"
      Content-Type: "application/json"
scenarios:
  - name: "sync prescription"
    flow:
      - post:
          url: "/api/process-prescription"
          json:
            raw_text: "Paracetamol 500mg BD x 5 days"
  - name: "async enqueue"
    flow:
      - post:
          url: "/api/process-prescription-async"
          json:
            raw_text: "Paracetamol 500mg BD x 5 days"
```

Run:
```bash
artillery run artillery-observability.yml
```

## What to Observe
- `/metrics` for request latency and error rates.
- Queue metrics for active jobs, failures, retries.
- DB query histogram and slow query counter.
- Resource monitor logs (`heapUsed`, `rss`, `eventLoopDelay`).

## Baseline Targets (starting point)
- p95 `/health/live`: < 50 ms
- 5xx error rate: 0%
- Rate limiter failures due to backend outage: 0 request crashes
- Queue job failure rate: < 1% (excluding induced fault tests)
