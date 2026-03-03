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
});

export function getLogLevel() {
    return LOG_LEVEL;
}
