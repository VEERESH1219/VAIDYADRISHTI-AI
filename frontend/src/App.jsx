import { useState } from 'react';
import Home from './pages/Home.jsx';
import SummaryCard from './components/SummaryCard.jsx';
import MedicineCard from './components/MedicineCard.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import MedicalWallet from './components/MedicalWallet.jsx';
import DocumentScanner from './components/DocumentScanner.jsx';
import { saveToHistory } from './services/HistoryService.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default function App() {
  const [phase, setPhase] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawer] = useState(false);
  const [walletOpen, setWallet] = useState(false);

  const isBusy = !['idle', 'done', 'error'].includes(phase);

  async function run(input) {
    setError(null); setResult(null);
    try {
      setPhase('uploading'); await sleep(300);
      setPhase('preprocessing'); await sleep(500);
      setPhase('ocr');

      // ── Sanitization ──
      // Strips non-ASCII characters (like invisible ZWNJ \u200C) and whitespace
      const sanitize = (str) => (str || '').replace(/[^\x20-\x7E]/g, '').trim();

      const rawBase = import.meta.env.VITE_API_URL || '';
      const API_BASE = sanitize(rawBase).replace(/\/$/, '');
      const TARGET_URL = `${API_BASE}/api/process_prescription`;

      console.log(`[App] Calling API: ${TARGET_URL} (Original: ${rawBase})`);

      const res = await fetch(TARGET_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ ...input, options: { ocr_passes: 5, min_consensus: 3 } }),
      });

      // Handle non-JSON responses (e.g., HTML 404s from the frontend service)
      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await res.text();
        console.error('Non-JSON response received:', text.slice(0, 200));
        throw new Error(`Server returned an invalid response (not JSON). Please check if VITE_API_URL is configured correctly.`);
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Server error ${res.status}`);

      setPhase('nlp'); await sleep(350);
      setPhase('matching'); await sleep(280);
      saveToHistory(data, input.image ? 'image' : 'text');
      setResult(data);
      setPhase('done');
    } catch (e) {
      console.error('[App] processing error:', e);
      setError(e.message || 'Something went wrong.'); setPhase('error');
    }
  }

  const reset = () => { setPhase('idle'); setResult(null); setError(null); };

  return (
    <>
      {/* ── BACKGROUND ── */}
      <div aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', width: '70vw', height: '70vw', maxWidth: 700, maxHeight: 700, left: '-15%', top: '-15%', borderRadius: '50%', background: 'radial-gradient(circle, rgba(16,185,129,0.07) 0%, transparent 70%)', filter: 'blur(80px)', animation: 'orb-float 20s ease-in-out infinite alternate' }} />
        <div style={{ position: 'absolute', width: '60vw', height: '60vw', maxWidth: 600, maxHeight: 600, right: '-10%', bottom: '-10%', borderRadius: '50%', background: 'radial-gradient(circle, rgba(6,182,212,0.06) 0%, transparent 70%)', filter: 'blur(80px)', animation: 'orb-float 16s ease-in-out -8s infinite alternate' }} />
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 20%, black 0%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 20%, black 0%, transparent 100%)',
        }} />
      </div>

      {/* ── HISTORY DRAWER — always mounted ── */}
      <HistoryPanel isOpen={drawerOpen} onClose={() => setDrawer(false)} />

      {/* ── HEADER ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 30,
        background: 'rgba(4,4,14,0.88)', backdropFilter: 'blur(24px)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        WebkitBackdropFilter: 'blur(24px)',
      }}>
        <div style={{
          maxWidth: 1200, margin: '0 auto',
          padding: '0 clamp(16px, 4vw, 40px)',
          height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          {/* Logo */}
          <button onClick={reset} style={{
            display: 'flex', alignItems: 'center', gap: 11,
            background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              background: 'linear-gradient(135deg, #10b981, #06b6d4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 900, fontSize: 18, color: '#fff',
              boxShadow: '0 4px 16px rgba(16,185,129,0.4)',
            }}>V</div>
            <div>
              <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 800, fontSize: 15, color: '#f0f4ff', letterSpacing: '-0.01em', lineHeight: 1.2 }}>
                VAIDYADRISHTI <span style={{ color: '#10b981' }}>AI</span>
              </div>
              <div className="hidden sm:block" style={{ fontSize: 9, color: 'rgba(255,255,255,0.22)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
                Intelligent Analysis
              </div>
            </div>
          </button>

          {/* Right Group: Nav + CTA */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <nav style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <NavBtn onClick={reset} active={phase === 'idle' || phase === 'done'}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                </svg>
                <span className="hidden sm:inline">Dashboard</span>
              </NavBtn>
              <NavBtn onClick={() => setDrawer(true)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
                </svg>
                <span className="hidden sm:inline">History</span>
              </NavBtn>
            </nav>

            <div style={{ display: 'flex', gap: 6 }}>
              {phase === 'done' && result && (
                <button onClick={() => setWallet(true)} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'rgba(16,185,129,0.12)', color: '#6ee7b7',
                  border: '1px solid rgba(16,185,129,0.25)', borderRadius: 10,
                  padding: '8px 12px', fontFamily: "'Plus Jakarta Sans', sans-serif",
                  fontWeight: 700, fontSize: 12, cursor: 'pointer',
                  transition: 'all 0.2s',
                }}>💊 <span className="hidden sm:inline">Wallet</span></button>
              )}
              {(phase === 'done' || phase === 'error') && (
                <button onClick={reset} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'linear-gradient(135deg, #10b981, #06b6d4)',
                  color: '#fff', borderRadius: 10, border: 'none',
                  padding: '8px 14px', fontFamily: "'Plus Jakarta Sans', sans-serif",
                  fontWeight: 800, fontSize: 12, cursor: 'pointer',
                  boxShadow: '0 4px 16px rgba(16,185,129,0.35)',
                }}>+ <span className="hidden sm:inline">New Scan</span></button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── MAIN ── */}
      <main style={{ flex: 1, position: 'relative', zIndex: 10 }}>

        {/* IDLE */}
        {phase === 'idle' && import.meta.env.PROD && !import.meta.env.VITE_API_URL && (
          <div style={{ maxWidth: 480, margin: '0 auto', padding: '20px' }}>
            <div style={{ background: 'rgba(251,113,133,0.1)', border: '1px solid rgba(251,113,133,0.2)', borderRadius: 12, padding: '16px', color: '#fb7185', fontSize: 13, textAlign: 'center' }}>
              ⚠️ <strong>Configuration Missing:</strong> VITE_API_URL is not set.
              Add it to your deployment environment variables and redeploy.
            </div>
          </div>
        )}
        {phase === 'idle' && <Home onSubmit={run} disabled={false} />}

        {/* PROCESSING — pure document scan animation, no text */}
        {isBusy && (
          <div style={{ maxWidth: 480, margin: '0 auto', padding: 'clamp(24px,5vw,48px) 16px' }}>
            <div style={{
              background: 'rgba(8,8,20,0.92)', backdropFilter: 'blur(32px)',
              border: '1px solid rgba(16,185,129,0.18)', borderRadius: 24,
              overflow: 'hidden', position: 'relative',
              boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(16,185,129,0.08)',
              animation: 'scale-in 0.3s ease-out both',
              minHeight: 340,
            }}>
              {/* Full-frame document scanner — no text */}
              <DocumentScanner />

              {/* Minimal bottom label */}
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                padding: '60px 24px 24px',
                background: 'linear-gradient(to top, rgba(8,8,20,0.95) 0%, transparent 100%)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                zIndex: 10,
              }}>
                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  {[0, 1, 2].map(i => (
                    <div key={i} style={{
                      width: 6, height: 6, borderRadius: '50%', background: '#10b981',
                      animation: `dot-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                    }} />
                  ))}
                </div>
                <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '0.04em' }}>
                  Analyzing prescription…
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ERROR */}
        {phase === 'error' && (
          <div style={{ maxWidth: 480, margin: '0 auto', padding: 'clamp(40px,8vw,80px) 16px', textAlign: 'center' }}>
            <div style={{
              background: 'rgba(8,8,20,0.9)', backdropFilter: 'blur(24px)',
              border: '1px solid rgba(244,63,94,0.2)', borderRadius: 24,
              padding: 'clamp(32px, 6vw, 56px)', animation: 'fade-up 0.3s ease-out both',
            }}>
              <div style={{ fontSize: 52, marginBottom: 20 }}>⚠️</div>
              <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 800, fontSize: 22, color: '#fb7185', marginBottom: 12 }}>
                Analysis Failed
              </h3>
              <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', lineHeight: 1.75, marginBottom: 32, maxWidth: 340, marginInline: 'auto' }}>{error}</p>
              <button onClick={reset} style={{
                background: 'linear-gradient(135deg, #10b981, #06b6d4)', color: '#fff',
                borderRadius: 14, border: 'none', padding: '14px 32px',
                fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 800, fontSize: 15, cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(16,185,129,0.4)',
              }}>Try Again</button>
            </div>
          </div>
        )}

        {/* RESULTS */}
        {phase === 'done' && result && (
          <div style={{
            maxWidth: 800, margin: '0 auto',
            padding: 'clamp(24px, 4vw, 48px) clamp(16px, 4vw, 40px) 80px',
          }}>
            {/* Medical Wallet Modal */}
            {walletOpen && <MedicalWallet result={result} onClose={() => setWallet(false)} />}

            {/* Summary */}
            <div style={{ marginBottom: 28 }}>
              <SummaryCard result={result} />
            </div>

            {/* Medicines header — wallet button is in the top nav */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
              <h2 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 800, fontSize: 20, color: '#f0f4ff', letterSpacing: '-0.02em' }}>
                Detected Medicines
                <span style={{
                  marginLeft: 10, display: 'inline-flex', alignItems: 'center',
                  background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)',
                  borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 700, color: '#10b981',
                  verticalAlign: 'middle',
                }}>{result.extracted_medicines?.length ?? 0}</span>
              </h2>
            </div>

            {/* Cards */}
            {result.extracted_medicines?.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {result.extracted_medicines.map((ext, i) => (
                  <MedicineCard key={i} extraction={ext} index={i} />
                ))}
              </div>
            ) : (
              <div style={{
                padding: 'clamp(48px, 8vw, 80px) 24px', textAlign: 'center',
                background: 'rgba(8,8,20,0.85)', backdropFilter: 'blur(20px)',
                border: '2px dashed rgba(255,255,255,0.06)', borderRadius: 24,
                animation: 'fade-up 0.35s ease-out both',
              }}>
                <div style={{ fontSize: 56, opacity: 0.15, marginBottom: 20 }}>💊</div>
                <h4 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 800, fontSize: 22, color: '#f0f4ff', marginBottom: 12 }}>
                  No Medicines Detected
                </h4>
                <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.35)', lineHeight: 1.75, maxWidth: 380, margin: '0 auto 32px' }}>
                  {result.ocr_result?.final_text?.includes('[unclear]')
                    ? "The image has unclear text. Try switching to 'Paste Text' mode."
                    : "Try a clearer image or paste the prescription text directly."
                  }
                </p>
                <button onClick={reset} style={{
                  background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.6)',
                  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 12,
                  padding: '12px 28px', fontFamily: "'Plus Jakarta Sans', sans-serif",
                  fontWeight: 700, fontSize: 14, cursor: 'pointer',
                }}>Try New Scan</button>
              </div>
            )}
          </div>
        )}
      </main>

    </>
  );
}

function NavBtn({ children, onClick, active }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 6,
      background: active ? 'rgba(16,185,129,0.1)' : 'none',
      border: active ? '1px solid rgba(16,185,129,0.2)' : '1px solid transparent',
      cursor: 'pointer',
      color: active ? '#6ee7b7' : 'rgba(255,255,255,0.4)',
      padding: '7px 13px', borderRadius: 10,
      fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: 13,
      transition: 'color 0.15s, background 0.15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.color = '#f0f4ff'; e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.color = active ? '#6ee7b7' : 'rgba(255,255,255,0.4)'; e.currentTarget.style.background = active ? 'rgba(16,185,129,0.1)' : 'none'; }}
    >{children}</button>
  );
}
