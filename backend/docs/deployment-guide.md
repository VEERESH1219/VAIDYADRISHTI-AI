# Deployment Guide

## Scope
Provider-neutral production deployment for the existing multi-tenant SaaS backend.

## Files Added for Production Deployments
- `docker-compose.production.yml`
- `backend/.env.cloud.production.example`
- `deploy/nginx/nginx.conf`

## Compose Usage
Run with base + production override:

```bash
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

This keeps PostgreSQL and Redis internal and routes traffic through NGINX TLS reverse proxy.

## Secrets Management Guidance
- Do not commit real secrets to git.
- Use a secret manager (AWS Secrets Manager, GCP Secret Manager, Render encrypted env vars, Vault).
- Inject runtime secrets as environment variables at deployment time.
- Rotate:
  - `JWT_SECRET`
  - `MASTER_ADMIN_KEY`
  - `POSTGRES_PASSWORD`
  - `STRIPE_SECRET_KEY` (if billing provider enabled)
  - `SENTRY_DSN` (if error tracker enabled)
- Keep `.env.cloud.production.example` as a template only.

## HTTPS Reverse Proxy Notes
- The sample NGINX config terminates TLS and proxies to `api:3001`.
- Place certificate files in `deploy/nginx/certs`:
  - `fullchain.pem`
  - `privkey.pem`
- In managed cloud ingress environments, you can keep TLS termination at ingress and reuse only the proxy headers.

## Healthcheck Tuning
- The production override uses longer start periods and retries to avoid false restarts during cold starts.
- API readiness still uses `/health/ready`.
- Worker healthcheck is process-based and intentionally lightweight.

## Deployment Checklist
- [ ] Copy `backend/.env.cloud.production.example` to secure runtime env and fill real values.
- [ ] Confirm `NODE_ENV=production`.
- [ ] Confirm DB and Redis are private/internal only.
- [ ] Confirm only reverse-proxy publishes public ports.
- [ ] Confirm API and worker run as non-root.
- [ ] Confirm secrets are loaded from secret manager, not committed files.
- [ ] Confirm `/health/live` and `/health/ready` both pass after startup.
- [ ] Confirm `/metrics` is reachable only from monitoring network or secured gateway.
- [ ] Confirm backup policy for PostgreSQL data volume.
- [ ] Confirm log shipping and retention policy.

