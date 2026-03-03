import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const register = new Registry();
const METRICS_SNAPSHOT_CACHE_MS = Number(process.env.METRICS_SNAPSHOT_CACHE_MS || 1000);
let metricsCacheValue = '';
let metricsCacheUntil = 0;
let metricsInFlight = null;
collectDefaultMetrics({
    register,
    prefix: 'vaidyadrishti_',
});

const httpRequestCount = new Counter({
    name: 'vaidyadrishti_http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
});

const httpErrorCount = new Counter({
    name: 'vaidyadrishti_http_errors_total',
    help: 'Total number of HTTP 4xx/5xx responses',
    labelNames: ['method', 'route', 'status_code', 'class'],
    registers: [register],
});

const httpRequestDuration = new Histogram({
    name: 'vaidyadrishti_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [register],
});

const queueJobDuration = new Histogram({
    name: 'vaidyadrishti_queue_job_duration_seconds',
    help: 'Queue job processing duration in seconds',
    labelNames: ['job_name', 'status'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [register],
});

const queueJobFailures = new Counter({
    name: 'vaidyadrishti_queue_job_failures_total',
    help: 'Total number of failed queue jobs',
    labelNames: ['job_name'],
    registers: [register],
});

const queueJobSuccess = new Counter({
    name: 'vaidyadrishti_queue_job_success_total',
    help: 'Total number of successful queue jobs',
    labelNames: ['job_name'],
    registers: [register],
});

const queueJobRetries = new Counter({
    name: 'vaidyadrishti_queue_job_retries_total',
    help: 'Total number of queue retry attempts consumed',
    labelNames: ['job_name'],
    registers: [register],
});

const queueActiveJobs = new Gauge({
    name: 'vaidyadrishti_queue_active_jobs',
    help: 'Current number of active jobs being processed',
    labelNames: ['job_name'],
    registers: [register],
});

const dbQueryDuration = new Histogram({
    name: 'vaidyadrishti_db_query_duration_seconds',
    help: 'PostgreSQL query duration in seconds',
    labelNames: ['operation', 'success'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [register],
});

const dbSlowQueries = new Counter({
    name: 'vaidyadrishti_db_slow_queries_total',
    help: 'Total number of slow PostgreSQL queries',
    labelNames: ['operation'],
    registers: [register],
});

const redisLatency = new Histogram({
    name: 'vaidyadrishti_redis_latency_seconds',
    help: 'Redis operation latency in seconds',
    labelNames: ['operation', 'success'],
    buckets: [0.001, 0.003, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register],
});

const processHeapUsed = new Gauge({
    name: 'vaidyadrishti_process_heap_used_bytes',
    help: 'Current process heap used in bytes',
    labelNames: ['role'],
    registers: [register],
});

const processRss = new Gauge({
    name: 'vaidyadrishti_process_rss_bytes',
    help: 'Current process RSS memory in bytes',
    labelNames: ['role'],
    registers: [register],
});

const eventLoopDelay = new Gauge({
    name: 'vaidyadrishti_event_loop_delay_seconds',
    help: 'Event loop delay in seconds',
    labelNames: ['role'],
    registers: [register],
});

function safeRecord(fn) {
    try {
        fn();
    } catch {
        // Metrics must never break request flow.
    }
}

export function normalizeRoute(path) {
    if (!path) return 'unknown';
    return String(path)
        .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/g, ':id')
        .replace(/\b\d+\b/g, ':id');
}

export function recordHttpMetrics({ method, route, statusCode, durationMs }) {
    const labels = {
        method: String(method || 'UNKNOWN').toUpperCase(),
        route: normalizeRoute(route),
        status_code: String(statusCode || 0),
    };

    safeRecord(() => {
        httpRequestCount.inc(labels);
        httpRequestDuration.observe(labels, Math.max(0, Number(durationMs || 0)) / 1000);

        if (Number(statusCode) >= 400) {
            httpErrorCount.inc({
                ...labels,
                class: Number(statusCode) >= 500 ? '5xx' : '4xx',
            });
        }
    });
}

export function recordQueueJobStart(jobName) {
    safeRecord(() => queueActiveJobs.inc({ job_name: jobName }));
}

export function recordQueueJobFinish({ jobName, durationMs, success }) {
    safeRecord(() => {
        queueActiveJobs.dec({ job_name: jobName });
        queueJobDuration.observe({ job_name: jobName, status: success ? 'success' : 'failure' }, Math.max(0, durationMs) / 1000);
        if (success) {
            queueJobSuccess.inc({ job_name: jobName });
        } else {
            queueJobFailures.inc({ job_name: jobName });
        }
    });
}

export function recordQueueRetry(jobName) {
    safeRecord(() => queueJobRetries.inc({ job_name: jobName }));
}

export function recordQueueJobRetry(jobName) {
    recordQueueRetry(jobName);
}

export function recordDbQuery({ operation, durationMs, success, isSlow }) {
    safeRecord(() => {
        dbQueryDuration.observe(
            { operation: operation || 'unknown', success: success ? 'true' : 'false' },
            Math.max(0, durationMs) / 1000
        );

        if (isSlow) {
            dbSlowQueries.inc({ operation: operation || 'unknown' });
        }
    });
}

export function recordRedisLatency({ operation, durationMs, success }) {
    safeRecord(() => {
        redisLatency.observe(
            { operation: operation || 'unknown', success: success ? 'true' : 'false' },
            Math.max(0, durationMs) / 1000
        );
    });
}

export function recordResourceMetrics({ role, heapUsed, rss, eventLoopDelaySeconds }) {
    safeRecord(() => {
        processHeapUsed.set({ role }, Math.max(0, Number(heapUsed || 0)));
        processRss.set({ role }, Math.max(0, Number(rss || 0)));
        eventLoopDelay.set({ role }, Math.max(0, Number(eventLoopDelaySeconds || 0)));
    });
}

export function getMetricsContentType() {
    return register.contentType;
}

export async function getMetricsSnapshot() {
    const now = Date.now();
    if (metricsCacheValue && now < metricsCacheUntil) {
        return metricsCacheValue;
    }

    if (!metricsInFlight) {
        metricsInFlight = register.metrics()
            .then((snapshot) => {
                metricsCacheValue = snapshot;
                metricsCacheUntil = Date.now() + METRICS_SNAPSHOT_CACHE_MS;
                return snapshot;
            })
            .finally(() => {
                metricsInFlight = null;
            });
    }

    return metricsInFlight;
}
