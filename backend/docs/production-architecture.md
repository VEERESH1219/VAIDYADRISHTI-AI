# Production Architecture Overview

This backend will run as a horizontally scalable API + worker system with shared PostgreSQL and Redis.

## Services
- `api` (Node.js/Express): Handles auth, tenancy, quota checks, request validation, sync processing, async job submission, and job status APIs.
- `worker` (Node.js/BullMQ): Executes heavy OCR/NLP/matching tasks from Redis queue and stores job results in PostgreSQL.
- `postgres` (PostgreSQL 16): System of record for medicines, tenants, usage logs, and async job metadata/results.
- `redis` (Redis 7): Shared distributed primitives for API rate limiting and background job queue.

## Request/Workload Model
- Existing sync endpoint (`POST /api/process-prescription`) remains intact for backward compatibility.
- New async workflow:
  1. Client submits `POST /api/process-prescription-async`.
  2. API enqueues job in Redis queue with tenant/user context.
  3. Worker processes OCR -> NLP -> matching.
  4. Worker updates `processing_jobs` table status/result.
  5. Client polls `GET /api/jobs/:jobId`.
- Quota logic remains in API request path and continues using DB-backed daily counts.

## Tenant and Security Boundaries
- JWT middleware remains authoritative for `tenantId`, `userId`, `role`.
- Rate limits are keyed by tenant for authenticated requests and by IP for public routes.
- Admin master-key routes remain isolated under `/admin`.

## Observability and Operability
- Structured JSON logs via Pino, including `requestId`, method, path, status, and duration.
- Health endpoints:
  - `GET /health/live`: process liveness only.
  - `GET /health/ready`: readiness including PostgreSQL + Redis checks.
  - `GET /health`: compatibility endpoint with expanded diagnostics.

## Deployment Topology
- Multi-stage Docker build for small production image.
- Compose stack for `api`, `worker`, `postgres`, `redis`.
- `.env.development` and `.env.production` split with runtime `NODE_ENV` loading.
- GitHub Actions CI validates installs, tests, and basic build integrity.

## Folder Direction
- `config/`: environment/runtime config loaders.
- `middleware/`: auth, rate limiter, request context.
- `jobs/`: queue definitions and processor functions.
- `workers/`: worker process entrypoint.
- `utils/`: logger and cross-cutting helpers.
