import { useState, useRef, useCallback } from 'react';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export default function UploadZone({ onSubmit, disabled }) {
    const [inputMode, setInputMode] = useState('image'); // 'image' | 'text'
    const [file, setFile] = useState(null);
    const [preview, setPreview] = useState(null);
    const [rawText, setRawText] = useState('');
    const [dragActive, setDragActive] = useState(false);
    const fileInputRef = useRef(null);

    const handleFile = useCallback((selectedFile) => {
        if (!selectedFile) return;

        if (!ACCEPTED_TYPES.includes(selectedFile.type)) {
            alert('Please upload a JPG, PNG, or WebP image.');
            return;
        }

        if (selectedFile.size > MAX_SIZE) {
            alert('File size must be under 10MB.');
            return;
        }

        setFile(selectedFile);

        const reader = new FileReader();
        reader.onload = (e) => setPreview(e.target.result);
        reader.readAsDataURL(selectedFile);
    }, []);

    const handleDrop = useCallback(
        (e) => {
            e.preventDefault();
            setDragActive(false);
            if (e.dataTransfer.files?.[0]) {
                handleFile(e.dataTransfer.files[0]);
            }
        },
        [handleFile]
    );

    const fileToBase64 = (file) =>
        new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

    const handleSubmit = async () => {
        if (inputMode === 'image' && file) {
            const base64 = await fileToBase64(file);
            onSubmit({ image: base64 });
        } else if (inputMode === 'text' && rawText.trim()) {
            onSubmit({ raw_text: rawText.trim() });
        }
    };

    const clearFile = () => {
        setFile(null);
        setPreview(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const canSubmit =
        !disabled &&
        ((inputMode === 'image' && file) || (inputMode === 'text' && rawText.trim()));

    return (
        <div className="w-full flex flex-col gap-6">
            {/* ── Tab Switcher ─────────────────────── */}
            <div className="flex p-1.5 rounded-2xl glass-panel border-white/5 mx-auto w-fit mb-4">
                <button
                    onClick={() => setInputMode('image')}
                    className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold transition-all display-font tracking-wider
                        ${inputMode === 'image'
                            ? 'bg-white/10 text-white shadow-xl shadow-black/20'
                            : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                        }`}
                >
                    <span className="text-base text-cyan-400">📸</span> SCAN IMAGE
                </button>
                <button
                    onClick={() => setInputMode('text')}
                    className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold transition-all display-font tracking-wider
                        ${inputMode === 'text'
                            ? 'bg-white/10 text-white shadow-xl shadow-black/20'
                            : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                        }`}
                >
                    <span className="text-base text-purple-400">⌨️</span> PASTE TEXT
                </button>
            </div>

            {/* ── Multi-Mode Container ────────────── */}
            <div className="relative glass-panel rounded-[2rem] p-4 border-white/5 shadow-2xl overflow-hidden min-h-[300px] flex flex-col">

                {inputMode === 'image' && (
                    <div className="flex-1 flex flex-col">
                        {!preview ? (
                            <div
                                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                                onDragLeave={() => setDragActive(false)}
                                onDrop={handleDrop}
                                onClick={() => fileInputRef.current?.click()}
                                className={`flex-1 flex flex-col items-center justify-center gap-6 rounded-[1.5rem] border-2 border-dashed transition-all cursor-pointer group
                                    ${dragActive
                                        ? 'border-cyan-400 bg-cyan-400/5 animate-pulse-cyan'
                                        : 'border-white/10 bg-black/20 hover:border-white/20 hover:bg-white/5'
                                    }`}
                            >
                                <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-cyan-400/20 to-indigo-400/20 flex items-center justify-center border border-white/10 group-hover:scale-110 transition-transform">
                                    <svg className="w-10 h-10 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                                    </svg>
                                </div>
                                <div className="text-center">
                                    <h3 className="text-white font-bold text-xl display-font mb-2">
                                        Upload Prescription
                                    </h3>
                                    <p className="text-slate-400 text-sm body-font max-w-[240px] leading-relaxed mx-auto">
                                        Drop your image here or <span className="text-cyan-400 font-semibold underline decoration-cyan-400/30">browse</span> files
                                    </p>
                                </div>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".jpg,.jpeg,.png,.webp"
                                    onChange={(e) => handleFile(e.target.files[0])}
                                    className="hidden"
                                />
                            </div>
                        ) : (
                            <div className="flex-1 flex flex-col rounded-[1.5rem] overflow-hidden bg-black/40 border border-white/5 relative">
                                <div className="flex-1 min-h-[220px] flex items-center justify-center p-4">
                                    <img
                                        src={preview}
                                        alt="Prescription preview"
                                        className="max-h-[240px] rounded-lg shadow-2xl object-contain"
                                    />
                                </div>

                                <div className="p-4 glass-panel border-0 border-t border-white/5 flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded bg-cyan-400/20 flex items-center justify-center text-sm">📸</div>
                                        <div className="overflow-hidden max-w-[140px]">
                                            <p className="text-xs font-bold text-white display-font truncate">{file?.name}</p>
                                            <p className="text-[10px] text-slate-500 mono-font tracking-tight capitalize">
                                                {(file?.size / 1024).toFixed(1)} KB · {file?.type.split('/')[1]}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={clearFile}
                                        className="px-4 py-2 rounded-xl bg-red-500/10 text-red-500 text-[10px] font-black uppercase tracking-wider hover:bg-red-500 hover:text-white transition-all active:scale-90"
                                    >
                                        Discard
                                    </button>
                                </div>

                                <div className="absolute top-4 right-4 bg-green-500 text-white text-[10px] font-black px-3 py-1 rounded-full shadow-lg shadow-green-500/40 animate-bounce">
                                    READY
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {inputMode === 'text' && (
                    <div className="flex-1 flex flex-col p-2">
                        <textarea
                            value={rawText}
                            onChange={(e) => setRawText(e.target.value)}
                            placeholder="Paste text directly from the prescription..."
                            className="flex-1 w-full bg-black/20 rounded-2xl border border-white/5 p-6 text-slate-100 text-base body-font leading-relaxed placeholder-slate-700 focus:outline-none focus:ring-2 focus:ring-purple-500/20 transition-all resize-none shadow-inner"
                        />
                        <div className="mt-4 flex gap-4 text-xs text-slate-500 px-2 italic font-medium opacity-60">
                            <span>Ex: Amoxiclav 625mg...</span>
                            <span>Pantop 40mg...</span>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Action Button ────────────────────── */}
            <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className={`py-5 px-8 rounded-3xl font-black text-sm display-font tracking-[0.15em] uppercase transition-all duration-500 group relative overflow-hidden
                    ${canSubmit
                        ? 'btn-primary shadow-2xl scale-100'
                        : 'bg-white/5 text-slate-700 backdrop-blur-sm grayscale scale-[0.98] cursor-not-allowed opacity-40'
                    }`}
            >
                <div className="relative z-10 flex items-center justify-center gap-3">
                    {disabled ? (
                        <>
                            <div className="loading-dots flex gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-950 animate-bounce" />
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-950 animate-bounce [animation-delay:0.2s]" />
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-950 animate-bounce [animation-delay:0.4s]" />
                            </div>
                            ESTABLISHING CONSENSUS...
                        </>
                    ) : (
                        <>
                            ANALYZE PRESCRIPTION
                            <span className="text-xl leading-none transition-transform group-hover:translate-x-1">→</span>
                        </>
                    )}
                </div>
                {/* Glow overlay */}
                <div className="absolute inset-0 bg-white/20 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>

            <p className="text-[10px] text-slate-600 text-center uppercase tracking-widest mono-font">
                Images are processed securely using on-device OCR fallback
            </p>
        </div>
    );
}
