# Production Hardening Runbook

1. Create runtime env files:
   - `backend/.env.development` from `.env.development.example`
   - `backend/.env.production` from `.env.production.example`
2. Setup schema (includes `processing_jobs`):
   - `cd backend && npm run db:setup`
3. Start infra stack:
   - `docker compose up --build`
4. API checks:
   - `GET /health/live`
   - `GET /health/ready`
   - `GET /health`
5. Async job flow:
   - Submit: `POST /api/process-prescription-async`
   - Poll: `GET /api/jobs/:jobId`
6. Existing sync API remains unchanged:
   - `POST /api/process-prescription`

## Compose Services
- `postgres` (PostgreSQL 16)
- `redis` (rate limiting + queue)
- `api` (Express backend)
- `worker` (BullMQ processor)
