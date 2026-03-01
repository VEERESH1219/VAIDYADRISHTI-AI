#!/usr/bin/env python3
"""
VAIDYADRISHTI AI — PaddleOCR Engine

Extracts text from medical prescription images using PaddleOCR.
Significantly better than Tesseract for printed text and complex layouts.

Install (PaddleOCR 2.x — no modelscope, no Windows Long Path issue):
    pip install "paddleocr<3.0" paddlepaddle

Usage:
    python paddle_ocr.py <image_path>

Output (stdout — JSON):
    {"text": "...", "confidence": 94.2, "line_count": 12}

On error:
    {"error": "...", "text": "", "confidence": 0}
"""

import sys
import json
import os

# Suppress PaddlePaddle/PaddleOCR noisy startup logs
os.environ.setdefault('FLAGS_logtostderr', '0')
os.environ.setdefault('FLAGS_minloglevel', '3')
os.environ.setdefault('GLOG_minloglevel', '3')


def main():
    if len(sys.argv) < 2:
        _fail("Usage: paddle_ocr.py <image_path>")

    image_path = sys.argv[1]

    if not os.path.isfile(image_path):
        _fail(f"Image file not found: {image_path}")

    # ── Import check ──────────────────────────────────────────────────────────
    try:
        from paddleocr import PaddleOCR  # noqa: F401
    except ImportError:
        _fail(
            "PaddleOCR not installed.\n"
            "  Fix: pip install paddleocr paddlepaddle\n"
            "  (First run downloads ~800 MB of models — wait a few minutes)"
        )
        return  # unreachable but satisfies type checkers

    # ── Run OCR ───────────────────────────────────────────────────────────────
    try:
        from paddleocr import PaddleOCR

        # show_log=False silences the per-inference noise (supported in 2.x + 3.x)
        import inspect
        init_params = inspect.signature(PaddleOCR.__init__).parameters
        kwargs = dict(
            use_angle_cls=True,   # Rotate detection — handles sideways text
            lang='en',            # English prescription text
            use_gpu=False,        # CPU — works everywhere, no CUDA needed
        )
        if 'show_log' in init_params:
            kwargs['show_log'] = False

        ocr = PaddleOCR(**kwargs)

        result = ocr.ocr(image_path, cls=True)

        lines = []
        confidences = []

        # PaddleOCR result shape: [page][detection] where
        # detection = [bbox_points, (text_string, confidence_float)]
        pages = result if result else []
        for page in pages:
            if not page:
                continue
            for detection in page:
                if not detection or len(detection) < 2:
                    continue
                text_info = detection[1]
                if isinstance(text_info, (list, tuple)) and len(text_info) >= 2:
                    text = str(text_info[0]).strip()
                    conf = float(text_info[1])
                else:
                    text = str(text_info).strip()
                    conf = 0.8
                if text:
                    lines.append(text)
                    confidences.append(conf)

        avg_conf = (sum(confidences) / len(confidences) * 100) if confidences else 0.0

        print(json.dumps({
            "text":       "\n".join(lines),
            "confidence": round(avg_conf, 1),
            "line_count": len(lines),
        }))

    except Exception as exc:
        _fail(str(exc))


def _fail(msg: str):
    print(json.dumps({"error": msg, "text": "", "confidence": 0}))
    sys.exit(1)


if __name__ == '__main__':
    main()
