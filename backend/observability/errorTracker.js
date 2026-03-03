import { logger } from '../utils/logger.js';

let sentryModule = null;
let trackerEnabled = false;

function isSentryEnabled() {
    const provider = (process.env.ERROR_TRACKER_PROVIDER || 'none').toLowerCase();
    return provider === 'sentry' && Boolean(process.env.SENTRY_DSN);
}

export async function initErrorTracker({ service }) {
    if (!isSentryEnabled()) return;
    if (trackerEnabled) return;

    try {
        const sentry = await import('@sentry/node');
        sentry.init({
            dsn: process.env.SENTRY_DSN,
            environment: process.env.NODE_ENV || 'development',
            release: process.env.APP_VERSION || 'dev',
            tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
            enabled: true,
            initialScope: {
                tags: {
                    service,
                },
            },
        });
        sentryModule = sentry;
        trackerEnabled = true;
        logger.info({ service }, 'error_tracker_initialized');
    } catch (err) {
        logger.warn({ err: err?.message }, 'error_tracker_init_failed');
    }
}

export function captureError(error, context = {}) {
    if (!trackerEnabled || !sentryModule) return;
    sentryModule.withScope((scope) => {
        Object.entries(context).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                scope.setExtra(key, value);
            }
        });
        sentryModule.captureException(error);
    });
}

export async function flushErrorTracker(timeoutMs = 1200) {
    if (!trackerEnabled || !sentryModule) return;
    try {
        await sentryModule.flush(timeoutMs);
    } catch {
        // Best effort.
    }
}

