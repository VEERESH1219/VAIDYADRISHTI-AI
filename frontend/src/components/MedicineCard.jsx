import { useEffect, useState } from 'react';

const METHOD_LABEL = {
    EXACT: 'Exact', FUZZY: 'Fuzzy', VECTOR: 'Vector',
    LOCAL_CACHE: '⚡ Cached', CACHE: '⚡ Cached',
    exact_match: 'Exact', fuzzy_match: 'Fuzzy', vector_similarity: 'Vector',
};

const CONF = {
    High: { bar: '#10b981', text: '#34d399', bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.2)', label: 'High Confidence' },
    Medium: { bar: '#f59e0b', text: '#fbbf24', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.2)', label: 'Medium Confidence' },
    Low: { bar: '#ef4444', text: '#fca5a5', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.2)', label: 'Low Confidence' },
};

export default function MedicineCard({ extraction, index }) {
    const [barW, setBarW] = useState(0);

    const { structured_data: sd, matched_medicine: mm, fallback_required } = extraction;
    const hasMatch = !!mm;
    const conf = mm?.confidence ?? 'Low';
    const sim = mm?.similarity_percentage ?? 0;
    const C = CONF[conf] || CONF.Low;
    const isLocalCache = mm?.match_method === 'LOCAL_CACHE' || mm?.match_method === 'CACHE';
    const isAI = !isLocalCache && (mm?.verified_by?.toLowerCase().includes('ai') || mm?.verified_by?.toLowerCase().includes('openai'));

    // Accent stripe color
    const accent = !hasMatch ? '#ef4444' : isAI ? '#10b981' : '#10b981';

    useEffect(() => {
        const t = setTimeout(() => setBarW(sim), 400 + index * 100);
        return () => clearTimeout(t);
    }, [sim, index]);

    return (
        <article
            style={{
                background: 'rgba(13,17,23,0.8)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 20,
                overflow: 'hidden',
                animation: `fade-up 0.4s ease-out both`,
                animationDelay: `${index * 80}ms`,
                backdropFilter: 'blur(20px)',
            }}
        >
            {/* Top accent line */}
            <div style={{ height: 3, background: accent, width: '100%' }} />

            <div style={{ padding: 'clamp(20px, 3vw, 36px)' }}>

                {/* ── Row 1: Medicine name + badge ── */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                            {/* Number */}
                            <span style={{
                                width: 26, height: 26, borderRadius: '50%', background: accent + '22',
                                border: `1.5px solid ${accent}44`, color: accent,
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 11, fontWeight: 800, fontFamily: "'Plus Jakarta Sans', sans-serif",
                                flexShrink: 0,
                            }}>{index + 1}</span>

                            <h3 style={{
                                fontFamily: "'Plus Jakarta Sans', sans-serif",
                                fontWeight: 800, fontSize: 'clamp(18px, 2.5vw, 24px)',
                                color: '#f0f4ff', letterSpacing: '-0.02em', lineHeight: 1.2,
                            }}>
                                {sd.brand_name}
                                {sd.brand_variant && (
                                    <span style={{ color: '#10b981', fontWeight: 700, marginLeft: 6 }}>{sd.brand_variant}</span>
                                )}
                            </h3>
                        </div>

                        {/* Tags */}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {sd.form && <Tag>{sd.form}</Tag>}
                            {sd.frequency_per_day && <Tag>{sd.frequency_per_day}× daily</Tag>}
                            {sd.duration_days && <Tag>{sd.duration_days} days</Tag>}
                        </div>
                    </div>

                    {/* Badge */}
                    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                        {hasMatch ? (
                            <span style={{
                                background: C.bg, color: C.text, border: `1px solid ${C.border}`,
                                borderRadius: 999, padding: '5px 12px',
                                fontSize: 11, fontWeight: 700, fontFamily: "'Plus Jakarta Sans', sans-serif",
                                letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                            }}>
                                {conf === 'High' ? '✓' : conf === 'Medium' ? '~' : '!'}&nbsp;{conf}
                            </span>
                        ) : (
                            <span style={{
                                background: 'rgba(239,68,68,0.1)', color: '#fca5a5',
                                border: '1px solid rgba(239,68,68,0.2)',
                                borderRadius: 999, padding: '5px 12px',
                                fontSize: 11, fontWeight: 700, fontFamily: "'Plus Jakarta Sans', sans-serif",
                                letterSpacing: '0.05em', textTransform: 'uppercase',
                            }}>No Match</span>
                        )}
                        {isLocalCache && (
                            <span style={{
                                background: 'rgba(16,185,129,0.12)', color: '#34d399',
                                border: '1px solid rgba(16,185,129,0.3)',
                                borderRadius: 999, padding: '3px 10px', fontSize: 9,
                                fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                            }}>⚡ Local Cache</span>
                        )}
                        {isAI && (
                            <span style={{
                                background: 'rgba(16,185,129,0.1)', color: '#6ee7b7',
                                border: '1px solid rgba(16,185,129,0.2)',
                                borderRadius: 999, padding: '3px 10px', fontSize: 9,
                                fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                            }}>AI Stage 4</span>
                        )}
                    </div>
                </div>

                {/* ── Row 2: Match result ── */}
                {hasMatch && (
                    <>
                        {/* Generic + Strength in a clean row */}
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                            gap: 12,
                            marginBottom: 20,
                        }}>
                            <InfoCell label="Generic Name" value={mm.generic_name} />
                            <InfoCell label="Strength" value={mm.strength || '—'} valueColor="#10b981" large />
                            {mm.manufacturer && <InfoCell label="Manufacturer" value={mm.manufacturer} span />}
                        </div>

                        {/* Confidence bar */}
                        <div style={{ marginBottom: mm.description ? 20 : 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                                        Match Confidence
                                    </span>
                                    {mm.match_method && (
                                        <Tag small>{METHOD_LABEL[mm.match_method] || mm.match_method}</Tag>
                                    )}
                                </div>
                                <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 800, fontSize: 16, color: C.text }}>
                                    {sim.toFixed(0)}%
                                </span>
                            </div>
                            <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 999, overflow: 'hidden' }}>
                                <div style={{
                                    height: '100%', width: `${barW}%`, borderRadius: 999,
                                    background: `linear-gradient(90deg, ${accent}, ${C.bar})`,
                                    transition: 'width 1s cubic-bezier(0.34,1.2,0.64,1)',
                                }} />
                            </div>
                        </div>

                        {/* Clinical usage */}
                        {mm.description && (
                            <div style={{
                                marginTop: 20, padding: '14px 18px',
                                background: 'rgba(16,185,129,0.06)', borderRadius: 12,
                                border: '1px solid rgba(16,185,129,0.15)',
                            }}>
                                <p style={{ fontSize: 10, color: 'rgba(16,185,129,0.7)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6, fontWeight: 700 }}>
                                    Clinical Usage
                                </p>
                                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.7, fontStyle: 'italic' }}>
                                    {mm.description}
                                </p>
                            </div>
                        )}

                        {/* Warnings + FDC */}
                        {(mm.validation_warnings?.length > 0 || mm.is_combination) && (
                            <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                {mm.validation_warnings?.map((w, i) => (
                                    <span key={i} style={{
                                        background: 'rgba(245,158,11,0.1)', color: '#fbbf24',
                                        border: '1px solid rgba(245,158,11,0.2)',
                                        borderRadius: 999, padding: '3px 10px', fontSize: 10, fontWeight: 700,
                                        textTransform: 'uppercase', letterSpacing: '0.06em',
                                    }}>⚠ {w.replace(/_/g, ' ')}</span>
                                ))}
                                {mm.is_combination && (
                                    <span style={{
                                        background: 'rgba(16,185,129,0.1)', color: '#6ee7b7',
                                        border: '1px solid rgba(16,185,129,0.2)',
                                        borderRadius: 999, padding: '3px 10px', fontSize: 10, fontWeight: 700,
                                        textTransform: 'uppercase', letterSpacing: '0.06em',
                                    }}>Fixed-Dose Combination</span>
                                )}
                            </div>
                        )}
                    </>
                )}

                {/* ── No Match / Fallback ── */}
                {!hasMatch && fallback_required && (
                    <div style={{
                        padding: '20px 24px', borderRadius: 14,
                        background: 'rgba(245,158,11,0.05)',
                        border: '1px solid rgba(245,158,11,0.15)',
                        marginTop: 4,
                    }}>
                        <p style={{ fontSize: 15, fontWeight: 600, color: '#f0f4ff', marginBottom: 6, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                            Manual Lookup Needed
                        </p>
                        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.65, marginBottom: 16 }}>
                            Not found in our database, OpenFDA, RxNorm, or AI knowledge base.
                        </p>
                        <a href={`https://www.google.com/search?q=${encodeURIComponent(sd.brand_name + ' medicine tablet uses dosage')}`}
                            target="_blank" rel="noopener noreferrer"
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: 6,
                                padding: '9px 18px', borderRadius: 10,
                                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                                color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: 600,
                                textDecoration: 'none', fontFamily: "'Plus Jakarta Sans', sans-serif",
                            }}>
                            🔍 Search Google
                        </a>
                    </div>
                )}
            </div>
        </article>
    );
}

/* ── Helpers ── */
function Tag({ children, small }) {
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center',
            padding: small ? '1px 7px' : '3px 10px',
            borderRadius: 999, fontSize: small ? 9 : 11, fontWeight: 600,
            background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.45)',
            border: '1px solid rgba(255,255,255,0.08)',
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            whiteSpace: 'nowrap',
        }}>{children}</span>
    );
}

function InfoCell({ label, value, valueColor, large }) {
    return (
        <div>
            <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 5, fontWeight: 700 }}>
                {label}
            </p>
            <p style={{
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                fontWeight: large ? 800 : 600,
                fontSize: large ? 18 : 14,
                color: valueColor || '#f0f4ff',
                lineHeight: 1.3,
            }}>{value}</p>
        </div>
    );
}
