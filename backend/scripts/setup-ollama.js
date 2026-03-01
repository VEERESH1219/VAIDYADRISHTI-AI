/**
 * VAIDYADRISHTI AI — Ollama Setup Script
 *
 * Downloads the Ollama portable binary for Windows into backend/bin/ollama.exe
 * No system-wide installation required.
 *
 * Usage:  npm run ollama:setup
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BIN_DIR   = path.join(__dirname, '..', 'bin');
const OLLAMA_EXE = path.join(BIN_DIR, 'ollama.exe');
const ZIP_PATH   = path.join(BIN_DIR, 'ollama.zip');

// Latest Ollama portable release for Windows
const OLLAMA_URL = 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip';

// ── Download with redirect following ──────────────────────────────────────
// WriteStream is only opened AFTER all redirects are resolved (status 200).
function download(url, dest) {
    return new Promise((resolve, reject) => {
        let downloaded = 0;

        function request(currentUrl) {
            const mod = currentUrl.startsWith('https') ? https : http;
            mod.get(currentUrl, { headers: { 'User-Agent': 'VAIDYADRISHTI-AI/1.0' } }, (res) => {

                // Follow redirects (301, 302, 303, 307, 308)
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume(); // drain & discard redirect body
                    return request(res.headers.location);
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`Download failed: HTTP ${res.statusCode} for ${currentUrl}`));
                    return;
                }

                const total = parseInt(res.headers['content-length'] || '0', 10);
                let lastPct = 0;

                // Open the file only now, after reaching the real resource
                const file = fs.createWriteStream(dest);

                res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (total > 0) {
                        const pct = Math.floor((downloaded / total) * 100);
                        if (pct >= lastPct + 10) {
                            lastPct = pct;
                            const mb      = (downloaded / 1024 / 1024).toFixed(1);
                            const totalMb = (total     / 1024 / 1024).toFixed(1);
                            process.stdout.write(`\r  ⏬ ${mb} MB / ${totalMb} MB  (${pct}%)`);
                        }
                    }
                });

                res.pipe(file);
                file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
                file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });

            }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
        }

        request(url);
    });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n  🦙 VAIDYADRISHTI AI — Ollama Setup\n');

    // Already installed?
    if (fs.existsSync(OLLAMA_EXE)) {
        console.log('  ✅ Ollama is already installed at backend/bin/ollama.exe\n');
        console.log('  Next steps:');
        console.log('    npm run ollama:pull   — download llama3.2 + llava models');
        console.log('    npm run ollama:serve  — start the Ollama server\n');
        return;
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });

    // Download
    console.log('  📥 Downloading Ollama portable binary for Windows...');
    console.log('     Source:', OLLAMA_URL);
    console.log('     Target: backend/bin/ollama.exe\n');

    try {
        await download(OLLAMA_URL, ZIP_PATH);
    } catch (err) {
        console.error('\n  ❌ Download failed:', err.message);
        console.error('  Try manually downloading from: https://github.com/ollama/ollama/releases');
        process.exit(1);
    }

    // Extract zip using PowerShell (built-in on Windows)
    console.log('  📦 Extracting ollama.exe...');
    try {
        await execAsync(
            `powershell -NoProfile -Command "Expand-Archive -Path '${ZIP_PATH}' -DestinationPath '${BIN_DIR}' -Force"`,
            { timeout: 60000 }
        );
    } catch (err) {
        console.error('  ❌ Extraction failed:', err.message);
        process.exit(1);
    }

    // Cleanup zip
    if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);

    if (!fs.existsSync(OLLAMA_EXE)) {
        console.error('  ❌ ollama.exe not found after extraction. Check the zip contents manually in backend/bin/');
        process.exit(1);
    }

    console.log('  ✅ Ollama installed successfully → backend/bin/ollama.exe\n');
    console.log('  Next steps:');
    console.log('    npm run ollama:pull   — download llama3.2 + llava models (~6 GB total)');
    console.log('    npm run ollama:serve  — start the Ollama server\n');
}

main().catch((err) => {
    console.error('  ❌ Setup error:', err.message);
    process.exit(1);
});
