import React from 'react';
import { ExportResult, ExportResultTone, getExportResultMessages } from '../utils/exportResult';
import { DocsIcon, DriveIcon, ClassroomIcon, NotebookLMIcon } from './Icons';

interface ExportResultSurfaceProps {
    result: ExportResult | null;
    onClose: () => void;
    langCode: string;
}

const TONE_STYLES: Record<ExportResultTone, { icon: string; detail: string }> = {
    success: {
        icon: 'bg-emerald-50 text-emerald-600',
        detail: 'bg-emerald-50/70 text-emerald-800 border border-emerald-100',
    },
    error: {
        icon: 'bg-red-50 text-red-600',
        detail: 'bg-red-50/70 text-red-800 border border-red-100',
    },
    fallback: {
        icon: 'bg-amber-50 text-amber-600',
        detail: 'bg-amber-50/70 text-amber-800 border border-amber-100',
    },
};

const TARGET_ICON: Record<ExportResult['target'], React.FC> = {
    drive: DriveIcon,
    docs: DocsIcon,
    classroom: ClassroomIcon,
    notebooklm: NotebookLMIcon,
};

/**
 * Non-blocking export result surface (#66).
 *
 * It stays above the bottom controls without taking over the page, replacing
 * blocking browser alerts while keeping destination actions explicit.
 */
const ExportResultSurface: React.FC<ExportResultSurfaceProps> = ({ result, onClose, langCode }) => {
    if (!result) return null;

    const closeLabel = getExportResultMessages(langCode).close;
    const tone = TONE_STYLES[result.tone] || TONE_STYLES.success;
    const TargetIcon = TARGET_ICON[result.target] || NotebookLMIcon;

    return (
        <section
            data-testid="export-result-surface"
            role="status"
            aria-live="polite"
            className="fixed bottom-24 left-4 right-4 z-[100] sm:left-auto sm:right-6 sm:w-[28rem] rounded-2xl border border-gray-100 bg-white/95 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4 duration-200"
        >
            <div className="flex items-start gap-3 p-4">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${tone.icon}`}>
                    <TargetIcon />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                        <h2 className="text-sm font-black text-gray-900 break-words">{result.title}</h2>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label={closeLabel}
                            className="shrink-0 rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-gray-700 break-words">{result.message}</p>
                    {result.detail && (
                        <p
                            data-testid="export-result-detail"
                            className={`mt-3 rounded-xl p-3 text-xs leading-relaxed break-words ${tone.detail}`}
                        >
                            {result.detail}
                        </p>
                    )}
                    {result.action && (
                        <a
                            data-testid="export-result-action"
                            href={result.action.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-3 inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white shadow-sm transition-all hover:bg-indigo-700 active:scale-95"
                        >
                            {result.action.label}
                        </a>
                    )}
                </div>
            </div>
        </section>
    );
};

export default ExportResultSurface;
