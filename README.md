# VAIDYADRISHTI AI — Intelligent Prescription Reader

An AI-powered prescription analysis system that reads handwritten or printed prescriptions, extracts medicine names, dosages, and frequencies, then matches them against a local medicine database — all running **100% locally, free of charge**, with no paid API keys required.

---

## What This Project Does

Doctors write prescriptions that patients often struggle to read or look up. VAIDYADRISHTI AI solves this by:

1. **Reading the prescription** — upload an image or paste text directly
2. **Extracting medicines** — uses AI to identify medicine names, dosages, frequency, and the diagnosed condition
3. **Matching to a database** — searches a 253,000+ local PostgreSQL medicine database using a 5-stage hybrid engine
4. **Returning structured results** — confidence scores, medicine descriptions, match source, and processing metadata

All AI processing runs on **Ollama** (free, local LLMs). No OpenAI key, no cloud account, and no internet connection are required.

---

## Architecture

```
[Image / Text Input]
        ↓
  ┌─────────────────────────────────────┐
  │    3-Tier OCR Engine                │
  │  Tier 1: Vision LLM (llava-llama3) │  ← Best quality
  │  Tier 2: PaddleOCR (Python)        │  ← Fast fallback
  │  Tier 3: Tesseract.js (5 passes)   │  ← Last resort
  └─────────────────────────────────────┘
        ↓
  Dual-Path Parallel Extraction:
  Path A: OCR text → llama3.2 NLP → medicines list
  Path B: Image → llava-llama3 → direct medicine JSON
  (results are merged — union of both paths)
        ↓
  ┌──────────────────────────────────────────┐
  │   5-Stage Hybrid Matching Engine         │
  │  Stage 0: Local Cache (instant, ~100ms)  │
  │  Stage 1: Exact PostgreSQL match         │
  │  Stage 2: Fuzzy trigram match (pg_trgm)  │
  │  Stage 3: Vector similarity (pgvector)   │
  │  Stage 4: AI fallback (OpenFDA →        │
  │           RxNorm → Ollama knowledge)     │
  └──────────────────────────────────────────┘
        ↓
  [Structured JSON Result + Confidence Scores]
```

---

## Tech Stack

| Layer           | Technology                                                    |
|-----------------|---------------------------------------------------------------|
| **Frontend**    | React 19 + Vite + Tailwind CSS 4                              |
| **Backend**     | Node.js 20 + Express 5 (ESM)                                  |
| **AI/NLP**      | Ollama — `llama3.2` (NLP), `llava-llama3` (vision OCR)       |
| **Database**    | Local PostgreSQL 16 with `pg_trgm` + `pgvector` (1536-dim)   |
| **OCR Tier 1**  | Ollama `llava-llama3` — best accuracy for handwriting          |
| **OCR Tier 2**  | PaddleOCR (Python subprocess) — printed text fallback          |
| **OCR Tier 3**  | Tesseract.js 7 — 5-pass consensus engine, last resort          |
| **Image**       | Sharp 0.34 — preprocessing, downscaling, EXIF rotation        |
| **Embeddings**  | OpenAI `text-embedding-3-small` (1536-dim, optional)          |

> **PostgreSQL is required** for Stages 1–3. Without it, only Stage 0 (local cache) and Stage 4 (Ollama AI fallback) are used.
> **OpenAI API key is optional** — only needed for Stage 3 vector search and cloud LLM mode.

---

## Prerequisites

Install these before running the project:

- **Node.js** v20 or higher — https://nodejs.org
- **Git** — https://git-scm.com
- **Ollama** — https://ollama.com (runs LLMs locally, free)
- **Python 3.8+** — https://python.org (for PaddleOCR Tier 2)
- **PostgreSQL 16** — https://postgresql.org (local database)

---

## Setup & Running

### Step 1 — Clone the repository

```bash
git clone <repo-url>
cd VAIDYADRISHTI-AI
```

### Step 2 — Install backend dependencies

```bash
cd backend
npm install
```

### Step 3 — Install frontend dependencies

```bash
cd ../frontend
npm install
```

### Step 4 — Install PaddleOCR (optional, Tier 2 OCR)

```bash
pip install paddlepaddle paddleocr
```

> Skip this if you only want Vision LLM + Tesseract. PaddleOCR falls back gracefully if not installed.

### Step 5 — Configure environment

```bash
cd backend
cp .env.example .env
```

Open `backend/.env` and configure:

```env
# LLM Provider (ollama = free local, openai = cloud)
MODEL_PROVIDER=ollama
VISION_PROVIDER=ollama

# Ollama endpoints and models
OLLAMA_ENDPOINT=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2
OLLAMA_VISION_MODEL=llava-llama3

# Local PostgreSQL (required for DB matching stages 1-3)
USE_LOCAL_POSTGRES=true
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=vaidyadrishti
PG_USER=postgres
PG_PASSWORD=yourpassword

PORT=3001
FRONTEND_URL=http://localhost:5173
```

> **Optional — OpenAI** (for Stage 3 vector search or cloud LLM mode):
> ```env
> OPENAI_API_KEY=sk-...
> ```

### Step 6 — Pull Ollama models

```bash
# NLP extraction model (~2GB)
ollama pull llama3.2

# Vision OCR model (~4.7GB) — use llava-llama3, NOT plain llava
ollama pull llava-llama3
```

> ⚠️ The project uses **`llava-llama3`**, not `llava`. Plain `llava` produces garbage tokens on some prescriptions.

### Step 7 — Set up PostgreSQL database

```bash
cd backend
node scripts/setupDb.js        # Creates tables + pg_trgm + pgvector extensions
node scripts/importToPostgres.js  # Imports 253,000+ medicines from CSV
```

### Step 8 — Run the application

**Terminal 1 — Ollama:**
```bash
ollama serve
```

**Terminal 2 — Backend:**
```bash
cd backend
npm run dev
```
Backend runs at: http://localhost:3001

**Terminal 3 — Frontend:**
```bash
cd frontend
npm run dev
```
Frontend runs at: http://localhost:5173

Open http://localhost:5173 in your browser.

---

## How to Use

1. Open http://localhost:5173
2. Click **Upload Image** and upload a prescription photo (JPG, PNG, WebP up to 10MB)
   — or click **Paste Text** and type/paste the prescription text directly
3. Click **Analyze Prescription**
4. Wait for the pipeline to complete (15–120 seconds depending on model load)
5. Results show each medicine with:
   - Match confidence percentage
   - Match source badge (⚡ Cached / DB Exact / DB Fuzzy / AI Stage 4)
   - Strength, form, and usage description
   - Dosage and frequency from the prescription

---

## Known Issues & Limitations

### ❌ Image Upload — Slow & Unreliable on Low-end Hardware

**Status: Partially Working**

Vision LLM (`llava-llama3`) is the primary OCR method for handwritten prescriptions, but:

- **First-run cold start**: llava-llama3 takes 30–120 seconds to load into Ollama on the first request. Subsequent requests are faster (~15–30s).
- **Large images crash Ollama**: Phone photos at full resolution (3024×4032px) caused `fetch failed` crashes. **Fixed** in this version — images are now auto-downscaled to ≤1280px and converted to JPEG before being sent to Ollama.
- **Very small images**: Images smaller than 600px on the shortest side are upscaled before OCR.
- **Blank/white images**: If the image has no readable text, Vision LLM may time out (> 2 minutes). The system will fall back to Tesseract which also returns empty.

### ❌ PaddleOCR — OneDNN Crash on Windows

**Status: Patched, Still Unstable**

PaddleOCR (Tier 2) crashes on Windows with:
```
NotFoundError: OneDnnContext does not have the input Filter
```
**Workaround applied**: `FLAGS_use_mkldnn=0` and `PADDLE_DISABLE_MKLDNN=1` are set in the Python subprocess environment. This suppresses most crashes but PaddleOCR may still fail on some Windows + CPU configurations. The system falls through to Tesseract (Tier 3) automatically if PaddleOCR fails.

### ❌ Tesseract — Low Accuracy on Handwritten Indian Prescriptions

**Status: Known Limitation**

Tesseract.js achieves only **30–45% confidence** on real handwritten prescriptions (Indian script, hurried doctor handwriting). It works better on:
- Printed/typed text (> 80% confidence)
- Clear, dark-ink handwriting on white paper
- Standard English block letters

For handwritten prescriptions, Vision LLM (Tier 1) is the only viable OCR path, but it is slow.

### ❌ Tesseract — Crash on Corrupt Image Buffers

**Status: Fixed**

Tesseract.js v7 throws errors via `process.nextTick(() => { throw err })` on corrupt/unreadable image buffers, which bypasses Express error handling and crashes the entire Node.js server.

**Fix applied:**
1. Sharp buffer validation before every Tesseract call — corrupt buffers are skipped instead of crashing
2. Global `uncaughtException` handler in `server.js` catches any Tesseract worker errors that slip through and logs them without crashing the server

### ❌ Vector Search (Stage 3) — Requires OpenAI Key

**Status: Disabled by Default**

Stage 3 uses `text-embedding-3-small` to compute 1536-dimensional embeddings for semantic similarity search. Without an `OPENAI_API_KEY` in `.env`, Stage 3 is silently skipped. The system falls through to Stage 4 (AI fallback) automatically.

> **Note:** Changing the embedding model or dimension requires re-embedding all 253,000+ records in the database (hours of compute + API cost).

### ❌ NLP Hallucinations on Garbage OCR

**Status: Fixed**

When OCR output was garbled (< 40% alphabetic characters), the NLP model (`llama3.2`) previously returned default medicines `Cetirizine, Amoxicillin, Paracetamol` from its training data.

**Fix applied:**
- `looksLikePrescription()` quality gate rejects garbled text before NLP
- Anti-hallucination rules added to system prompt
- Example prompts updated — training examples no longer contain real medicine names that the model could parrot back

### ❌ Wrong Medicine Matches (Form Mismatch)

**Status: Fixed**

Diclofenac 50mg was previously matched to "Godic Diclofenac **Gel**" instead of a Tablet formulation. Ultracal-D was matched to "Ketoconazole Cream" (25.9% trigram match — far too low).

**Fixes applied:**
- `MIN_FUZZY_ACCEPT = 30` — fuzzy matches below 30% skip to AI fallback instead of returning a wrong medicine
- Form-aware ranking — when the prescription specifies `form: Tablet`, PostgreSQL query orders Tablet results above Gel/Cream/Syrup for the same trigram score
- Dosage patterns (`0+0+1`, `1-0-1`) stripped from `brand_variant` — these are frequencies, not strengths

### ⚠️ llmService.js — dotenv Load Order (ESM)

**Status: Fixed**

In ESM modules, `import` statements execute before any top-level code. This caused `llmService.js` to read `OLLAMA_VISION_MODEL` before `server.js` had loaded `.env`, so the vision model always fell back to the default `llava` (not `llava-llama3`).

**Fix applied:** `llmService.js` now loads its own `dotenv.config()` pointing to `backend/.env` using `dirname(fileURLToPath(import.meta.url))`.

---

## Available npm Scripts

```bash
# Backend
npm run dev           # Start backend with hot-reload (nodemon)
npm run start         # Start backend in production mode
npm run ollama:setup  # Check Ollama installation and model status
npm run ollama:serve  # Start Ollama server
npm run ollama:pull   # Pull llama3.2 + llava-llama3 models
```

---

## Changelog

### v4.0 — Local PostgreSQL + 3-Tier OCR + Crash Fixes (Current)

**OCR Engine:**
- **3-Tier OCR**: Vision LLM (llava-llama3) → PaddleOCR → Tesseract.js, in order of quality
- **Dual-path extraction**: Path A (OCR→NLP) and Path B (direct vision→JSON) run in parallel; results merged
- **Image downscaling**: Phone photos are now capped at 1280px and converted to JPEG before Vision LLM — prevents Ollama `fetch failed` crashes on large images
- **EXIF rotation**: Auto-rotates images from phone EXIF metadata before processing
- **OCR quality gate** (`isUsableOCRText`): Rejects garbage tokens (`<unk>`, `<s>`, < 35% alphabetic) from all three OCR tiers
- **Tesseract crash fix**: Sharp buffer validation before each Tesseract pass + `uncaughtException` handler prevents server crash on corrupt images

**NLP Extraction:**
- **Anti-hallucination rules**: System prompt updated to never guess medicines on garbled text
- **`looksLikePrescription()` gate**: Garbled OCR text (< 40% alphabetic) is rejected before NLP
- **Indian `+` notation**: `0+0+1` = 1/day, `1+0+1` = 2/day, `2+0+2` = 4/day parsed correctly as `frequency_per_day`
- **Brand variant sanitization**: Strips `mg`/`ml` units, rejects `"null"` string, rejects dosage patterns

**Matching Engine:**
- **`MIN_FUZZY_ACCEPT = 30`**: Fuzzy matches below 30% skip to AI fallback
- **Form-aware matching**: PostgreSQL queries now rank form-matching medicines (Tablet before Gel) for the same trigram score
- **`isDosagePattern()`**: Detects `A+B+C` and `A-B-C` dosage strings to prevent them being used as strength search terms

**Database:**
- Migrated from Supabase (cloud) to **local PostgreSQL 16** — no internet required
- 253,976 medicines with `pg_trgm` fuzzy search and `pgvector` (1536-dim) vector search
- `pgService.js`: New direct PostgreSQL adapter replacing Supabase client

**Infrastructure:**
- `prescription.js`: Removed dead Supabase import; replaced with synchronous console logger
- `llmService.js`: Fixed dotenv path to correctly load `OLLAMA_VISION_MODEL` at module init time

### v3.0 — Local Cache + 5-Stage Engine

- **Stage 0 Local Cache**: Pre-database in-memory cache (`backend/data/medicines_cache.json`). Auto-populates from Stage 4 AI results.
- **Self-learning**: New medicines discovered via AI fallback are saved to local cache. Repeat scans are 30–40% faster.
- **"⚡ Cached" badge**: Medicine cards show distinct badge for local cache hits.
- **Graceful DB-free mode**: Stages 1–3 silently skip if PostgreSQL is not configured.

### v2.5 — Ollama / Multi-Provider LLM Support

- Unified LLM adapter (`llmService.js`) supports OpenAI, Anthropic Claude, Google Gemini, and Ollama.
- Switch providers via `MODEL_PROVIDER` and `VISION_PROVIDER` in `.env`.
- Ollama is the default provider (free, local).
- `llama3.2` for NLP, `llava-llama3` for prescription image OCR.

### v2.0 — 4-Stage Hybrid Matching + Vector Search

- Hybrid matching engine: Exact → Fuzzy (trigram) → Vector (pgvector) → AI Fallback.
- Vector stage uses OpenAI `text-embedding-3-small` (1536-dim).
- AI Fallback queries OpenFDA and RxNorm before using LLM knowledge.
- High-confidence AI matches auto-persist to local cache.

### v1.5 — Premium UI / UX Overhaul

- Dark mode glassmorphism UI with animated pipeline stepper.
- Real-time scan progress visualization.
- Medicine cards with confidence bars, source badges, and usage descriptions.
- Scan history drawer (localStorage, up to 50 scans).
- Medical wallet export (PDF/PNG).

### v1.0 — OCR Pipeline Foundation

- 5-pass parallel Tesseract.js OCR (standard, high-contrast, binarized, deskewed, inverted).
- Token-level consensus voting across OCR passes.
- Sharp image preprocessing (5 variants per image).

---

## Project Structure

```
VAIDYADRISHTI-AI/
├── backend/
│   ├── server.js                      # Express entry point (port 3001)
│   ├── routes/
│   │   └── prescription.js            # POST /api/process_prescription
│   ├── services/
│   │   ├── llmService.js              # Multi-provider LLM adapter (Ollama/OpenAI/etc.)
│   │   ├── localCacheService.js       # Stage 0 in-memory medicine cache
│   │   ├── ocrService.js              # 3-tier OCR: Vision LLM → PaddleOCR → Tesseract
│   │   ├── paddleOcrService.js        # PaddleOCR Python subprocess wrapper
│   │   ├── nlpService.js              # Medicine + condition NLP extraction
│   │   ├── matchingEngine.js          # 5-stage hybrid matching engine
│   │   ├── pgService.js               # Local PostgreSQL adapter (replaces Supabase)
│   │   ├── preprocessingService.js    # Sharp image preprocessing + downscaling
│   │   ├── embeddingService.js        # OpenAI text-embedding-3-small wrapper
│   │   └── aiVerificationService.js   # OpenFDA + RxNorm + AI fallback
│   ├── scripts/
│   │   ├── setupDb.js                 # Create PostgreSQL tables + extensions
│   │   ├── importToPostgres.js        # Import 253k medicines from CSV to PostgreSQL
│   │   ├── paddle_ocr.py              # PaddleOCR Python script (called as subprocess)
│   │   ├── setup-ollama.js            # Check Ollama installation
│   │   ├── start-ollama.js            # Launch Ollama server
│   │   └── pull-models.js             # Pull llama3.2 + llava-llama3 models
│   ├── data/
│   │   └── medicines_cache.json       # Auto-populated local medicine cache
│   └── .env                           # Environment config (git-ignored)
└── frontend/
    └── src/
        ├── App.jsx                    # Root app component
        ├── pages/
        │   └── Home.jsx               # Image upload + text paste UI
        ├── components/
        │   ├── MedicineCard.jsx        # Per-medicine result card
        │   ├── SummaryCard.jsx         # Condition + stats + TTS
        │   ├── PipelineStepper.jsx     # Scan progress animation
        │   ├── HistoryPanel.jsx        # Scan history drawer
        │   └── MedicalWallet.jsx       # PDF/PNG export modal
        └── services/
            └── HistoryService.js       # localStorage history manager (max 50 scans)
```

---

## License

MIT — Built for intelligent healthcare assistance.
