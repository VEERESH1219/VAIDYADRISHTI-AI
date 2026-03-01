/**
 * MedMap AI — Image Preprocessing Service
 *
 * 5 sharp-based preprocessing variants for multi-pass OCR.
 * Each function takes a Buffer and returns a processed PNG Buffer.
 * All functions fall back to the original buffer on error.
 *
 * Optimized for handwritten Indian prescriptions:
 * - Aggressive upscaling for small phone camera images
 * - Heavy sharpening to distinguish pen strokes
 * - Multiple threshold levels for binarization
 */

import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * PASS 1 — Standard preprocessing.
 * Aggressive upscale + normalize + sharpen.
 * Best general-purpose variant.
 */
export async function preprocessStandard(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        let pipeline = sharp(buffer);

        // Aggressively upscale — handwritten text needs high resolution
        if (metadata.width && metadata.width < 2000) {
            const scaleFactor = metadata.width < 1000 ? 3 : 2;
            pipeline = pipeline.resize({
                width: metadata.width * scaleFactor,
                kernel: sharp.kernel.lanczos3,
            });
        }

        return await pipeline
            .grayscale()    // remove color noise
            .normalize()    // auto-stretch contrast
            .sharpen({ sigma: 2 })
            .png()
            .toBuffer();
    } catch (err) {
        console.error('[preprocessStandard] Error, using original:', err.message);
        return buffer;
    }
}

/**
 * PASS 2 — High contrast + heavy sharpening.
 * Best for faded ink or pencil writing.
 */
export async function preprocessHighContrast(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        let pipeline = sharp(buffer);

        if (metadata.width && metadata.width < 1500) {
            pipeline = pipeline.resize({
                width: metadata.width * 2,
                kernel: sharp.kernel.lanczos3,
            });
        }

        return await pipeline
            .grayscale()
            .normalize()
            .modulate({ brightness: 1.2 })
            .linear(1.6, -(128 * 0.6))  // aggressive contrast boost ~60%
            .sharpen({ sigma: 3, m1: 2, m2: 1 })
            .png()
            .toBuffer();
    } catch (err) {
        console.error('[preprocessHighContrast] Error, using original:', err.message);
        return buffer;
    }
}

/**
 * PASS 3 — Adaptive binarization (low threshold).
 * Best for dark pen on white/cream paper.
 */
export async function preprocessBinarize(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        let pipeline = sharp(buffer);

        if (metadata.width && metadata.width < 1500) {
            pipeline = pipeline.resize({
                width: metadata.width * 2,
                kernel: sharp.kernel.lanczos3,
            });
        }

        return await pipeline
            .grayscale()
            .normalize()
            .threshold(100)   // lower threshold to capture faint strokes
            .median(1)        // remove salt-and-pepper noise
            .sharpen()
            .png()
            .toBuffer();
    } catch (err) {
        console.error('[preprocessBinarize] Error, using original:', err.message);
        return buffer;
    }
}

/**
 * PASS 4 — Deskew + denoise + higher threshold.
 * For slightly tilted or noisy images.
 */
export async function preprocessDeskew(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        let pipeline = sharp(buffer);

        if (metadata.width && metadata.width < 1500) {
            pipeline = pipeline.resize({
                width: metadata.width * 2,
                kernel: sharp.kernel.lanczos3,
            });
        }

        return await pipeline
            .grayscale()
            .rotate(0, { background: '#ffffff' })  // auto-rotate based on EXIF
            .normalize()
            .threshold(150)   // higher threshold for cleaner separation
            .median(2)        // moderate denoise
            .sharpen({ sigma: 2 })
            .png()
            .toBuffer();
    } catch (err) {
        console.error('[preprocessDeskew] Error, using original:', err.message);
        return buffer;
    }
}

/**
 * PASS 5 — Inverted colors (light text on dark background).
 * Also works as a contrast variant for normal text.
 */
export async function preprocessInvert(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        let pipeline = sharp(buffer);

        if (metadata.width && metadata.width < 1500) {
            pipeline = pipeline.resize({
                width: metadata.width * 2,
                kernel: sharp.kernel.lanczos3,
            });
        }

        return await pipeline
            .grayscale()
            .negate({ alpha: false })
            .normalize()
            .sharpen()
            .png()
            .toBuffer();
    } catch (err) {
        console.error('[preprocessInvert] Error, using original:', err.message);
        return buffer;
    }
}

/**
 * VISION PASS — Optimised specifically for Vision LLMs.
 *
 * Key constraints for local Ollama models (llava, llava-llama3):
 *  - MAX 1280px on the longest side — larger images crash Ollama with "fetch failed"
 *  - JPEG output — 5–10x smaller than PNG, well within Ollama's body limit
 *  - COLOUR preserved — vision LLMs use colour to distinguish ink from paper
 *  - Gentle sharpening — avoids binarization artifacts
 *  - Auto-rotate using EXIF — phone photos are often rotated 90°
 *
 * Cloud vision providers (GPT-4o, Gemini) can handle up to 2048px,
 * but 1280px is fine for prescription reading and safe for all providers.
 */
export async function preprocessForVision(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        const maxSide = Math.max(metadata.width || 0, metadata.height || 0);

        // Target: fit within 1280px on the longest side (safe for Ollama + cloud)
        // Upscale tiny images (< 600px) for better OCR, downscale large photos
        const TARGET_MAX = 1280;
        const TARGET_MIN = 600;

        let pipeline = sharp(buffer).rotate(); // auto-rotate from EXIF metadata

        if (maxSide > TARGET_MAX) {
            // Downscale large phone photos — critical for Ollama not to crash
            pipeline = pipeline.resize(TARGET_MAX, TARGET_MAX, {
                fit: 'inside',
                kernel: sharp.kernel.lanczos3,
                withoutEnlargement: false,
            });
        } else if (maxSide < TARGET_MIN && maxSide > 0) {
            // Upscale tiny images for better text visibility
            pipeline = pipeline.resize(TARGET_MIN, TARGET_MIN, {
                fit: 'inside',
                kernel: sharp.kernel.lanczos3,
            });
        }

        return await pipeline
            .normalize()                            // auto-stretch contrast
            .linear(1.2, -(128 * 0.2))              // mild contrast boost
            .sharpen({ sigma: 1.2, m1: 0.8, m2: 0.4 }) // gentle sharpening
            .jpeg({ quality: 88, mozjpeg: false })  // JPEG: 5-10x smaller than PNG
            .toBuffer();
    } catch (err) {
        console.error('[preprocessForVision] Error, using original:', err.message);
        return buffer;
    }
}

