import Stripe from 'stripe';

function isStripeEnabled() {
    const provider = (process.env.BILLING_PROVIDER || 'disabled').toLowerCase();
    return provider === 'stripe' && Boolean(process.env.STRIPE_SECRET_KEY);
}

let stripeClient = null;

function getStripeClient() {
    if (!isStripeEnabled()) return null;
    if (!stripeClient) {
        stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
            apiVersion: '2024-06-20',
            timeout: Number(process.env.STRIPE_TIMEOUT_MS || 10_000),
        });
    }
    return stripeClient;
}

export function getBillingProviderState() {
    return {
        provider: (process.env.BILLING_PROVIDER || 'disabled').toLowerCase(),
        enabled: isStripeEnabled(),
    };
}

export async function createStripeCheckoutSessionSkeleton({ tenantId, planId }) {
    const client = getStripeClient();
    if (!client) {
        return {
            enabled: false,
            mode: 'disabled',
            tenantId,
            planId,
            message: 'Billing provider disabled.',
        };
    }

    return {
        enabled: true,
        mode: 'skeleton',
        tenantId,
        planId,
        message: 'Stripe integration skeleton active; checkout session creation is intentionally not executed.',
    };
}

