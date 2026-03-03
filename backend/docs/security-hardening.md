# Security Hardening

## Attack Surface Overview
- Public HTTP interface on API service (`:3001`) with authenticated tenant routes and master-key admin routes.
- JWT-based tenant authentication and role propagation.
- Redis-backed rate limiter and queueing.
- PostgreSQL data plane containing tenant-scoped usage and job records.
- Containerized deployment (`api`, `worker`, `postgres`, `redis`) with shared internal network.

## Mitigation Summary
- HTTP security headers and hardening:
  - Helmet enabled with strict baseline policy.
  - Content-Security-Policy defaults to deny-by-default directives for API responses.
  - `X-Powered-By` disabled.
  - Explicit JSON and urlencoded body-size limits from environment.
- JWT hardening:
  - Secret strength requirement increased (`JWT_SECRET` >= 32 chars).
  - Verification pinned to `HS256`; issuer/audience enforced.
  - Strict max token age and expiration checks.
  - Tokens without required claims (`tenantId`, `userId`, `role`, `sub`, `iat`, `exp`) rejected.
  - Admin token generation now uses explicit algorithm, issuer, audience, TTL, and `jti`.
- Rate limiting improvements:
  - Layered per-IP and per-tenant limits on API paths.
  - Separate auth endpoint limiter for admin auth routes.
  - Failed-auth throttling to slow brute-force token/master-key attempts.
- Input validation and sanitization:
  - Request validation middleware applied across all existing route handlers.
  - Prototype pollution keys (`__proto__`, `constructor`, `prototype`) blocked across body/query/params.
  - Basic payload type and size constraints for prescription routes.
- Multi-tenant isolation safeguards:
  - Tenant isolation middleware enforces authenticated tenant scope consistency on `/api` routes.
  - Existing DB access paths reviewed: tenant-scoped queries use parameterized SQL and tenant filters.
- Docker/runtime security:
  - Runtime containers remain non-root (`node`) with owned app files.
  - Compose hardening for `api` and `worker`: dropped Linux capabilities and `no-new-privileges`.
- Logging security:
  - Structured logger redaction configured for auth headers, tokens, API keys, passwords, secrets, and master keys.

## Remaining Risks / Follow-ups
- Redis limiter strategy is fail-open on Redis outage to preserve availability; this intentionally reduces protection during cache/network incidents.
- Legacy scripts and integrations still reference Supabase workflows; these are not on runtime path but should be isolated/retired if not needed.
- Current API CORS policy remains permissive and should be restricted to trusted origins in production.
- Full WAF and DDoS protection should be implemented at ingress/load-balancer layer.

## Recommended Production Firewall Rules
- Inbound:
  - Allow `443/tcp` to public ingress/load balancer only.
  - Deny direct public access to backend container/VM ports (`3001`, `5432`, `6379`).
- East-west/internal:
  - Allow `api` and `worker` to reach PostgreSQL (`5432`) and Redis (`6379`) only on private network.
  - Deny lateral access from unrelated workloads/namespaces.
- Egress:
  - Allow only required external endpoints (LLM/OCR providers, package mirrors during build stage).
  - Block unrestricted outbound traffic from runtime pods/containers where possible.
- Admin access:
  - Restrict SSH/management ports by source IP allowlist and MFA-protected bastion.
  - Rotate and vault all secrets; never place secrets in compose files or logs.
