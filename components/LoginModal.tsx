import React from 'react';
import { GoogleLogo } from './Icons';

interface LoginModalProps {
    isOpen: boolean;
    onClose: () => void;
    t: any;
    handleLoginSelection: (type: 'google' | 'guest') => void;
    emailAuthEmail: string;
    setEmailAuthEmail: (v: string) => void;
    emailAuthPassword: string;
    setEmailAuthPassword: (v: string) => void;
    emailAuthError: string;
    isEmailAuthBusy: boolean;
    handleEmailLogin: () => void;
    handleEmailSignUp: () => void;
}

const LoginModal: React.FC<LoginModalProps> = ({
    isOpen,
    onClose,
    t,
    handleLoginSelection,
    emailAuthEmail,
    setEmailAuthEmail,
    emailAuthPassword,
    setEmailAuthPassword,
    emailAuthError,
    isEmailAuthBusy,
    handleEmailLogin,
    handleEmailSignUp,
}) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden flex flex-col p-6" role="dialog" aria-label="로그인">
                <div className="text-center mb-6">
                    <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-3 text-indigo-600">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                        </svg>
                    </div>
                    <h2 className="text-xl font-bold text-gray-800">{t.loginModalTitle}</h2>
                </div>

                <div className="space-y-3">
                    {/* Google Login Button */}
                    <button
                        onClick={() => handleLoginSelection('google')}
                        className="w-full flex items-center p-4 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-all group text-left relative overflow-hidden active:scale-[0.98] hover:shadow-lg"
                    >
                        <div className="bg-white p-2 rounded-full shadow-sm mr-4 z-10 transition-transform group-hover:scale-110">
                            <GoogleLogo />
                        </div>
                        <div className="z-10">
                            <h3 className="font-bold text-gray-800 group-hover:text-blue-700 transition-colors">{t.loginGoogle}</h3>
                            <p className="text-xs text-gray-500 mt-0.5 group-hover:text-blue-600 transition-colors">{t.loginGoogleDesc}</p>
                        </div>
                        <div className="absolute inset-0 border-2 border-transparent group-hover:border-blue-100 rounded-xl pointer-events-none transition-all"></div>
                    </button>

                    <div className="border border-gray-100 rounded-xl p-4 bg-gray-50">
                        <div className="text-xs font-bold text-gray-600 mb-2">이메일/비밀번호</div>
                        <div className="space-y-2">
                            <input
                                id="login-email"
                                name="email"
                                type="email"
                                value={emailAuthEmail}
                                onChange={(e) => setEmailAuthEmail(e.target.value)}
                                placeholder="이메일"
                                autoComplete="email"
                                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white transition-all shadow-sm"
                            />
                            <input
                                id="login-password"
                                name="password"
                                type="password"
                                value={emailAuthPassword}
                                onChange={(e) => setEmailAuthPassword(e.target.value)}
                                placeholder="비밀번호"
                                autoComplete="current-password"
                                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white transition-all shadow-sm"
                            />

                            {emailAuthError ? (
                                <div className="text-xs text-red-600 whitespace-pre-wrap break-words">{emailAuthError}</div>
                            ) : null}

                            <div className="flex items-center gap-2 pt-1">
                                <button
                                    disabled={isEmailAuthBusy}
                                    onClick={handleEmailLogin}
                                    className="flex-1 px-3 py-2 rounded-xl text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md transition-all active:scale-95 disabled:opacity-40"
                                >
                                    로그인
                                </button>
                                <button
                                    disabled={isEmailAuthBusy}
                                    onClick={handleEmailSignUp}
                                    className="flex-1 px-3 py-2 rounded-xl text-xs font-bold bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-300 hover:shadow-sm transition-all active:scale-95 disabled:opacity-40"
                                >
                                    가입
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Guest Login Button */}
                    <button
                        onClick={() => handleLoginSelection('guest')}
                        className="w-full flex items-center p-4 rounded-xl border border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition-all group text-left active:scale-[0.98] hover:shadow-lg"
                    >
                        <div className="bg-gray-200 p-2 rounded-full mr-4 text-gray-500 group-hover:bg-indigo-100 group-hover:text-indigo-600 transition-all scale-100 group-hover:scale-110">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                            </svg>
                        </div>
                        <div>
                            <h3 className="font-bold text-gray-700 group-hover:text-gray-900 transition-colors">{t.loginGuest}</h3>
                            <p className="text-xs text-gray-400 mt-0.5 group-hover:text-gray-500 transition-colors">{t.loginGuestDesc}</p>
                        </div>
                    </button>
                </div>

                <button
                    onClick={onClose}
                    className="mt-6 text-sm text-gray-400 hover:text-indigo-600 transition-colors underline font-bold"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
};

export default LoginModal;
