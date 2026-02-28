/**
 * PipelineStepper — Prescription scanning animation card.
 * Features: animated scan beam, pulse rings, glowing steps.
 */

const STEPS = [
    { label: 'Upload', icon: '⬆', desc: 'Receiving image / text' },
    { label: 'Preprocess', icon: '🔧', desc: 'Sharpening & normalizing image' },
    { label: 'OCR', icon: '👁', desc: 'Multi-pass text extraction' },
    { label: 'NLP Extract', icon: '🧠', desc: 'Identifying medicines & condition' },
    { label: 'DB Match', icon: '🔎', desc: 'Searching 250K+ medicine records' },
];

export default function PipelineStepper({ currentStep }) {
    return (
        <div style={{ position: 'relative' }}>
            {/* ── Scan beam overlay ── */}
            <ScanBeam />

            {/* ── Steps ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, position: 'relative', zIndex: 2 }}>
                {STEPS.map((step, i) => {
                    const done = i < currentStep;
                    const active = i === currentStep;

                    return (
                        <div key={step.label} style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
                            {/* Left: circle + connector */}
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 48, flexShrink: 0 }}>
                                {/* Circle */}
                                <div style={{
                                    width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    position: 'relative', zIndex: 1,
                                    background: done
                                        ? 'rgba(0,200,168,0.15)'
                                        : active
                                            ? 'rgba(0,200,168,0.08)'
                                            : 'rgba(255,255,255,0.03)',
                                    border: `2px solid ${done ? '#6366f1' :
                                        active ? 'rgba(0,200,168,0.5)' :
                                            'rgba(255,255,255,0.08)'
                                        }`,
                                    boxShadow: done
                                        ? '0 0 14px rgba(0,200,168,0.35)'
                                        : active
                                            ? '0 0 20px rgba(0,200,168,0.2)'
                                            : 'none',
                                    transition: 'all 0.4s ease',
                                }}>
                                    {/* Active pulse ring */}
                                    {active && (
                                        <div style={{
                                            position: 'absolute', inset: -6,
                                            borderRadius: '50%',
                                            border: '2px solid rgba(0,200,168,0.25)',
                                            animation: 'ping-ring 1.4s ease-out infinite',
                                        }} />
                                    )}

                                    {done ? (
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                                            stroke="#6366f1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M20 6L9 17l-5-5" />
                                        </svg>
                                    ) : active ? (
                                        <div style={{
                                            width: 14, height: 14, borderRadius: '50%',
                                            border: '2.5px solid transparent',
                                            borderTopColor: '#6366f1',
                                            borderRightColor: 'rgba(0,200,168,0.3)',
                                            animation: 'spin 0.7s linear infinite',
                                        }} />
                                    ) : (
                                        <span style={{ fontSize: 14, opacity: 0.25 }}>{step.icon}</span>
                                    )}
                                </div>

                                {/* Connector */}
                                {i < STEPS.length - 1 && (
                                    <div style={{
                                        width: 2, flex: 1, minHeight: 20, margin: '3px 0',
                                        background: done
                                            ? 'linear-gradient(to bottom, #6366f1, rgba(0,200,168,0.3))'
                                            : 'rgba(255,255,255,0.06)',
                                        borderRadius: 1,
                                        transition: 'background 0.5s ease',
                                    }} />
                                )}
                            </div>

                            {/* Right: label + desc */}
                            <div style={{
                                paddingLeft: 14,
                                paddingBottom: i < STEPS.length - 1 ? 22 : 0,
                                paddingTop: 9, flex: 1,
                            }}>
                                <div style={{
                                    fontFamily: "'Plus Jakarta Sans', sans-serif",
                                    fontWeight: 700, fontSize: 14, marginBottom: 3,
                                    color: done ? '#6366f1' : active ? '#f0f4ff' : 'rgba(255,255,255,0.25)',
                                    transition: 'color 0.3s',
                                    display: 'flex', alignItems: 'center', gap: 8,
                                }}>
                                    {step.label}
                                    {done && (
                                        <span style={{
                                            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                                            color: 'rgba(0,200,168,0.7)', textTransform: 'uppercase',
                                        }}>✓ Done</span>
                                    )}
                                </div>
                                <div style={{
                                    fontSize: 12, lineHeight: 1.5,
                                    color: active ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.2)',
                                    transition: 'color 0.3s',
                                    display: 'flex', alignItems: 'center', gap: 6,
                                }}>
                                    {step.desc}
                                    {active && (
                                        <span style={{ display: 'inline-flex', gap: 3, marginLeft: 2 }}>
                                            {[0, 1, 2].map(d => (
                                                <span key={d} style={{
                                                    width: 4, height: 4, borderRadius: '50%',
                                                    background: '#6366f1', display: 'inline-block',
                                                    animation: `dot-bounce 1.1s ease-in-out ${d * 0.18}s infinite`,
                                                }} />
                                            ))}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/* ── Scanning beam that sweeps top→bottom ── */
function ScanBeam() {
    return (
        <>
            {/* The green beam */}
            <div style={{
                position: 'absolute', left: 0, right: 0, height: 2, zIndex: 3,
                background: 'linear-gradient(90deg, transparent, #6366f1, rgba(0,200,168,0.4), #6366f1, transparent)',
                boxShadow: '0 0 20px 4px rgba(0,200,168,0.3)',
                animation: 'scan-sweep 2.2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                borderRadius: 9999,
                pointerEvents: 'none',
            }} />
            {/* Glowing halo behind the beam */}
            <div style={{
                position: 'absolute', left: 0, right: 0, height: 40, zIndex: 2,
                background: 'linear-gradient(180deg, transparent, rgba(0,200,168,0.06), transparent)',
                animation: 'scan-sweep 2.2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                pointerEvents: 'none',
                marginTop: -19,
            }} />
        </>
    );
}
