import dotenv from 'dotenv';

dotenv.config();

const LEVEL_PRIORITY = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const DEFAULT_LEVEL = 'info';
const configuredLevel = (process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
const activeLevel = LEVEL_PRIORITY[configuredLevel] ? configuredLevel : DEFAULT_LEVEL;

function shouldLog(level) {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[activeLevel];
}

function write(level, ...args) {
    if (!shouldLog(level)) return;

    if (level === 'error') {
        console.error(...args);
        return;
    }

    if (level === 'warn') {
        console.warn(...args);
        return;
    }

    console.log(...args);
}

export const logger = {
    debug: (...args) => write('debug', ...args),
    info: (...args) => write('info', ...args),
    warn: (...args) => write('warn', ...args),
    error: (...args) => write('error', ...args),
};

export function getLogLevel() {
    return activeLevel;
}
