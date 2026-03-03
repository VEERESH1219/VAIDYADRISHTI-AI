import { spawn } from 'child_process';
import { assertSafeLoadEnvironment } from './loadGuard.js';

const mode = process.argv[2];

const targets = {
    sync: {
        method: 'POST',
        path: '/api/process-prescription',
        body: JSON.stringify({ raw_text: 'Paracetamol 500mg BD x 5 days' }),
    },
    async: {
        method: 'POST',
        path: '/api/process-prescription-async',
        body: JSON.stringify({ raw_text: 'Paracetamol 500mg BD x 5 days' }),
    },
    auth: {
        method: 'GET',
        path: '/api/tenant/usage',
        body: null,
    },
};

if (!targets[mode]) {
    process.stderr.write('Usage: node scripts/load/runAutocannon.js <sync|async|auth>\n');
    process.exit(1);
}

assertSafeLoadEnvironment();

const baseUrl = process.env.LOAD_BASE_URL || 'http://127.0.0.1:3001';
const levels = (process.env.LOAD_CONCURRENCY_LEVELS || '10,50,100,200')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
const durationSec = Number(process.env.LOAD_DURATION_SEC || 20);
const pipelining = Number(process.env.LOAD_PIPELINING || 1);
const token = process.env.LOAD_JWT_TOKEN;

async function runLevel(concurrency) {
    return new Promise((resolve, reject) => {
        const target = targets[mode];
        const url = `${baseUrl}${target.path}`;

        const args = [
            'autocannon',
            '-c', String(concurrency),
            '-d', String(durationSec),
            '-p', String(pipelining),
            '-m', target.method,
            '-H', `Authorization: Bearer ${token}`,
            '-H', 'Content-Type: application/json',
        ];

        if (target.body) {
            args.push('-b', target.body);
        }

        args.push(url);

        process.stdout.write(`\n[load-test] mode=${mode} concurrency=${concurrency} duration=${durationSec}s\n`);

        const child = spawn('npx', args, {
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) return resolve();
            return reject(new Error(`autocannon failed for concurrency ${concurrency} with exit code ${code}`));
        });
    });
}

for (const concurrency of levels) {
    // Sequential execution to produce clear baseline steps.
    await runLevel(concurrency);
}
