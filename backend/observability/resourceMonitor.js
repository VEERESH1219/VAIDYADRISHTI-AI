import { monitorEventLoopDelay } from 'perf_hooks';
import { logger } from '../utils/logger.js';
import { recordResourceMetrics } from './metrics.js';

const MB = 1024 * 1024;

export function startResourceMonitor({ role }) {
    const intervalMs = Number(process.env.RESOURCE_MONITOR_INTERVAL_MS || 30000);
    const heapWarnMb = Number(process.env.RESOURCE_HEAP_WARN_MB || 1024);
    const rssWarnMb = Number(process.env.RESOURCE_RSS_WARN_MB || 1536);
    const eventLoopWarnMs = Number(process.env.EVENT_LOOP_DELAY_WARN_MS || 200);

    const loopMonitor = monitorEventLoopDelay({ resolution: 20 });
    loopMonitor.enable();

    const timer = setInterval(() => {
        const mem = process.memoryUsage();
        const loopDelaySeconds = loopMonitor.mean / 1e9;
        const loopDelayMs = loopDelaySeconds * 1000;

        recordResourceMetrics({
            role,
            heapUsed: mem.heapUsed,
            rss: mem.rss,
            eventLoopDelaySeconds: loopDelaySeconds,
        });

        if (mem.heapUsed >= heapWarnMb * MB || mem.rss >= rssWarnMb * MB || loopDelayMs >= eventLoopWarnMs) {
            logger.warn({
                role,
                heapUsedMb: Math.round(mem.heapUsed / MB),
                rssMb: Math.round(mem.rss / MB),
                eventLoopDelayMs: Number(loopDelayMs.toFixed(2)),
                heapWarnMb,
                rssWarnMb,
                eventLoopWarnMs,
            }, 'resource_monitor_threshold_exceeded');
        } else {
            logger.debug({
                role,
                heapUsedMb: Math.round(mem.heapUsed / MB),
                rssMb: Math.round(mem.rss / MB),
                eventLoopDelayMs: Number(loopDelayMs.toFixed(2)),
            }, 'resource_monitor_sample');
        }

        loopMonitor.reset();
    }, intervalMs);

    timer.unref();

    return () => {
        clearInterval(timer);
        loopMonitor.disable();
    };
}
