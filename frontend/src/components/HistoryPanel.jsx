import { useEffect, useState } from 'react';
import { getHistory, clearHistory, deleteHistoryEntry } from '../services/HistoryService.js';

function timeAgo(iso) {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return `${~~s}s ago`;
    if (s < 3600) return `${~~(s / 60)}m ago`;
    if (s < 86400) return `${~~(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}

const CONF_COLOR = { High: '#22c55e', Medium: '#f59e0b', Low: '#f43f5e' };

export default function HistoryPanel({ isOpen, onClose }) {
    const [history, setHistory] = useState([]);

    useEffect(() => {
        if (!isOpen) return;
        setHistory(getHistory()); // eslint-disable-line react-hooks/set-state-in-effect
    }, [isOpen]);

    const doClear = () => { clearHistory(); setHistory([]); };
    const doDelete = id => { deleteHistoryEntry(id); setHistory(h => h.filter(e => e.id !== id)); };

    return (
        <>
            {/* Backdrop */}
            {isOpen && (
                <div onClick={onClose} style={{
                    position: 'fixed', inset: 0, zIndex: 40,
                    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                    WebkitBackdropFilter: 'blur(4px)', animation: 'fade-in 0.2s ease both',
                }} />
            )}

            {/* Drawer */}
            <aside style={{
                position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 50,
                width: 'min(400px, 100vw)',
                background: 'rgba(8,8,20,0.97)',
                backdropFilter: 'blur(32px)', WebkitBackdropFilter: 'blur(32px)',
                borderLeft: '1px solid rgba(255,255,255,0.07)',
                display: 'flex', flexDirection: 'column',
                transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
                transition: 'transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: isOpen ? '-24px 0 80px rgba(0,0,0,0.5)' : 'none',
            }}>
                {/* Header */}
                <div style={{
                    padding: '20px 20px 16px',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    flexShrink: 0,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{
                            width: 38, height: 38, borderRadius: 11,
                            background: 'rgba(16,185,129,0.12)',
                            border: '1px solid rgba(16,185,129,0.25)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                        }}>🕐</div>
                        <div>
                            <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 800, fontSize: 15, color: '#f0f4ff', lineHeight: 1.2 }}>
                                Scan History
                            </p>
                            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>
                                {history.length} scan{history.length !== 1 ? 's' : ''} saved
                            </p>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        {history.length > 0 && (
                            <button onClick={doClear} style={{
                                background: 'rgba(244,63,94,0.08)', color: '#fb7185',
                                border: '1px solid rgba(244,63,94,0.15)', borderRadius: 8,
                                padding: '6px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                                fontFamily: "'Plus Jakarta Sans', sans-serif",
                            }}>Clear all</button>
                        )}
                        <button onClick={onClose} style={{
                            width: 34, height: 34, borderRadius: 9,
                            background: 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            color: 'rgba(255,255,255,0.5)', display: 'flex',
                            alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', fontSize: 16,
                        }}>×</button>
                    </div>
                </div>

                {/* List */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {history.length === 0 ? (
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '60px 20px' }}>
                            <div style={{ fontSize: 52, opacity: 0.1, marginBottom: 16 }}>📋</div>
                            <p style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 16, color: 'rgba(255,255,255,0.35)', marginBottom: 8 }}>No scans yet</p>
                            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.2)', lineHeight: 1.7 }}>
                                Analyzed prescriptions are<br />automatically saved here.
                            </p>
                        </div>
                    ) : (
                        history.map((e, i) => (
                            <HistoryCard key={e.id} entry={e} onDelete={doDelete} delay={i * 25} />
                        ))
                    )}
                </div>
            </aside>
        </>
    );
}

function HistoryCard({ entry: e, onDelete, delay }) {
    const [hovered, setHovered] = useState(false);

    return (
        <div
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                background: hovered ? 'rgba(16,185,129,0.06)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${hovered ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.06)'}`,
                borderRadius: 14, padding: '14px 14px',
                position: 'relative', transition: 'all 0.2s',
                animation: `fade-up 0.3s ease-out ${delay}ms both`,
            }}
        >
            {/* Delete × */}
            <button
                onClick={() => onDelete(e.id)}
                style={{
                    position: 'absolute', top: 10, right: 10,
                    width: 24, height: 24, borderRadius: 6,
                    background: 'rgba(244,63,94,0.1)', color: '#fb7185',
                    border: '1px solid rgba(244,63,94,0.15)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', fontSize: 14, opacity: hovered ? 1 : 0,
                    transition: 'opacity 0.15s',
                }}>×</button>

            {/* Row 1: type badge + time */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 8px', borderRadius: 999, fontSize: 9, fontWeight: 800,
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    background: e.inputType === 'image' ? 'rgba(16,185,129,0.12)' : 'rgba(6,182,212,0.12)',
                    color: e.inputType === 'image' ? '#6ee7b7' : '#67e8f9',
                    border: `1px solid ${e.inputType === 'image' ? 'rgba(16,185,129,0.2)' : 'rgba(6,182,212,0.2)'}`,
                }}>
                    {e.inputType === 'image' ? '📷' : '✏️'} {e.inputType}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>{timeAgo(e.timestamp)}</span>
            </div>

            {/* Condition */}
            <p style={{
                fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700,
                fontSize: 14, color: '#f0f4ff', lineHeight: 1.35, marginBottom: 10,
            }}>
                {e.medical_condition || <span style={{ color: 'rgba(255,255,255,0.25)', fontStyle: 'italic' }}>No condition detected</span>}
            </p>

            {/* Medicine chips */}
            {e.medicines?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
                    {e.medicines.slice(0, 5).map((m, j) => (
                        <span key={j} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 9px', borderRadius: 999, fontSize: 10, fontWeight: 600,
                            background: m.matched ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.04)',
                            color: m.matched ? '#4ade80' : 'rgba(255,255,255,0.4)',
                            border: `1px solid ${m.matched ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.06)'}`,
                            fontFamily: "'Plus Jakarta Sans', sans-serif",
                        }}>
                            {m.matched && <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />}
                            {m.brand_name}
                            {m.strength && <span style={{ opacity: 0.6 }}>{m.strength}</span>}
                        </span>
                    ))}
                    {e.medicines.length > 5 && (
                        <span style={{
                            padding: '3px 9px', borderRadius: 999, fontSize: 10, fontWeight: 600,
                            background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.3)',
                            border: '1px solid rgba(255,255,255,0.06)',
                        }}>+{e.medicines.length - 5} more</span>
                    )}
                </div>
            )}

            {/* Meta row */}
            <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>
                <span>💊 {e.medicine_count} medicine{e.medicine_count !== 1 ? 's' : ''}</span>
                {e.processing_time_ms > 0 && <span>⚡ {e.processing_time_ms}ms</span>}
                {e.ocr_score != null && <span>OCR {e.ocr_score.toFixed(0)}%</span>}
            </div>
        </div>
    );
}
