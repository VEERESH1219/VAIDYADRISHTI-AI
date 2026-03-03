import pino from 'pino';
import { loadEnv } from '../config/env.js';

loadEnv();

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
export const logger = pino({
    level: LOG_LEVEL,
    base: {
        service: process.env.SERVICE_NAME || 'vaidyadrishti-backend',
        env: process.env.NODE_ENV || 'development',
    },
    redact: {
        paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers.x-master-key',
            'headers.authorization',
            'headers.cookie',
            'headers.x-master-key',
            '*.authorization',
            '*.token',
            '*.apiKey',
            '*.api_key',
            '*.password',
            '*.secret',
            '*.masterKey',
            '*.master_key',
            '*.jwt',
            '*.refreshToken',
            '*.refresh_token',
            'err.config.headers.Authorization',
            'err.config.headers.authorization',
        ],
        censor: '[REDACTED]',
    },
});

export function getLogLevel() {
    return LOG_LEVEL;
}
