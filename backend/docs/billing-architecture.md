# Billing Architecture (Foundation)

## Intent
This is a non-breaking monetization foundation layer. Existing quota logic and API contracts remain unchanged.

## Added Components
- SQL schema extension: `database/07_billing_foundation.sql`
- Plan/quota catalog model: `backend/config/billingPlans.js`
- Billing service skeleton: `backend/services/billingService.js`
- Stripe provider skeleton (flag-gated): `backend/services/stripeService.js`

## Data Model
- `billing_plans`: canonical plans (`free`, `pro`, `enterprise`) and quotas.
- `tenant_subscriptions`: tenant-to-plan mapping and billing cycle metadata.
- `billing_events`: external provider webhook/event storage.
- `api_keys`: optional tenant API key support (hashed keys only).

## Provider Strategy
- `BILLING_PROVIDER=disabled` by default.
- `BILLING_PROVIDER=stripe` enables Stripe client initialization if `STRIPE_SECRET_KEY` is present.
- No live payment/session execution is performed in current skeleton paths.

## Plan Upgrade/Downgrade Structure
- `previewPlanChange(...)` computes change intent and quota deltas.
- `requestPlanChange(...)` returns accepted structure + provider-action skeleton.
- This isolates future checkout/workflow additions from current business logic.

## Security Notes
- API keys are stored as SHA-256 hash only; raw keys are returned once at creation.
- Tenant-scoped queries are parameterized.
- No production payment calls occur unless provider is explicitly enabled and implementation is expanded.

