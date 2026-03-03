import { loadEnv } from './env.js';

loadEnv();

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isPlaceholder(value) {
    if (!isNonEmptyString(value)) return true;
    const normalized = value.trim().toLowerCase();
    return normalized.includes('replace-with') || normalized === 'changeme' || normalized.endsWith('...');
}

function isPositiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0;
}

function requireVar(name, errors) {
    if (!isNonEmptyString(process.env[name])) {
        errors.push(`Missing required env var: ${name}`);
    }
}

function requireNonPlaceholderVar(name, errors) {
    requireVar(name, errors);
    if (process.env[name] !== undefined && isPlaceholder(process.env[name])) {
        errors.push(`Env var ${name} still contains a placeholder value`);
    }
}

function requireStrongSecret(name, minLength, errors) {
    const value = process.env[name];
    if (!isNonEmptyString(value)) {
        errors.push(`Missing required env var: ${name}`);
        return;
    }
    if (isPlaceholder(value)) {
        errors.push(`Env var ${name} still contains a placeholder value`);
        return;
    }
    if (value.trim().length < minLength) {
        errors.push(`Env var ${name} must be at least ${minLength} characters`);
    }
}

function requirePositiveInt(name, errors) {
    if (!isPositiveInteger(process.env[name])) {
        errors.push(`Env var ${name} must be a positive integer`);
    }
}

function validateOptionalPositiveInt(name, errors) {
    if (process.env[name] === undefined || process.env[name] === '') return;
    if (!isPositiveInteger(process.env[name])) {
        errors.push(`Env var ${name} must be a positive integer when provided`);
    }
}

function validateDatabaseConfig(errors) {
    if (isNonEmptyString(process.env.DATABASE_URL)) {
        if (isPlaceholder(process.env.DATABASE_URL)) {
            errors.push('Env var DATABASE_URL still contains a placeholder value');
        }
        return;
    }

    ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'].forEach((name) => {
        requireVar(name, errors);
        if (isPlaceholder(process.env[name])) {
            errors.push(`Env var ${name} still contains a placeholder value`);
        }
    });

    if (isNonEmptyString(process.env.POSTGRES_PORT) && !isPositiveInteger(process.env.POSTGRES_PORT)) {
        errors.push('POSTGRES_PORT must be a positive integer');
    }
}

function validateProviderSecrets(errors) {
    const modelProvider = (process.env.MODEL_PROVIDER || '').toLowerCase();
    const visionProvider = (process.env.VISION_PROVIDER || '').toLowerCase();

    const providers = new Set([modelProvider, visionProvider]);

    if (providers.has('openai')) requireNonPlaceholderVar('OPENAI_API_KEY', errors);
    if (providers.has('anthropic')) requireNonPlaceholderVar('ANTHROPIC_API_KEY', errors);
    if (providers.has('gemini')) requireNonPlaceholderVar('GEMINI_API_KEY', errors);
    if (providers.has('google')) requireNonPlaceholderVar('GOOGLE_VISION_API_KEY', errors);
    if (providers.has('ollama')) requireNonPlaceholderVar('OLLAMA_ENDPOINT', errors);
}

export function validateEnvOrThrow({ role }) {
    const errors = [];

    if (!isNonEmptyString(process.env.NODE_ENV)) {
        errors.push('Missing required env var: NODE_ENV');
    }

    if (role === 'api') {
        requireVar('PORT', errors);
        requireStrongSecret('JWT_SECRET', 24, errors);
        requireStrongSecret('MASTER_ADMIN_KEY', 24, errors);
        requirePositiveInt('RATE_LIMIT_WINDOW_SECONDS', errors);
        requirePositiveInt('RATE_LIMIT_PUBLIC_MAX', errors);
        requirePositiveInt('RATE_LIMIT_TENANT_MAX', errors);
        requirePositiveInt('GLOBAL_REQUEST_TIMEOUT_MS', errors);
    }

    if (role === 'worker') {
        requirePositiveInt('WORKER_CONCURRENCY', errors);
        requirePositiveInt('JOB_MAX_ATTEMPTS', errors);
        requirePositiveInt('JOB_BACKOFF_MS', errors);
    }

    requireVar('REDIS_URL', errors);
    if (isPlaceholder(process.env.REDIS_URL)) {
        errors.push('Env var REDIS_URL still contains a placeholder value');
    }
    validateDatabaseConfig(errors);
    validateProviderSecrets(errors);
    validateOptionalPositiveInt('DB_POOL_MAX', errors);
    validateOptionalPositiveInt('DB_POOL_IDLE_TIMEOUT_MS', errors);
    validateOptionalPositiveInt('DB_POOL_CONN_TIMEOUT_MS', errors);

    if (errors.length > 0) {
        const message = `Environment validation failed (${role}):\n- ${errors.join('\n- ')}`;
        throw new Error(message);
    }
}
