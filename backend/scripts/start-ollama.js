/**
 * VAIDYADRISHTI AI — Ollama Server Launcher
 *
 * Starts the local Ollama server from backend/bin/ollama.exe.
 * Run setup first if the binary is missing: npm run ollama:setup
 *
 * Usage:  npm run ollama:serve
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const OLLAMA_EXE = path.join(__dirname, '..', 'bin', 'ollama.exe');

if (!fs.existsSync(OLLAMA_EXE)) {
    console.error('\n  ❌ Ollama binary not found at backend/bin/ollama.exe');
    console.error('  Run this first:  npm run ollama:setup\n');
    process.exit(1);
}

console.log('\n  🦙 Starting Ollama server on http://127.0.0.1:11434 ...\n');

const child = spawn(OLLAMA_EXE, ['serve'], {
    stdio: 'inherit',
    env: {
        ...process.env,
        // Store models in backend/bin/models so they stay with the project
        OLLAMA_MODELS: path.join(__dirname, '..', 'bin', 'models'),
    },
});

child.on('error', (err) => {
    console.error('\n  ❌ Failed to start Ollama:', err.message);
    console.error('  Make sure setup completed:  npm run ollama:setup\n');
    process.exit(1);
});

child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
        console.error(`\n  Ollama exited with code ${code}`);
    }
});

// Graceful shutdown
process.on('SIGINT',  () => { child.kill('SIGINT');  });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
