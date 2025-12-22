import React from 'react';
import { ArrowRightIcon } from './Icons';
import { Language, TranslationMap } from '../types';
import { SUPPORTED_LANGUAGES } from '../constants';

interface LanguageSelectorProps {
    langInput: Language;
    setLangInput: (l: Language) => void;
    langOutput: Language;
    setLangOutput: (l: Language) => void;
    onSwapLanguages: () => void;
    t: TranslationMap;
    onLanguageManualSelect: () => void;
    uiLangCode: string;
}

const LanguageSelector: React.FC<LanguageSelectorProps> = ({
    langInput,
    setLangInput,
    langOutput,
    setLangOutput,
    onSwapLanguages,
    t,
    onLanguageManualSelect,
    uiLangCode,
}) => {
    return (
        <div className="bg-white px-3 py-1 shadow-sm z-10 flex flex-col shrink-0">
            <div className="flex items-center justify-between gap-2 bg-gray-50 p-1.5 rounded-2xl border border-gray-200">
                <div
                    className="flex-1 flex flex-col items-center min-w-0 hover:bg-white hover:shadow-sm rounded-xl transition-all cursor-pointer group py-1"
                >
                    <span className="text-[10px] text-gray-800 font-bold mb-1 whitespace-nowrap group-hover:text-indigo-600 transition-colors">{t.inputLang}</span>
                    <div className="w-full relative px-2 py-1">
                        <select
                            value={langInput.code}
                            onChange={(e) => {
                                onLanguageManualSelect();
                                const l = SUPPORTED_LANGUAGES.find(l => l.code === e.target.value);
                                if (l) setLangInput(l);
                            }}
                            className="opacity-0 absolute inset-0 w-full h-full z-10 cursor-pointer"
                            title={uiLangCode === 'ko' ? '입력 언어 선택 (내가 말하는 언어)' : 'Select Input Language (The language you speak)'}
                        >
                            {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
                        </select>
                        <div className="text-sm font-bold text-gray-900 truncate max-w-[120px] sm:max-w-xs text-center group-hover:scale-105 transition-transform">
                            {langInput.flag} {langInput.name}
                        </div>
                    </div>
                </div>

                <div className="relative group/swap">
                    <button
                        onClick={onSwapLanguages}
                        className="p-1.5 bg-white rounded-full border border-gray-200 text-gray-400 hover:text-indigo-600 hover:border-indigo-200 hover:shadow-md transition-all active:scale-90 z-20 relative shadow-sm"
                        title={uiLangCode === 'ko' ? '입력/출력 언어 서로 바꾸기' : 'Swap Input/Output Languages'}
                    >
                        <svg className="w-4 h-4 transition-transform group-hover/swap:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                        </svg>
                    </button>
                    {/* Visual drag indicator hint */}
                    <div className="absolute -inset-1 bg-indigo-50/0 group-hover/swap:bg-indigo-50/50 rounded-lg -z-10 transition-all pointer-events-none"></div>
                </div>

                <div
                    className="flex-1 flex flex-col items-center min-w-0 hover:bg-white hover:shadow-sm rounded-xl transition-all cursor-pointer group py-1"
                >
                    <span className="text-[10px] text-gray-800 font-bold mb-1 whitespace-nowrap group-hover:text-indigo-600 transition-colors">{t.outputLang}</span>
                    <div className="w-full relative px-2 py-1">
                        <select
                            value={langOutput.code}
                            onChange={(e) => {
                                onLanguageManualSelect();
                                const l = SUPPORTED_LANGUAGES.find(l => l.code === e.target.value);
                                if (l) setLangOutput(l);
                            }}
                            className="opacity-0 absolute inset-0 w-full h-full z-10 cursor-pointer"
                            title={uiLangCode === 'ko' ? '번역 언어 선택 (듣고 싶은 언어)' : 'Select Output Language (The language you want to hear)'}
                        >
                            {SUPPORTED_LANGUAGES.filter(l => l.code !== 'auto').map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
                        </select>
                        <div className="text-sm font-bold text-gray-900 truncate max-w-[120px] sm:max-w-xs text-center group-hover:scale-105 transition-transform">
                            {langOutput.flag} {langOutput.name}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default LanguageSelector;
