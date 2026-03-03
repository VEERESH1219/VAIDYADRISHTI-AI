const DEFAULTS = {
    free: Number(process.env.BILLING_MONTHLY_QUOTA_FREE || 500),
    pro: Number(process.env.BILLING_MONTHLY_QUOTA_PRO || 5000),
    enterprise: Number(process.env.BILLING_MONTHLY_QUOTA_ENTERPRISE || 50000),
};

export function getPlanCatalog() {
    return {
        free: {
            id: 'free',
            displayName: 'Free',
            monthlyQuota: DEFAULTS.free,
            priceCents: 0,
        },
        pro: {
            id: 'pro',
            displayName: 'Pro',
            monthlyQuota: DEFAULTS.pro,
            priceCents: 2999,
        },
        enterprise: {
            id: 'enterprise',
            displayName: 'Enterprise',
            monthlyQuota: DEFAULTS.enterprise,
            priceCents: 19999,
        },
    };
}

export function getPlanById(planId) {
    const catalog = getPlanCatalog();
    return catalog[planId] || null;
}

