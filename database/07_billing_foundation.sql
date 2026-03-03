-- Billing foundation (non-breaking, optional)
-- This file adds billing and api-key scaffolding without changing existing API contracts.

CREATE TABLE IF NOT EXISTS billing_plans (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    monthly_quota INTEGER NOT NULL CHECK (monthly_quota > 0),
    monthly_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
    tenant_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES billing_plans(id),
    status TEXT NOT NULL DEFAULT 'active',
    current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 month'),
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_event_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_tenant_created
    ON billing_events (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    key_name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash_unique
    ON api_keys (key_hash);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_status
    ON api_keys (tenant_id, status);

INSERT INTO billing_plans (id, display_name, monthly_quota, monthly_price_cents, currency, active)
VALUES
    ('free', 'Free', 500, 0, 'USD', TRUE),
    ('pro', 'Pro', 5000, 2999, 'USD', TRUE),
    ('enterprise', 'Enterprise', 50000, 19999, 'USD', TRUE)
ON CONFLICT (id) DO NOTHING;

