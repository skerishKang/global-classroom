import React from 'react';

interface HistoryModalProps {
    isOpen: boolean;
    onClose: () => void;
    t: any;
    accessToken: string | null;
    driveSessions: any[];
    isLoadingDriveSessions: boolean;
    selectedDriveSessionId: string;
    setSelectedDriveSessionId: (id: string) => void;
    isRestoringDriveSession: boolean;
    driveRestoreMessage: string;
    handleRestoreFromDrive: (includeAudio: boolean) => void;
    sessions: any[];
    selectedLocalSessionId: string;
    setSelectedLocalSessionId: (id: string) => void;
    handleLoadSessionFromLocal: () => void;
    handleClearLocalSessions: () => void;
    handleDownloadSessionAudio: (session: any) => void;
}

const HistoryModal: React.FC<HistoryModalProps> = ({
    isOpen,
    onClose,
    t,
    accessToken,
    driveSessions,
    isLoadingDriveSessions,
    selectedDriveSessionId,
    setSelectedDriveSessionId,
    isRestoringDriveSession,
    driveRestoreMessage,
    handleRestoreFromDrive,
    sessions,
    selectedLocalSessionId,
    setSelectedLocalSessionId,
    handleLoadSessionFromLocal,
    handleClearLocalSessions,
    handleDownloadSessionAudio,
}) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
                <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                    <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        이전 히스토리
                    </h2>

                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-indigo-600 p-1 bg-white rounded-full shadow-sm hover:shadow-md transition-all active:scale-95"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                <div className="px-6 py-3 border-b border-gray-100 bg-white flex items-center justify-between gap-2">
                    <div className="text-xs text-gray-500">
                        Drive 세션: <span className="font-bold text-gray-800">{driveSessions.length}</span>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => handleRestoreFromDrive(false)}
                            disabled={!selectedDriveSessionId || isRestoringDriveSession}
                            className="px-3 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 shadow-sm whitespace-nowrap bg-indigo-600 border-indigo-700 text-white hover:bg-indigo-700 hover:shadow-md disabled:opacity-40"
                        >
                            대화만 복원
                        </button>

                        <button
                            onClick={() => handleRestoreFromDrive(true)}
                            disabled={!selectedDriveSessionId || isRestoringDriveSession}
                            className="px-3 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 shadow-sm whitespace-nowrap bg-white border-gray-200 text-gray-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 hover:shadow-md disabled:opacity-40"
                        >
                            음성도 복원
                        </button>
                    </div>
                </div>

                {driveRestoreMessage && (
                    <div className="px-6 py-2 border-b border-gray-100 bg-white text-xs text-gray-500">
                        {isRestoringDriveSession ? (
                            <span className="font-bold text-indigo-600">{driveRestoreMessage}</span>
                        ) : (
                            <span>{driveRestoreMessage}</span>
                        )}
                    </div>
                )}

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {accessToken ? (
                        isLoadingDriveSessions ? (
                            <div className="text-center py-8 text-gray-400 text-sm">Drive 세션을 불러오는 중...</div>
                        ) : driveSessions.length === 0 ? (
                            <div className="text-center py-8 text-gray-400 text-sm">Drive에 저장된 세션이 없습니다.</div>
                        ) : (
                            <div className="space-y-2">
                                {driveSessions.map((s: any) => (
                                    <button
                                        key={s.folderId}
                                        onClick={() => setSelectedDriveSessionId(s.folderId)}
                                        className={`w-full text-left px-4 py-3 rounded-xl border transition-all active:scale-[0.98] ${selectedDriveSessionId === s.folderId
                                            ? 'bg-indigo-50 border-indigo-300 shadow-sm'
                                            : 'bg-white border-gray-100 hover:bg-gray-50 hover:border-gray-200 hover:shadow-sm'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="text-sm font-bold text-gray-800 truncate">{s.folderName}</div>
                                                <div className="text-xs text-gray-400 truncate">{s.createdTime || ''}</div>
                                            </div>
                                            <a
                                                href={s.folderUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                                className="text-xs font-bold text-indigo-600 hover:text-indigo-800 hover:underline px-2 py-1 rounded-lg hover:bg-white transition-all shadow-none hover:shadow-sm border border-transparent hover:border-indigo-100"
                                            >
                                                Drive 열기
                                            </a>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )
                    ) : (
                        <div className="text-center py-8 text-gray-400 text-sm">Drive 세션을 보려면 Google 로그인이 필요합니다.</div>
                    )}

                    <div className="pt-4 mt-4 border-t border-gray-100">
                        <div className="flex items-center justify-between gap-2 mb-2">
                            <div>
                                <div className="text-xs text-gray-500">이 브라우저에 자동 저장된 대화: <span className="font-bold text-gray-800">{sessions.length}</span></div>
                                <div className="mt-0.5 text-[10px] text-gray-400">로그인 없이 저장됩니다. 브라우저 사이트 데이터를 삭제하면 함께 삭제됩니다.</div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleLoadSessionFromLocal}
                                    disabled={!selectedLocalSessionId || sessions.length === 0}
                                    className="px-3 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 shadow-sm whitespace-nowrap bg-indigo-600 border-indigo-700 text-white hover:bg-indigo-700 hover:shadow-md disabled:opacity-40"
                                >
                                    불러오기
                                </button>

                                <button
                                    onClick={handleClearLocalSessions}
                                    disabled={sessions.length === 0}
                                    className="px-3 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 shadow-sm whitespace-nowrap bg-white border-gray-200 text-gray-500 hover:bg-red-50 hover:border-red-200 hover:text-red-600 hover:shadow-md disabled:opacity-40"
                                >
                                    삭제
                                </button>
                            </div>
                        </div>

                        {sessions.length === 0 ? (
                            <div className="text-center py-6 text-gray-400 text-sm">저장된 로컬 세션이 없습니다.</div>
                        ) : (
                            <div className="space-y-2">
                                {sessions
                                    .slice()
                                    .sort((a, b) => Number(b.updatedAt || b.createdAt) - Number(a.updatedAt || a.createdAt))
                                    .slice(0, 20)
                                    .map((s) => (
                                        <button
                                            key={s.id}
                                            onClick={() => setSelectedLocalSessionId(s.id)}
                                            className={`w-full text-left px-4 py-3 rounded-xl border transition-all active:scale-[0.98] ${selectedLocalSessionId === s.id
                                                ? 'bg-indigo-50 border-indigo-300 shadow-sm'
                                                : 'bg-white border-gray-100 hover:bg-gray-50 hover:border-gray-200 hover:shadow-sm'
                                                }`}
                                        >
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="text-sm font-bold text-gray-800 truncate">{s.title || '대화'}</div>
                                                    <div className="text-xs text-gray-400 truncate">
                                                        {new Date(Number(s.updatedAt || s.createdAt)).toLocaleString()} · {Array.isArray(s.items) ? s.items.length : 0}개
                                                    </div>
                                                </div>
                                                <div className="text-xs font-bold text-gray-400">{selectedLocalSessionId === s.id ? '선택됨' : ''}</div>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleDownloadSessionAudio(s);
                                                    }}
                                                    className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400 ml-2"
                                                    title={t.downloadCombinedAudio}
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0L8 8m4-4v12" /></svg>
                                                </button>
                                            </div>
                                        </button>
                                    ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default HistoryModal;
