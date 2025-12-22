import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import {
  logOut,
  getUserProfile,
  saveUserProfile
} from './utils/firebase';
import { clearSessions } from './utils/localStorage';
import { getCachedAudioBase64, setCachedAudioBase64, clearCachedAudio } from './utils/idbAudioCache';
import {
  backupToDrive,
  exportToDocs,
  listDriveSessions,
  restoreDriveSession,
  listCourses,
  createCourseWork
} from './utils/googleWorkspace';
import { downloadTranscriptLocally } from './utils/fileExport';
import { Language, ConnectionStatus, VoiceOption, ConversationItem, ConversationSession, VisionResult } from './types';
import {
  SUPPORTED_LANGUAGES,
  MODEL_LIVE,
  MODEL_TRANSLATE,
  MODEL_VISION,
  MODEL_TTS,
  TRANSLATIONS,
  VOICE_OPTIONS,
  GOOGLE_CLIENT_ID,
  GOOGLE_SCOPES,
  SETTINGS_KEY,
  UI_LANG_KEY,
  HISTORY_RENDER_STEP
} from './constants';
import { decodeAudioData, base64ToUint8Array, arrayBufferToBase64 } from './utils/audioUtils';
import { retry } from './utils/retry';
import Visualizer from './components/Visualizer';
import CameraView from './components/CameraView';
import AdminPanelModal from './components/AdminPanelModal';
import NotebookLMGuide from './components/NotebookLMGuide';
import LoginModal from './components/LoginModal';
import HistoryModal from './components/HistoryModal';
import SettingsModal from './components/SettingsModal';
import ClassroomModal from './components/ClassroomModal';
import VisionNotificationModal from './components/VisionNotificationModal';
import SummaryModal from './components/SummaryModal';
import AppHeader from './components/AppHeader';
import LanguageSelector from './components/LanguageSelector';
import ConversationList from './components/ConversationList';
import BottomControls from './components/BottomControls';
import ExportMenu from './components/ExportMenu';
import VisionToastSystem from './components/VisionToastSystem';
import ToastSystem from './components/ToastSystem';
import LiveSharingModal from './components/LiveSharingModal';

import { useAuth } from './hooks/useAuth';
import { useConversationHistory } from './hooks/useConversationHistory';
import { useGeminiLive } from './hooks/useGeminiLive';
import { useExport } from './hooks/useExport';
import { useVision } from './hooks/useVision';
import { useAudioPlayer } from './hooks/useAudioPlayer';
import { useStorage } from './hooks/useStorage';
import { useTranslationService } from './hooks/useTranslationService';
import { useToast } from './hooks/useToast';
import { useLiveSharing } from './hooks/useLiveSharing';
import { AppSettings, VisionNotification } from './types';

import {
  MicIcon,
  MicOffIcon,
  CameraIcon,
  ArrowRightIcon,
  SpeakerIcon,
  PlayAllIcon,
  GlobeIcon,
  ExportIcon,
  BellIcon,
  DocsIcon,
  DriveIcon,
  ClassroomIcon,
  NotebookLMIcon,
  GoogleLogo,
  CopyIcon,
  SparklesIcon
} from './components/Icons';

export default function App() {
  // --- UI Translation State ---
  const [langInput, setLangInput] = useState<Language>(SUPPORTED_LANGUAGES[0]); // Default: Auto
  const [langOutput, setLangOutput] = useState<Language>(SUPPORTED_LANGUAGES.find(l => l.code === 'ko') || SUPPORTED_LANGUAGES[1]); // Default: Korean
  const [isAutoPlay, setIsAutoPlay] = useState(false);
  const [isScrollLocked, setIsScrollLocked] = useState(true);
  const [selectedVoice, setSelectedVoice] = useState<VoiceOption>(VOICE_OPTIONS[0]);

  // --- UI Display State ---
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false);

  // --- Custom Hooks ---
  const {
    user,
    accessToken,
    isAdmin,
    isAuthReady,
    isLoginModalOpen,
    setIsLoginModalOpen,
    isProfileMenuOpen,
    setIsProfileMenuOpen,
    emailAuthEmail,
    setEmailAuthEmail,
    emailAuthPassword,
    setEmailAuthPassword,
    emailAuthError,
    setEmailAuthError,
    isEmailAuthBusy,
    handleEmailLogin,
    handleEmailSignUp,
    handleLoginSelection,
    handleLogout,
  } = useAuth();

  const { toasts, enqueueToast, dismissToast } = useToast();

  const {
    history,
    setHistory,
    historyRenderLimit,
    setHistoryRenderLimit,
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    isSessionsReady,
    isOutputOnly,
    setIsOutputOnly,
    handleMergeWithAbove,
    handleMergeWithBelow,
    handleSplitItem,
    handleSaveEdit,
    handleClearSessions,
    loadSession,
    deleteSession
  } = useConversationHistory();

  // --- UI Settings ---
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { driveBackupMode: 'manual', audioCacheEnabled: true, recordOriginalEnabled: true, userApiKey: '' };
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        driveBackupMode: parsed.driveBackupMode === 'auto' ? 'auto' : 'manual',
        audioCacheEnabled: typeof parsed.audioCacheEnabled === 'boolean' ? parsed.audioCacheEnabled : true,
        recordOriginalEnabled: typeof parsed.recordOriginalEnabled === 'boolean' ? parsed.recordOriginalEnabled : true,
        userApiKey: typeof parsed.userApiKey === 'string' ? parsed.userApiKey : '',
      };
    } catch {
      return { driveBackupMode: 'manual', audioCacheEnabled: true, recordOriginalEnabled: true, userApiKey: '' };
    }
  });

  const [uiLangCode, setUiLangCode] = useState<string>(() => {
    const saved = localStorage.getItem(UI_LANG_KEY);
    return saved || 'ko';
  });

  // --- UI Language Sync with Output Language ---
  useEffect(() => {
    if (langOutput.code !== 'auto' && langOutput.code !== uiLangCode) {
      setUiLangCode(langOutput.code);
      localStorage.setItem(UI_LANG_KEY, langOutput.code);
    }
  }, [langOutput.code, uiLangCode]);

  // --- Translation Helpers ---
  const t = TRANSLATIONS[uiLangCode] || TRANSLATIONS['ko'];

  // --- Custom Service: Translation & API ---
  const {
    postApi,
    translateText
  } = useTranslationService({
    settings,
    setHistory,
    isAutoPlay,
    playTTS: (text, id) => playTTS(text, id),
    MODEL_TRANSLATE
  });

  // --- Live Sharing ---
  const onLiveMessageReceived = useCallback((text: string, langCode: string) => {
    const newItem: ConversationItem = {
      id: crypto.randomUUID(),
      original: text,
      translated: '',
      isTranslating: true,
      timestamp: Date.now(),
    };
    setHistory(prev => [...prev, newItem]);
    // Determine source language for translation
    const sourceLang = SUPPORTED_LANGUAGES.find(l => l.code === langCode) || SUPPORTED_LANGUAGES[1]; // fallback to Korean
    translateText(text, newItem.id, sourceLang, langOutput);
  }, [langOutput, setHistory, translateText]);

  const {
    roomId,
    isHost,
    roomStatus,
    createRoom,
    joinRoom,
    broadcastMessage,
    leaveRoom
  } = useLiveSharing({ user, onMessageReceived: onLiveMessageReceived });

  // Gemini Props Helpers
  const onTranscriptReceived = useCallback((text: string, isFinal: boolean) => {
    if (isFinal) {
      const newItem: ConversationItem = {
        id: crypto.randomUUID(),
        original: text,
        translated: '',
        isTranslating: true,
        timestamp: Date.now(),
      };
      setHistory(prev => [...prev, newItem]);
      // Translate automatically
      translateText(text, newItem.id, langInput, langOutput);

      // Broadcast if hosting
      if (roomStatus === 'hosting') {
        broadcastMessage(text, langInput.code);
      }
    } else {
      setCurrentTurnText(text);
    }
  }, [langInput, langOutput, setHistory]);

  const onAudioReceived = useCallback((base64: string) => {
    // Gemini Live handles internal playback now
  }, []);

  const {
    status,
    isMicOn,
    errorMessage,
    analyser,
    isRecordingOriginal,
    connectToGemini,
    toggleMic,
    cleanupAudio,
    playPCM,
    stopPCM,
    setErrorMessage
  } = useGeminiLive({
    langInput,
    onTranscriptReceived,
    onAudioReceived,
    postApi,
    settings
  });

  // --- Custom Service: Audio & TTS ---
  const {
    playTTS,
    stopTTS,
    playAll,
    handleDownloadSessionAudio
  } = useAudioPlayer({
    history,
    setHistory,
    selectedVoice,
    settings,
    postApi,
    playPCM,
    stopPCM,
    MODEL_TTS,
    t
  });

  const {
    isExportMenuOpen,
    setIsExportMenuOpen,
    isExporting,
    isClassroomModalOpen,
    setIsClassroomModalOpen,
    isNotebookLMGuideOpen,
    setIsNotebookLMGuideOpen,
    courses,
    isLoadingCourses,
    exportMenuRef,
    handleExport,
    handleSubmitCourseWork
  } = useExport({
    accessToken,
    history,
    selectedVoice,
    t,
    setIsLoginModalOpen
  });

  // --- Custom Service: Vision & Storage ---
  const {
    visionNotifications,
    setVisionNotifications,
    activeVisionNotificationId,
    setActiveVisionNotificationId,
    visionToastIds,
    handleVisionCaptured,
    openVisionNotification,
    dismissVisionToast
  } = useVision({ postApi, langInput, langOutput, MODEL_VISION });

  const {
    driveSessions,
    isLoadingDriveSessions,
    selectedDriveSessionId,
    setSelectedDriveSessionId,
    isRestoringDriveSession,
    driveRestoreMessage,
    setDriveRestoreMessage,
    isHistoryModalOpen,
    setIsHistoryModalOpen,
    selectedLocalSessionId,
    setSelectedLocalSessionId,
    handleOpenHistory,
    handleRestoreFromDrive
  } = useStorage({ accessToken, setHistory, setCurrentSessionId, enqueueToast });

  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isNotificationMenuOpen, setIsNotificationMenuOpen] = useState(false);
  const [isSummaryModalOpen, setIsSummaryModalOpen] = useState(false);
  const [isLiveModalOpen, setIsLiveModalOpen] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryText, setSummaryText] = useState('');

  const [currentTurnText, setCurrentTurnText] = useState('');
  const historyRef = useRef<HTMLDivElement>(null);
  const pendingHistoryExpandRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const langInputRef = useRef(langInput);
  const langOutputRef = useRef(langOutput);
  const isLangAutoRef = useRef(false);

  // --- Editing State ---
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editOriginalText, setEditOriginalText] = useState('');
  const [editTranslatedText, setEditTranslatedText] = useState('');

  const startEditing = useCallback((item: ConversationItem) => {
    setEditingItemId(item.id);
    setEditOriginalText(item.original);
    setEditTranslatedText(item.translated);
  }, []);

  const handleSaveEditAction = useCallback((id: string) => {
    handleSaveEdit(id, editOriginalText, editTranslatedText);
    setEditingItemId(null);
  }, [editOriginalText, editTranslatedText, handleSaveEdit]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
    }).catch(err => {
      console.error('Failed to copy text: ', err);
    });
  };

  const handleSwapLanguages = useCallback(() => {
    const prevInput = langInputRef.current;
    const prevOutput = langOutputRef.current;

    // If input is 'auto', we swap output to input, but what becomes output?
    // User probably wants to reverse the current flow.
    // If input was 'auto', and output was 'ko', swapping means input='ko' and output='en' (fallback)
    // or just swap them directly if input isn't 'auto'.
    if (prevInput.code === 'auto') {
      setLangInput(prevOutput);
      const fallbackTo = prevOutput.code === 'ko' ? SUPPORTED_LANGUAGES.find(l => l.code === 'en')! : SUPPORTED_LANGUAGES.find(l => l.code === 'ko')!;
      setLangOutput(fallbackTo);
    } else {
      setLangInput(prevOutput);
      setLangOutput(prevInput);
    }
  }, []);

  // const exportMenuRef = useRef<HTMLDivElement>(null); // Moved to useExport
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const notificationMenuRef = useRef<HTMLDivElement>(null);

  const unreadVisionCount = visionNotifications.filter((n) => !n.isRead).length;

  const handleLoadMoreHistory = () => {
    const nextLimit = Math.min(historyRenderLimit + HISTORY_RENDER_STEP, history.length);
    if (nextLimit === historyRenderLimit) return;
    if (historyRef.current) {
      pendingHistoryExpandRef.current = {
        prevScrollHeight: historyRef.current.scrollHeight,
        prevScrollTop: historyRef.current.scrollTop,
      };
    }
    setHistoryRenderLimit(nextLimit);
  };

  const handleSummarize = async () => {
    if (history.length < 2) {
      alert("대화 내용이 너무 적어 요약할 수 없습니다.");
      return;
    }
    setIsSummaryModalOpen(true);
    setIsSummarizing(true);
    try {
      const historyText = history.map(h => `${h.original}\n${h.translated}`).join('\n\n');
      const data = await postApi<{ summary: string }>('summarize', {
        history: historyText,
        lang: uiLangCode
      });
      setSummaryText(data.summary);
    } catch (e) {
      console.error(e);
      setSummaryText("요약에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleOpenSettingsAction = () => {
    setIsProfileMenuOpen(false);
    setIsSettingsModalOpen(true);
  };

  const handleClearLocalSessionsAction = () => {
    clearCachedAudio();
    handleClearSessions();
  };

  const handleLoadSessionFromLocal = () => {
    if (!selectedLocalSessionId) return;
    const target = sessions.find(s => s.id === selectedLocalSessionId);
    if (target) {
      loadSession(target);
      setIsHistoryModalOpen(false);
    }
  };

  useEffect(() => {
    langInputRef.current = langInput;
  }, [langInput]);

  useEffect(() => {
    langOutputRef.current = langOutput;
  }, [langOutput]);

  // UI Effects
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setIsExportMenuOpen(false);
      }
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
        setIsProfileMenuOpen(false);
      }
      if (notificationMenuRef.current && !notificationMenuRef.current.contains(event.target as Node)) {
        setIsNotificationMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [setIsProfileMenuOpen, setIsExportMenuOpen, setIsNotificationMenuOpen, exportMenuRef, profileMenuRef, notificationMenuRef]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      // Also save to Cloud if logged in
      if (user?.uid && !user.isAnonymous) {
        saveUserProfile(user.uid, { userApiKey: settings.userApiKey });
      }
    } catch { }
  }, [settings, user]);

  // Load Cloud Settings on Login
  useEffect(() => {
    if (user?.uid && !user.isAnonymous) {
      getUserProfile(user.uid).then(profile => {
        if (profile?.userApiKey && profile.userApiKey !== settings.userApiKey) {
          setSettings(prev => ({ ...prev, userApiKey: profile.userApiKey }));
        }
      });
    }
  }, [user]);

  useEffect(() => {
    if (!isAdmin) {
      setIsAdminPanelOpen(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    setHistoryRenderLimit(200);
  }, [currentSessionId, setHistoryRenderLimit]);

  useEffect(() => {
    if (!isScrollLocked && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history, currentTurnText, isScrollLocked]);

  useLayoutEffect(() => {
    if (!pendingHistoryExpandRef.current || !historyRef.current) return;
    const { prevScrollHeight, prevScrollTop } = pendingHistoryExpandRef.current;
    pendingHistoryExpandRef.current = null;
    const delta = historyRef.current.scrollHeight - prevScrollHeight;
    historyRef.current.scrollTop = prevScrollTop + delta;
  }, [historyRenderLimit]);

  return (
    <div className="flex flex-col h-screen h-[100dvh] bg-slate-50 font-sans text-gray-900 overflow-hidden select-none">
      <AppHeader
        user={user}
        accessToken={accessToken}
        isAdmin={isAdmin}
        handleLogout={handleLogout}
        isProfileMenuOpen={isProfileMenuOpen}
        setIsProfileMenuOpen={setIsProfileMenuOpen}
        setIsHistoryModalOpen={setIsHistoryModalOpen}
        setIsSettingsModalOpen={setIsSettingsModalOpen}
        setIsAdminPanelOpen={setIsAdminPanelOpen}
        setIsLoginModalOpen={setIsLoginModalOpen}
        setIsLiveModalOpen={setIsLiveModalOpen}
        roomStatus={roomStatus}
        selectedVoice={selectedVoice}
        setSelectedVoice={setSelectedVoice}
        isOutputOnly={isOutputOnly}
        setIsOutputOnly={setIsOutputOnly}
        uiLangCode={uiLangCode}
        setUiLangCode={setUiLangCode}
        setIsExportMenuOpen={setIsExportMenuOpen}
        handleSummarize={handleSummarize}
        t={t}
      />

      <ExportMenu
        isOpen={isExportMenuOpen}
        menuRef={exportMenuRef}
        onExport={handleExport}
        t={t}
      />

      <VisionToastSystem
        toastIds={visionToastIds}
        notifications={visionNotifications}
        onOpen={openVisionNotification}
        onDismiss={dismissVisionToast}
        t={t}
      />

      <LanguageSelector
        langInput={langInput}
        setLangInput={setLangInput}
        langOutput={langOutput}
        setLangOutput={setLangOutput}
        t={t}
        onLanguageManualSelect={() => { isLangAutoRef.current = false; }}
        onSwapLanguages={handleSwapLanguages}
      />

      <ConversationList
        analyser={analyser}
        isMicOn={isMicOn}
        history={history}
        currentTurnText={currentTurnText}
        isOutputOnly={isOutputOnly}
        historyRef={historyRef}
        t={t}
        status={status}
        errorMessage={errorMessage}
        connectToGemini={connectToGemini}
        toggleMic={toggleMic}
        editingItemId={editingItemId}
        setEditingItemId={setEditingItemId}
        editOriginalText={editOriginalText}
        setEditOriginalText={setEditOriginalText}
        editTranslatedText={editTranslatedText}
        setEditTranslatedText={setEditTranslatedText}
        startEditing={startEditing}
        handleSaveEdit={handleSaveEditAction}
        handleMergeWithAbove={handleMergeWithAbove}
        handleMergeWithBelow={handleMergeWithBelow}
        handleSplitItem={handleSplitItem}
        copyToClipboard={copyToClipboard}
        playTTS={playTTS}
        stopTTS={stopTTS}
        uiLangCode={uiLangCode}
      />

      <BottomControls
        isAutoPlay={isAutoPlay}
        setIsAutoPlay={setIsAutoPlay}
        isScrollLocked={isScrollLocked}
        setIsScrollLocked={setIsScrollLocked}
        status={status}
        toggleMic={toggleMic}
        playAll={playAll}
        stopTTS={stopTTS}
        setIsCameraOpen={setIsCameraOpen}
        t={t}
      />

      <CameraView
        isOpen={isCameraOpen}
        onClose={() => setIsCameraOpen(false)}
        onCaptured={handleVisionCaptured}
        t={t}
      />

      <VisionNotificationModal
        notificationId={activeVisionNotificationId}
        notifications={visionNotifications}
        onClose={() => setActiveVisionNotificationId(null)}
        t={t}
      />

      {/* --- LOGIN MODAL --- */}
      <SummaryModal
        isOpen={isSummaryModalOpen}
        onClose={() => setIsSummaryModalOpen(false)}
        summaryText={summaryText}
        isSummarizing={isSummarizing}
        t={t}
      />

      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        t={t}
        handleLoginSelection={handleLoginSelection}
        emailAuthEmail={emailAuthEmail}
        setEmailAuthEmail={setEmailAuthEmail}
        emailAuthPassword={emailAuthPassword}
        setEmailAuthPassword={setEmailAuthPassword}
        emailAuthError={emailAuthError}
        isEmailAuthBusy={isEmailAuthBusy}
        handleEmailLogin={handleEmailLogin}
        handleEmailSignUp={handleEmailSignUp}
      />

      <HistoryModal
        isOpen={isHistoryModalOpen}
        onClose={() => setIsHistoryModalOpen(false)}
        t={t}
        accessToken={accessToken}
        driveSessions={driveSessions}
        isLoadingDriveSessions={isLoadingDriveSessions}
        selectedDriveSessionId={selectedDriveSessionId}
        setSelectedDriveSessionId={setSelectedDriveSessionId}
        isRestoringDriveSession={isRestoringDriveSession}
        driveRestoreMessage={driveRestoreMessage}
        handleRestoreFromDrive={handleRestoreFromDrive}
        sessions={sessions}
        selectedLocalSessionId={selectedLocalSessionId}
        setSelectedLocalSessionId={setSelectedLocalSessionId}
        handleLoadSessionFromLocal={handleLoadSessionFromLocal}
        handleClearLocalSessions={handleClearLocalSessionsAction}
        handleDownloadSessionAudio={(s) => handleDownloadSessionAudio(s.items, s.title)}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={settings}
        setSettings={setSettings}
        t={t}
      />

      <ClassroomModal
        isOpen={isClassroomModalOpen}
        onClose={() => setIsClassroomModalOpen(false)}
        t={t}
        courses={courses}
        isLoadingCourses={isLoadingCourses}
        isExporting={isExporting}
        onSubmit={handleSubmitCourseWork}
      />

      <AdminPanelModal
        isOpen={isAdminPanelOpen && isAdmin}
        onClose={() => setIsAdminPanelOpen(false)}
        user={user}
        accessToken={accessToken}
        sessionsCount={sessions.length}
        historyCount={history.length}
      />

      <NotebookLMGuide
        isOpen={isNotebookLMGuideOpen}
        onClose={() => setIsNotebookLMGuideOpen(false)}
      />

      <LiveSharingModal
        isOpen={isLiveModalOpen}
        onClose={() => setIsLiveModalOpen(false)}
        roomId={roomId}
        roomStatus={roomStatus}
        onJoin={joinRoom}
        onCreate={createRoom}
        onLeave={leaveRoom}
      />

      <ToastSystem toasts={toasts} onDismiss={dismissToast} />

    </div >
  );
}

