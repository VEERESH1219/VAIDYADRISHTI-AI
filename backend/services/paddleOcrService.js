/**
 * VAIDYADRISHTI AI — PaddleOCR Service
 *
 * Wraps the Python PaddleOCR engine for use from Node.js.
 * PaddleOCR is far better than Tesseract for printed/typed medical text:
 *   - Handles dense layouts, small fonts, mixed case
 *   - Multi-orientation detection (rotated text)
 *   - No language pack setup needed
 *
 * Prerequisite (one-time):
 *   pip install paddleocr paddlepaddle
 *   (first run auto-downloads ~800 MB of detection + recognition models)
 */

import { spawn }                       from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir }                      from 'os';
import { join }                        from 'path';
import { fileURLToPath }               from 'url';
import path                            from 'path';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PADDLE_SCRIPT = join(__dirname, '..', 'scripts', 'paddle_ocr.py');

// On Windows Git Bash `python` maps to Python 3; on Linux/Mac prefer `python3`
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

// Timeout in ms — generous because the very first run downloads models (~2 min)
const TIMEOUT_MS = 120_000;

/**
 * Run PaddleOCR on a raw image buffer.
 *
 * @param {Buffer} imageBuffer — raw image bytes (PNG / JPEG)
 * @returns {Promise<{text: string, confidence: number}>}
 */
export async function runPaddleOCR(imageBuffer) {
    const tmpPath = join(tmpdir(), `vaidya_paddle_${Date.now()}.png`);

    try {
        writeFileSync(tmpPath, imageBuffer);

        const result = await new Promise((resolve, reject) => {
            const proc = spawn(PYTHON_CMD, [PADDLE_SCRIPT, tmpPath], {
                timeout: TIMEOUT_MS,
                env: {
                    ...process.env,
                    // Disable Intel OneDNN/MKL-DNN — fixes "OneDnnContext does not have
                    // the input Filter" crash on Windows with PaddleOCR 2.x
                    FLAGS_use_mkldnn: '0',
                    PADDLE_DISABLE_MKLDNN: '1',
                    MKL_THREADING_LAYER: 'GNU',
                },
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });

            proc.on('close', () => {
                // stdout may include extra log lines before JSON — grab the last JSON line
                const jsonLine = stdout
                    .split('\n')
                    .reverse()
                    .find(l => l.trim().startsWith('{'));

                if (!jsonLine) {
                    reject(new Error(
                        `PaddleOCR produced no JSON output.\n` +
                        `stderr: ${stderr.slice(0, 300)}`
                    ));
                    return;
                }

                try {
                    const parsed = JSON.parse(jsonLine.trim());
                    if (parsed.error) {
                        reject(new Error(parsed.error));
                    } else {
                        resolve(parsed);
                    }
                } catch {
                    reject(new Error(`PaddleOCR JSON parse failed: ${jsonLine.slice(0, 200)}`));
                }
            });

            proc.on('error', (err) => {
                reject(new Error(
                    `Python spawn error: ${err.message}\n` +
                    `Make sure Python is in PATH and run: pip install paddleocr paddlepaddle`
                ));
            });
        });

        console.log(
            `[PaddleOCR] ${result.line_count} lines, ` +
            `avg confidence ${result.confidence}%, ` +
            `${result.text?.length || 0} chars`
        );

        return {
            text:       result.text       || '',
            confidence: result.confidence || 0,
        };

    } finally {
        // Always clean up temp file
        if (existsSync(tmpPath)) {
            try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
        }
    }
}
