/**
 * VAIDYADRISHTI AI — Ollama Model Puller
 *
 * Downloads the two required models via the local Ollama server.
 * The Ollama server must be running: npm run ollama:serve
 *
 * Models:
 *   llama3.2  (~2.0 GB) — NLP / medicine extraction
 *   llava     (~4.7 GB) — Vision OCR for handwritten prescriptions
 *
 * Usage:  npm run ollama:pull
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const OLLAMA_EXE = path.join(__dirname, '..', 'bin', 'ollama.exe');
const MODELS_DIR = path.join(__dirname, '..', 'bin', 'models');

const MODELS = [
    { name: 'llama3.2', size: '~2.0 GB', use: 'NLP / medicine extraction' },
    { name: 'llava',    size: '~4.7 GB', use: 'Vision OCR (handwritten prescriptions)' },
];

if (!fs.existsSync(OLLAMA_EXE)) {
    console.error('\n  ❌ Ollama binary not found. Run: npm run ollama:setup\n');
    process.exit(1);
}

function pullModel(modelName) {
    return new Promise((resolve, reject) => {
        console.log(`\n  ⬇️  Pulling ${modelName}...`);
        const child = spawn(OLLAMA_EXE, ['pull', modelName], {
            stdio: 'inherit',
            env: { ...process.env, OLLAMA_MODELS: MODELS_DIR },
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ollama pull ${modelName} exited with code ${code}`));
        });
    });
}

async function main() {
    console.log('\n  🦙 VAIDYADRISHTI AI — Pulling Ollama Models\n');
    console.log('  Models will be saved to: backend/bin/models/\n');

    for (const m of MODELS) {
        console.log(`  📦 ${m.name.padEnd(12)} ${m.size.padEnd(10)}  ${m.use}`);
    }
    console.log('\n  ⚠️  Total download: ~6.7 GB — this may take a while.\n');
    console.log('  Make sure Ollama server is running in another terminal:');
    console.log('    npm run ollama:serve\n');

    fs.mkdirSync(MODELS_DIR, { recursive: true });

    for (const m of MODELS) {
        try {
            await pullModel(m.name);
            console.log(`  ✅ ${m.name} ready`);
        } catch (err) {
            console.error(`  ❌ Failed to pull ${m.name}:`, err.message);
            console.error('  Make sure Ollama server is running: npm run ollama:serve');
            process.exit(1);
        }
    }

    console.log('\n  ✅ All models downloaded! You can now process prescriptions.\n');
}

main().catch((err) => {
    console.error('  ❌ Error:', err.message);
    process.exit(1);
});
