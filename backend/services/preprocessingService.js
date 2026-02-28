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
 * Unlike Tesseract passes, vision models work BETTER with:
 *  - High resolution (3x-4x upscale for small phone photos)
 *  - COLOUR preserved (not grayscale — vision LLMs use colour to distinguish ink)
 *  - Gentle sharpening (not aggressive binarization — avoids artifacts)
 *  - Balanced brightness/contrast without thresholding
 *
 * This is the image sent to llava / GPT-4o / Gemini / Claude Vision.
 */
export async function preprocessForVision(buffer) {
    try {
        const metadata = await sharp(buffer).metadata();
        let pipeline = sharp(buffer);

        // Aggressive upscale — vision LLMs read fine handwriting at higher res
        if (metadata.width) {
            let scaleFactor = 1;
            if (metadata.width < 800)       scaleFactor = 4;
            else if (metadata.width < 1200) scaleFactor = 3;
            else if (metadata.width < 2000) scaleFactor = 2;

            if (scaleFactor > 1) {
                pipeline = pipeline.resize({
                    width: metadata.width * scaleFactor,
                    kernel: sharp.kernel.lanczos3,
                });
            }
        }

        return await pipeline
            // Normalize contrast — auto-stretch histogram for better visibility
            .normalize()
            // Mild contrast boost to make text stand out without losing detail
            .linear(1.3, -(128 * 0.3))
            // Gentle sharpening — sharpen text edges without introducing artifacts
            .sharpen({ sigma: 1.5, m1: 1, m2: 0.5 })
            // High-quality PNG (vision models benefit from lossless format)
            .png({ compressionLevel: 6 })
            .toBuffer();
    } catch (err) {
        console.error('[preprocessForVision] Error, using original:', err.message);
        return buffer;
    }
}

