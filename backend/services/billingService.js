import { createHash, randomBytes, randomUUID } from 'crypto';
import { getPlanById, getPlanCatalog } from '../config/billingPlans.js';
import { getPool, hasPostgres } from './pgService.js';
import { createStripeCheckoutSessionSkeleton } from './stripeService.js';

function hashApiKey(rawKey) {
    return createHash('sha256').update(rawKey).digest('hex');
}

export async function getTenantSubscription(tenantId) {
    if (!tenantId) return null;
    const fallbackPlan = getPlanById('free');

    if (!hasPostgres()) {
        return {
            tenantId,
            planId: fallbackPlan.id,
            status: 'active',
            monthlyQuota: fallbackPlan.monthlyQuota,
        };
    }

    const { rows } = await getPool().query(
        `
        SELECT tenant_id, plan_id, status, current_period_start, current_period_end
        FROM tenant_subscriptions
        WHERE tenant_id = $1
        LIMIT 1
        `,
        [tenantId]
    );

    const sub = rows[0];
    if (!sub) {
        return {
            tenantId,
            planId: fallbackPlan.id,
            status: 'active',
            monthlyQuota: fallbackPlan.monthlyQuota,
        };
    }

    const plan = getPlanById(sub.plan_id) || fallbackPlan;
    return {
        tenantId: sub.tenant_id,
        planId: sub.plan_id,
        status: sub.status,
        currentPeriodStart: sub.current_period_start,
        currentPeriodEnd: sub.current_period_end,
        monthlyQuota: plan.monthlyQuota,
    };
}

export async function previewPlanChange({ tenantId, targetPlanId }) {
    const current = await getTenantSubscription(tenantId);
    const nextPlan = getPlanById(targetPlanId);
    if (!nextPlan) {
        throw new Error('Unknown billing plan.');
    }

    return {
        tenantId,
        currentPlanId: current?.planId || 'free',
        targetPlanId: nextPlan.id,
        currentMonthlyQuota: current?.monthlyQuota || 0,
        targetMonthlyQuota: nextPlan.monthlyQuota,
        effectiveMode: 'next_billing_cycle',
        estimatedProrationCents: 0,
    };
}

export async function requestPlanChange({ tenantId, targetPlanId }) {
    const preview = await previewPlanChange({ tenantId, targetPlanId });
    const checkout = await createStripeCheckoutSessionSkeleton({
        tenantId,
        planId: targetPlanId,
    });

    return {
        accepted: true,
        preview,
        providerAction: checkout,
    };
}

export async function createApiKey({ tenantId, keyName, expiresAt = null }) {
    if (!tenantId) throw new Error('tenantId is required');
    if (!keyName) throw new Error('keyName is required');
    if (!hasPostgres()) throw new Error('Database required for API key management');

    const prefix = 'vk_' + randomBytes(6).toString('hex');
    const secret = randomBytes(24).toString('hex');
    const rawKey = `${prefix}.${secret}`;
    const keyHash = hashApiKey(rawKey);

    await getPool().query(
        `
        INSERT INTO api_keys (id, tenant_id, key_name, key_prefix, key_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [randomUUID(), tenantId, keyName, prefix, keyHash, expiresAt]
    );

    return {
        key: rawKey,
        prefix,
    };
}

export async function validateApiKey(rawKey) {
    if (!rawKey || !rawKey.includes('.')) return null;
    if (!hasPostgres()) return null;

    const keyHash = hashApiKey(rawKey);
    const { rows } = await getPool().query(
        `
        SELECT tenant_id, status, expires_at
        FROM api_keys
        WHERE key_hash = $1
        LIMIT 1
        `,
        [keyHash]
    );

    const row = rows[0];
    if (!row) return null;
    if (row.status !== 'active') return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

    return {
        tenantId: row.tenant_id,
        authType: 'api_key',
    };
}

export function listPlanCatalog() {
    return Object.values(getPlanCatalog());
}

