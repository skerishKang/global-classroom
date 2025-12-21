import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import {
  logOut
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
import AppHeader from './components/AppHeader';
import LanguageSelector from './components/LanguageSelector';
import ConversationList from './components/ConversationList';
import BottomControls from './components/BottomControls';

import { useAuth } from './hooks/useAuth';
import { useConversationHistory } from './hooks/useConversationHistory';
import { useGeminiLive } from './hooks/useGeminiLive';
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
  CopyIcon
} from './components/Icons';
import { mergeAudioBlobs } from './utils/audioMixer';

export default function App() {
  // --- UI Translation State ---
  const [langInput, setLangInput] = useState<Language>(SUPPORTED_LANGUAGES[0]); // Default: Korean
  const [langOutput, setLangOutput] = useState<Language>(SUPPORTED_LANGUAGES[1]); // Default: English
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
    handleNewConversation,
    handleMergeWithAbove,
    handleMergeWithBelow,
    handleSplitItem,
    loadSession,
    deleteSession
  } = useConversationHistory();

  // --- UI Settings ---
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { driveBackupMode: 'manual', audioCacheEnabled: true, recordOriginalEnabled: true };
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        driveBackupMode: parsed.driveBackupMode === 'auto' ? 'auto' : 'manual',
        audioCacheEnabled: typeof parsed.audioCacheEnabled === 'boolean' ? parsed.audioCacheEnabled : true,
        recordOriginalEnabled: typeof parsed.recordOriginalEnabled === 'boolean' ? parsed.recordOriginalEnabled : true,
      };
    } catch {
      return { driveBackupMode: 'manual', audioCacheEnabled: true, recordOriginalEnabled: true };
    }
  });

  const [uiLangCode, setUiLangCode] = useState<string>(() => {
    const saved = localStorage.getItem(UI_LANG_KEY);
    return saved || 'ko';
  });

  // --- Translation Helpers ---
  const t = TRANSLATIONS[uiLangCode] || TRANSLATIONS['ko'];

  const postApi = useCallback(async <T,>(endpoint: string, body: any): Promise<T> => {
    const resp = await fetch(`/api/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`API Error: ${resp.statusText}`);
    return resp.json();
  }, []);

  const translateText = async (text: string, id: string, fromLang: Language, toLang: Language) => {
    try {
      const data = await postApi<{ translated: string }>('translate', {
        text,
        from: fromLang.name,
        to: toLang.name,
        model: MODEL_TRANSLATE,
      });
      const translated = data.translated?.trim() || "";
      setHistory(prev => prev.map(item =>
        item.id === id ? { ...item, translated: translated, isTranslating: false } : item
      ));
      if (isAutoPlay && translated) {
        playTTS(translated, id);
      }
    } catch (e) {
      console.error("Translation failed", e);
      setHistory(prev => prev.map(item =>
        item.id === id ? { ...item, translated: "Error", isTranslating: false } : item
      ));
    }
  };

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
    setErrorMessage
  } = useGeminiLive({
    langInput,
    onTranscriptReceived,
    onAudioReceived,
    postApi,
    settings
  });

  // --- Remaining State ---
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isClassroomModalOpen, setIsClassroomModalOpen] = useState(false);
  const [isNotebookLMGuideOpen, setIsNotebookLMGuideOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isNotificationMenuOpen, setIsNotificationMenuOpen] = useState(false);
  const [visionNotifications, setVisionNotifications] = useState<VisionNotification[]>([]);
  const [activeVisionNotificationId, setActiveVisionNotificationId] = useState<string | null>(null);

  const [currentTurnText, setCurrentTurnText] = useState('');
  const historyRef = useRef<HTMLDivElement>(null);
  const pendingHistoryExpandRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const langInputRef = useRef(langInput);
  const langOutputRef = useRef(langOutput);
  const isLangAutoRef = useRef(false);

  // --- Phase 2 State ---
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editOriginalText, setEditOriginalText] = useState('');
  const [editTranslatedText, setEditTranslatedText] = useState('');

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
    }).catch(err => {
      console.error('Failed to copy text: ', err);
    });
  };

  const handleDownloadSessionAudio = async (sessionItems: ConversationItem[], sessionTitle: string) => {
    try {
      const audioItems = sessionItems.filter(item => item.audioBase64);
      if (audioItems.length === 0) {
        alert(t.noAudioToExport || "재생 가능한 오디오가 없습니다.");
        return;
      }

      const blobs = audioItems.map(item => {
        const bytes = base64ToUint8Array(item.audioBase64!);
        return new Blob([bytes.buffer as any], { type: 'audio/wav' });
      });

      const mergedBlob = await mergeAudioBlobs(blobs);
      const url = URL.createObjectURL(mergedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sessionTitle || 'session'}_audio.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Audio export failed", e);
      alert("Audio export failed");
    }
  };

  const exportMenuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const notificationMenuRef = useRef<HTMLDivElement>(null);

  const unreadVisionCount = visionNotifications.filter((n) => !n.isRead).length;

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
  }, [setIsProfileMenuOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch { }
  }, [settings]);

  useEffect(() => {
    if (!isAdmin) {
      setIsAdminPanelOpen(false);
    }
  }, [isAdmin]);


  // --- Logic ---
  const visibleHistory =
    historyRenderLimit >= history.length
      ? history
      : history.slice(Math.max(0, history.length - historyRenderLimit));
  const hiddenHistoryCount = Math.max(0, history.length - visibleHistory.length);

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

  useEffect(() => {
    setHistoryRenderLimit(200);
  }, [currentSessionId, setHistoryRenderLimit]);

  const openSettings = () => {
    setIsProfileMenuOpen(false);
    setIsSettingsModalOpen(true);
  };

  const handleExport = async (type: 'drive' | 'docs' | 'classroom' | 'notebooklm') => {
    setIsExportMenuOpen(false);
    if ((type === 'drive' || type === 'classroom' || type === 'notebooklm') && !accessToken) {
      setIsLoginModalOpen(true);
      return;
    }

    setIsExporting(true);
    try {
      if (type === 'drive') {
        const result = await backupToDrive(accessToken!, history, {
          includeAudio: true,
          generateMissingAudio: true,
          voiceName: selectedVoice.name,
          ttsModel: MODEL_TTS,
        });
        if (result?.folderUrl) window.open(result.folderUrl, '_blank');
        alert(`Drive: ${t.exportSuccess}`);
      } else if (type === 'notebooklm') {
        const result = await backupToDrive(accessToken!, history, {
          includeAudio: false,
          generateMissingAudio: false,
          notebookLMMode: true,
        });
        if (result?.folderUrl) window.open(result.folderUrl, '_blank');
        setIsNotebookLMGuideOpen(true);
      } else if (type === 'docs') {
        if (accessToken) {
          await exportToDocs(accessToken, history);
          alert(`Docs: ${t.exportSuccess}`);
        } else {
          downloadTranscriptLocally(history);
          alert(t.offlineMode);
        }
      } else if (type === 'classroom') {
        setIsClassroomModalOpen(true);
        fetchCourses();
      }
    } catch (e) {
      console.error("Export failed", e);
      if (type === 'docs') {
        downloadTranscriptLocally(history);
        alert(t.offlineMode);
      } else {
        alert("Error: " + (e as Error).message);
      }
    } finally {
      setIsExporting(false);
    }
  };

  const [courses, setCourses] = useState<any[]>([]);
  const [isLoadingCourses, setIsLoadingCourses] = useState(false);

  const fetchCourses = async () => {
    if (!accessToken) return;
    setIsLoadingCourses(true);
    try {
      const list = await listCourses(accessToken);
      setCourses(list);
    } catch (e) {
      console.error("Failed to fetch courses", e);
      window.open('https://classroom.google.com', '_blank');
      setIsClassroomModalOpen(false);
    } finally {
      setIsLoadingCourses(false);
    }
  };

  const handleSubmitCourseWork = async (courseId: string) => {
    if (!accessToken) return;
    setIsExporting(true);
    try {
      await createCourseWork(accessToken, courseId, history);
      alert(t.exportSuccess);
      setIsClassroomModalOpen(false);
    } catch (e) {
      console.error(e);
      alert("Failed to submit to Classroom");
    } finally {
      setIsExporting(false);
    }
  };


  const splitTextForTts = (text: string, maxLen: number): string[] => {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length <= maxLen) return normalized ? [normalized] : [];
    const separators = new Set(['.', '!', '?', '。', '！', '？', '\n']);
    const sentences: string[] = [];
    let current = '';
    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      current += ch;
      if (separators.has(ch)) {
        const s = current.trim();
        if (s) sentences.push(s);
        current = '';
      }
    }
    if (current.trim()) sentences.push(current.trim());
    const chunks: string[] = [];
    let buf = '';
    for (const s of sentences) {
      if (!buf) {
        if (s.length <= maxLen) buf = s;
        else {
          for (let i = 0; i < s.length; i += maxLen) {
            const part = s.slice(i, i + maxLen).trim();
            if (part) chunks.push(part);
          }
        }
        continue;
      }
      const next = `${buf} ${s}`;
      if (next.length <= maxLen) buf = next;
      else {
        chunks.push(buf);
        if (s.length <= maxLen) buf = s;
        else {
          for (let i = 0; i < s.length; i += maxLen) {
            const part = s.slice(i, i + maxLen).trim();
            if (part) chunks.push(part);
          }
          buf = '';
        }
      }
    }
    if (buf) chunks.push(buf);
    return chunks;
  };

  const playTTS = async (text: string, id?: string, notifyOnErrorValue: boolean = false): Promise<void> => {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    const cacheKey = id ? `${id}:${selectedVoice.name}:${MODEL_TTS}` : null;
    if (id) {
      const item = history.find(i => i.id === id);
      if (item?.audioBase64) return playPCM(item.audioBase64);
    }
    if (id && cacheKey && settings.audioCacheEnabled) {
      const cached = await getCachedAudioBase64(cacheKey);
      if (cached) {
        setHistory(prev => prev.map(item => item.id === id ? { ...item, audioBase64: cached } : item));
        return playPCM(cached);
      }
    }
    const chunks = splitTextForTts(normalized, 200);
    try {
      const pcmChunks: Uint8Array[] = [];
      for (const chunk of chunks) {
        const data = await postApi<{ audioBase64: string }>('tts', {
          text: chunk,
          voiceName: selectedVoice.name,
          model: MODEL_TTS,
        });
        if (data.audioBase64) {
          pcmChunks.push(base64ToUint8Array(data.audioBase64));
          await playPCM(data.audioBase64);
        }
      }
      if (id && pcmChunks.length > 0) {
        const totalLen = pcmChunks.reduce((sum, x) => sum + x.byteLength, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const x of pcmChunks) { merged.set(x, offset); offset += x.byteLength; }
        const mergedBase64 = arrayBufferToBase64(merged.buffer);
        setHistory(prev => prev.map(item => item.id === id ? { ...item, audioBase64: mergedBase64 } : item));
        if (cacheKey && settings.audioCacheEnabled) await setCachedAudioBase64(cacheKey, mergedBase64);
      }
    } catch (e) {
      console.error("TTS failed", e);
      if (notifyOnErrorValue) alert(`TTS 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const playAll = async () => {
    for (const item of history) {
      if (item.translated) {
        await playTTS(item.translated, item.id);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  };

  const startEditing = useCallback((item: ConversationItem) => {
    setEditingItemId(item.id);
    setEditOriginalText(item.original);
    setEditTranslatedText(item.translated);
  }, []);

  const handleSaveEdit = useCallback((id: string) => {
    setHistory(prev => prev.map(item => item.id === id ? {
      ...item, original: editOriginalText, translated: editTranslatedText, updatedAt: Date.now()
    } : item));
    setEditingItemId(null);
  }, [editOriginalText, editTranslatedText, setHistory]);

  const [visionToastIds, setVisionToastIds] = useState<string[]>([]);
  const toastTimeoutsRef = useRef<Record<string, number>>({});

  const enqueueVisionToast = (id: string) => {
    setVisionToastIds(prev => [id, ...prev].slice(0, 3));
    if (toastTimeoutsRef.current[id]) window.clearTimeout(toastTimeoutsRef.current[id]);
    toastTimeoutsRef.current[id] = window.setTimeout(() => {
      setVisionToastIds(prev => prev.filter(x => x !== id));
      delete toastTimeoutsRef.current[id];
    }, 7000);
  };

  const dismissVisionToast = (id: string) => {
    setVisionToastIds(prev => prev.filter(x => x !== id));
    if (toastTimeoutsRef.current[id]) {
      window.clearTimeout(toastTimeoutsRef.current[id]);
      delete toastTimeoutsRef.current[id];
    }
  };

  const openVisionNotification = (id: string) => {
    setActiveVisionNotificationId(id);
    setIsNotificationMenuOpen(false);
    setVisionNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
    dismissVisionToast(id);
  };

  const handleVisionCaptured = async (payload: { blob: Blob }) => {
    const id = `vision_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const langA = langInputRef.current.code;
    const langB = langOutputRef.current.code;
    const item: VisionNotification = { id, timestamp: Date.now(), status: 'processing', isRead: false };
    setVisionNotifications(prev => [item, ...prev]);
    try {
      const base64Image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(payload.blob);
      });
      const result = await postApi<VisionResult>('vision', { base64Image, langA, langB, model: MODEL_VISION });
      setVisionNotifications(prev => prev.map(n => n.id === id ? { ...n, status: 'done', result } : n));
      enqueueVisionToast(id);
    } catch (e) {
      setVisionNotifications(prev => prev.map(n => n.id === id ? { ...n, status: 'error', error: String(e) } : n));
      enqueueVisionToast(id);
    }
  };

  const handleOpenHistory = async () => {
    setDriveRestoreMessage('');
    setSelectedDriveSessionId('');
    if (accessToken) {
      setIsLoadingDriveSessions(true);
      try {
        const list = await listDriveSessions(accessToken, 20);
        setDriveSessions(list || []);
      } catch (e) {
        console.error(e);
        setDriveSessions([]);
      } finally {
        setIsLoadingDriveSessions(false);
      }
    } else {
      setDriveSessions([]);
    }
    setIsHistoryModalOpen(true);
  };

  const [driveSessions, setDriveSessions] = useState<any[]>([]);
  const [isLoadingDriveSessions, setIsLoadingDriveSessions] = useState(false);
  const [selectedDriveSessionId, setSelectedDriveSessionId] = useState('');
  const [isRestoringDriveSession, setIsRestoringDriveSession] = useState(false);
  const [driveRestoreMessage, setDriveRestoreMessage] = useState('');

  const handleRestoreFromDrive = async (includeAudio: boolean) => {
    if (!accessToken || !selectedDriveSessionId) return;
    setIsRestoringDriveSession(true);
    setDriveRestoreMessage('복원 중...');
    try {
      const result = await restoreDriveSession(accessToken, selectedDriveSessionId, includeAudio);
      if (result?.history) {
        const now = Date.now();
        const newId = `drive_${now}`;
        setSessions(prev => [{
          id: newId, createdAt: now, updatedAt: now, items: result.history!,
          title: result.sessionName || result.history![0]?.original?.slice(0, 24) || 'Drive 세션'
        }, ...prev]);
        setCurrentSessionId(newId);
        setHistory(result.history);
      }
      setDriveRestoreMessage('복원을 완료했습니다.');
      setIsHistoryModalOpen(false);
    } catch (e) {
      console.error(e);
      setDriveRestoreMessage('복원에 실패했습니다.');
    } finally {
      setIsRestoringDriveSession(false);
    }
  };

  const [selectedLocalSessionId, setSelectedLocalSessionId] = useState('');

  const handleLoadSessionFromLocal = () => {
    if (!selectedLocalSessionId) return;
    const target = sessions.find(s => s.id === selectedLocalSessionId);
    if (target) {
      setCurrentSessionId(target.id);
      setHistory([...(target.items || [])]);
      setIsHistoryModalOpen(false);
    }
  };

  const handleClearLocalSessions = () => {
    clearSessions();
    setSelectedLocalSessionId('');
    clearCachedAudio();

    const now = Date.now();
    const initial: ConversationSession = {
      id: `local_${now}`,
      createdAt: now,
      updatedAt: now,
      items: [],
      title: '새 대화',
    };
    setSessions([initial]);
    setCurrentSessionId(initial.id);
    setHistory([]);
  };

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
    <div className="flex flex-col h-screen max-h-screen bg-slate-50 font-sans text-gray-900 overflow-hidden select-none">
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
        selectedVoice={selectedVoice}
        setSelectedVoice={setSelectedVoice}
        isOutputOnly={isOutputOnly}
        setIsOutputOnly={setIsOutputOnly}
        uiLangCode={uiLangCode}
        setUiLangCode={setUiLangCode}
        t={t}
      />

      {visionToastIds.length > 0 && (
        <div className="fixed top-20 right-4 z-[60] flex flex-col gap-2 w-[320px] max-w-[calc(100vw-2rem)]">
          {visionToastIds.map((id) => {
            const n = visionNotifications.find((x) => x.id === id);
            if (!n) return null;
            const title = t.visionTitle;
            const originalText = (n.result?.originalText || '').trim();
            const translatedText = (n.result?.translatedText || '').trim();
            const message =
              n.status === 'done'
                ? (translatedText || originalText || t.visionNoText)
                : n.status === 'error'
                  ? (n.error || t.visionFail)
                  : t.visionAnalyzing;

            const statusClass =
              n.status === 'done'
                ? 'text-emerald-700'
                : n.status === 'error'
                  ? 'text-red-700'
                  : 'text-gray-600';

            return (
              <div key={id} className="bg-white border border-gray-200 shadow-lg rounded-xl p-3">
                <div className="flex items-start justify-between gap-2">
                  <button onClick={() => openVisionNotification(id)} className="flex-1 text-left">
                    <div className="text-xs font-bold text-gray-800">{title}</div>
                    <div className={`text-[11px] mt-1 whitespace-pre-wrap break-words line-clamp-3 ${statusClass}`}>{String(message).trim().slice(0, 160)}</div>
                  </button>
                  <button
                    onClick={() => dismissVisionToast(id)}
                    className="text-gray-400 hover:text-gray-600 p-1"
                    aria-label="닫기"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <LanguageSelector
        langInput={langInput}
        setLangInput={setLangInput}
        langOutput={langOutput}
        setLangOutput={setLangOutput}
        t={t}
        onLanguageManualSelect={() => { isLangAutoRef.current = false; }}
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
        handleSaveEdit={handleSaveEdit}
        handleMergeWithAbove={handleMergeWithAbove}
        handleMergeWithBelow={handleMergeWithBelow}
        handleSplitItem={handleSplitItem}
        copyToClipboard={copyToClipboard}
        playTTS={playTTS}
        startEditing={startEditing}
      />

      <BottomControls
        isAutoPlay={isAutoPlay}
        setIsAutoPlay={setIsAutoPlay}
        isScrollLocked={isScrollLocked}
        setIsScrollLocked={setIsScrollLocked}
        status={status}
        toggleMic={toggleMic}
        playAll={playAll}
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
        handleClearLocalSessions={handleClearLocalSessions}
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

    </div >
  );
}

