# VAIDYADRISHTI AI — Intelligent Prescription Reader

An AI-powered prescription analysis system that reads handwritten or printed prescriptions, extracts medicine names, dosages, and frequencies, then matches them against a medicine database — all running **100% locally, free of charge**, with no paid API keys required.

---

## What This Project Does

Doctors write prescriptions that patients often struggle to read or look up. VAIDYADRISHTI AI solves this by:

1. **Reading the prescription** — uploads an image or paste text directly
2. **Extracting medicines** — uses AI to identify medicine names, dosages, frequency, and the diagnosed condition
3. **Matching to a database** — searches a 250,000+ medicine database using a 5-stage hybrid engine
4. **Returning structured results** — confidence scores, medicine descriptions, match source, and processing metadata

All AI processing runs on **Ollama** (free, local LLMs) by default. No OpenAI key, no Supabase account, and no internet connection are required for basic use.

---

## Architecture

```
[Image / Text Input]
        ↓
  5-Pass OCR Engine (Tesseract.js + LLaVA Vision)
        ↓
  NLP Extraction (llama3.2 — extracts medicines + condition)
        ↓
  ┌──────────────────────────────────────┐
  │   5-Stage Hybrid Matching Engine     │
  │  Stage 0: Local Cache (instant)      │
  │  Stage 1: Exact DB match             │
  │  Stage 2: Fuzzy trigram match        │
  │  Stage 3: Vector similarity search   │
  │  Stage 4: AI fallback (OpenFDA →     │
  │           RxNorm → Ollama knowledge) │
  └──────────────────────────────────────┘
        ↓
  [Structured JSON Result + Confidence Scores]
```

---

## Tech Stack

| Layer        | Technology                                          |
|--------------|-----------------------------------------------------|
| **Frontend** | React 19 + Vite + Tailwind CSS 4                   |
| **Backend**  | Node.js 25 + Express 5 (ESM)                       |
| **AI/NLP**   | Ollama — `llama3.2` (text), `llava` (vision OCR)   |
| **Database** | Supabase (optional) — PostgreSQL + pgvector + trgm  |
| **OCR**      | Tesseract.js 7 — 5-pass parallel consensus engine   |
| **Embeddings**| OpenAI `text-embedding-3-small` (only if Supabase) |
| **Image**    | Sharp 0.34 — preprocessing for OCR quality          |

> **Supabase and OpenAI are optional.** Without them, the system uses Stage 0 (local cache) and Stage 4 (Ollama AI fallback) automatically.

---

## Prerequisites

Install these before running the project:

- **Node.js** v20 or higher — https://nodejs.org
- **Git** — https://git-scm.com
- **Ollama** — https://ollama.com (free, runs LLMs locally)

---

## Setup & Running (Git Bash)

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

### Step 4 — Configure environment

```bash
cd ../backend
cp .env.example .env
```

Open `backend/.env` in any text editor. The default config works out of the box with Ollama:

```env
MODEL_PROVIDER=ollama
VISION_PROVIDER=ollama
OLLAMA_ENDPOINT=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2
OLLAMA_VISION_MODEL=llava
PORT=3001
FRONTEND_URL=http://localhost:5173
```

> **Optional** — to use Supabase (enables Stages 1–3 DB matching):
> ```env
> SUPABASE_URL=https://your-project.supabase.co
> SUPABASE_SERVICE_KEY=your-service-key
> ```
>
> **Optional** — to use OpenAI instead of Ollama:
> ```env
> MODEL_PROVIDER=openai
> VISION_PROVIDER=openai
> OPENAI_API_KEY=sk-...
> ```

### Step 5 — Pull Ollama models

Open a **new Git Bash terminal** and run:

```bash
# Install llama3.2 for text/NLP processing (~2GB)
ollama pull llama3.2

# Install llava for prescription image reading (~4GB)
ollama pull llava
```

> This only needs to be done once. Models are stored locally.

### Step 6 — Run the application (3 terminals)

**Terminal 1 — Start Ollama:**
```bash
ollama serve
```

**Terminal 2 — Start the backend:**
```bash
cd backend
npm run dev
```
Backend runs at: http://localhost:3001

**Terminal 3 — Start the frontend:**
```bash
cd frontend
npm run dev
```
Frontend runs at: http://localhost:5173

Open http://localhost:5173 in your browser.

---

## How to Use

1. Open http://localhost:5173
2. Click **SCAN IMAGE** and upload a prescription photo (JPG, PNG, WebP up to 10MB)
   — or click **PASTE TEXT** and type/paste the prescription text directly
3. Click **ANALYZE PRESCRIPTION**
4. Wait for the pipeline to complete (15–60 seconds depending on your machine)
5. Results show each medicine with:
   - Match confidence percentage
   - Match source badge (⚡ Cached / DB Exact / DB Fuzzy / AI Stage 4)
   - Strength, form, and usage description
   - Dosage and frequency from the prescription

---

## Available npm Scripts

```bash
# Backend
npm run dev          # Start backend with hot-reload (nodemon)
npm run start        # Start backend in production mode

# Ollama helpers (backend folder)
npm run ollama:setup  # Check Ollama installation and model status
npm run ollama:serve  # Start Ollama server
npm run ollama:pull   # Pull required models (llama3.2 + llava)
```

---

## Changelog

### v3.0 — Local Cache + 5-Stage Engine (Current)
- **Stage 0 Local Cache**: New pre-database stage checks an in-memory cache (`backend/data/medicines_cache.json`) before any network or DB call. Cache auto-populates from Stage 4 results.
- **Self-learning**: Every new medicine discovered via AI fallback is automatically saved to the local cache. Repeat scans of the same medicines are 30–40% faster.
- **"⚡ Cached" badge**: Medicine cards now show a distinct badge for local cache hits, separate from AI Stage 4.
- **Graceful Supabase-free mode**: Stages 1–3 (DB matching) silently skip if Supabase is not configured. The system fully works without a database using just Stage 0 + Stage 4.

### v2.5 — Ollama / Multi-Provider LLM Support
- **`llmService.js`**: Unified LLM adapter supports OpenAI, Anthropic Claude, Google Gemini, and Ollama.
- Switch providers via `MODEL_PROVIDER` and `VISION_PROVIDER` in `.env` — no code changes needed.
- Ollama is now the **default provider** (free, local, no API key).
- `llama3.2` handles NLP extraction; `llava` handles prescription image OCR.
- Added `npm run ollama:setup`, `npm run ollama:serve`, `npm run ollama:pull` helper scripts.

### v2.0 — 4-Stage Hybrid Matching + Vector Search
- Introduced the hybrid matching engine: Exact → Fuzzy (trigram) → Vector (pgvector) → AI Fallback.
- Vector stage uses OpenAI `text-embedding-3-small` (1536-dim) for semantic similarity.
- AI Fallback queries OpenFDA and RxNorm APIs before using LLM knowledge.
- High-confidence AI matches auto-persist to Supabase DB ("self-training" mode).

### v1.5 — Premium UI / UX Overhaul
- Full dark mode glassmorphism UI with animated pipeline stepper.
- Real-time scan progress visualization (Upload → OCR → NLP → DB Match).
- Medicine cards with confidence bars, source badges, and usage descriptions.
- Scan history drawer (localStorage, up to 50 scans).
- Medical wallet export (PDF/PNG).

### v1.0 — OCR Pipeline Foundation
- 5-pass parallel Tesseract.js OCR (standard, high-contrast, binarized, deskewed, inverted).
- Token-level consensus voting across OCR passes.
- GPT-4o Vision fallback when Tesseract confidence < 55%.
- Sharp image preprocessing (5 variants per image).

---

## Project Structure

```
VAIDYADRISHTI-AI/
├── backend/
│   ├── server.js                  # Express entry point (port 3001)
│   ├── routes/
│   │   └── prescription.js        # POST /api/process_prescription
│   ├── services/
│   │   ├── llmService.js          # Multi-provider LLM adapter
│   │   ├── localCacheService.js   # Stage 0 in-memory medicine cache
│   │   ├── ocrService.js          # 5-pass Tesseract + Vision OCR
│   │   ├── nlpService.js          # Medicine + condition extraction
│   │   ├── matchingEngine.js      # 5-stage hybrid matching engine
│   │   ├── embeddingService.js    # text-embedding-3-small wrapper
│   │   └── aiVerificationService.js # OpenFDA + RxNorm + AI fallback
│   ├── data/
│   │   └── medicines_cache.json   # Auto-populated local medicine cache
│   ├── scripts/
│   │   ├── setup-ollama.js        # Check Ollama installation
│   │   ├── start-ollama.js        # Launch Ollama server
│   │   └── pull-models.js         # Pull llama3.2 + llava models
│   └── .env                       # Environment config (git-ignored)
└── frontend/
    └── src/
        ├── App.jsx                # Root app component
        ├── components/
        │   ├── UploadZone.jsx     # Image upload + text paste UI
        │   ├── MedicineCard.jsx   # Per-medicine result card
        │   ├── PipelineStepper.jsx# Scan progress animation
        │   ├── HistoryPanel.jsx   # Scan history drawer
        │   └── MedicalWallet.jsx  # PDF/PNG export modal
        └── services/
            └── HistoryService.js  # localStorage history manager
```

---

## License

MIT — Built for intelligent healthcare assistance.
