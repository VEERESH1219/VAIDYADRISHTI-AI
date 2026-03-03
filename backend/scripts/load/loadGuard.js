export function assertSafeLoadEnvironment() {
    const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
    const allowProd = String(process.env.LOAD_TEST_ALLOW_PROD || 'false').toLowerCase() === 'true';

    if (nodeEnv === 'production' && !allowProd) {
        throw new Error('Load tests are blocked in production. Set LOAD_TEST_ALLOW_PROD=true only for controlled environments.');
    }

    const token = process.env.LOAD_JWT_TOKEN;
    if (!token || token.trim().length === 0) {
        throw new Error('LOAD_JWT_TOKEN is required for auth-protected load tests.');
    }
}
