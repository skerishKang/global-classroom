import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { logOut } from './utils/firebase';
import { clearSessions } from './utils/localStorage';
import { loadSettings, persistSettings } from './utils/settingsStorage';
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
import { Language, ConnectionStatus, VoiceOption, ConversationItem, ConversationSession, VisionResult, GlossaryEntry } from './types';
import {
  SUPPORTED_LANGUAGES,
  MODEL_LIVE,
  MODEL_TRANSLATE,
  MODEL_VISION,
  MODEL_TTS,
  DEFAULT_TRANSLATION_MODEL,
  TRANSLATIONS,
  VOICE_OPTIONS,
  GOOGLE_CLIENT_ID,
  GOOGLE_SCOPES,
  UI_LANG_KEY,
  HISTORY_RENDER_STEP
} from './constants';
import { decodeAudioData, base64ToUint8Array, arrayBufferToBase64 } from './utils/audioUtils';
import { MAX_ANSWER_CONTEXT_TURNS, resolveAnswerLanguage } from './utils/interviewAnswer';
import { retry } from './utils/retry';
import Visualizer from './components/Visualizer';
import CameraView from './components/CameraView';
import AdminPanelModal from './components/AdminPanelModal';
import NotebookLMGuide from './components/NotebookLMGuide';
import LoginModal from './components/LoginModal';
import HistoryModal from './components/HistoryModal';
import SettingsModal from './components/SettingsModal';
import ClassroomModal from './components/ClassroomModal';
import ExportResultSurface from './components/ExportResultSurface';
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
import { useInterviewLive, type LiveTranslationUpdate } from './hooks/useInterviewLive';
import { useExport } from './hooks/useExport';
import { useVision } from './hooks/useVision';
import { useAudioPlayer } from './hooks/useAudioPlayer';
import { useStorage } from './hooks/useStorage';
import { useTranslationService } from './hooks/useTranslationService';
import { useToast } from './hooks/useToast';
import { useLiveSharing } from './hooks/useLiveSharing';
import { AppSettings, VisionNotification, TranslationVariant } from './types';
import {
  detectSourceLanguageHeuristic,
  formatTargetBadge,
  getTargetsForSource,
  normalizeInterviewTargets,
  normalizeLanguageCode,
  parsePairRules,
  pickActiveTarget,
  pickInitialActiveTarget,
  type InterviewLanguagePolicy,
} from './utils/interviewLanguageRouting';

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

const INTERVIEW_FINAL_TRANSLATION_GRACE_MS = 900;

export default function App() {
  const interviewModeRequested =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mode') === 'interview';

  return <ClassroomApp interviewMode={interviewModeRequested} />;
}

function ClassroomApp({ interviewMode }: { interviewMode: boolean }) {
  // --- UI Translation State ---
  const [langInput, setLangInput] = useState<Language>(SUPPORTED_LANGUAGES[0]); // Default: Auto
  // Interview mode never defaults to Vietnamese: its output is a target set
  // ({ko, en} by default) and the detected source is excluded from it.
  const [langOutput, setLangOutput] = useState<Language>(() => (
    interviewMode
      ? (SUPPORTED_LANGUAGES.find(l => l.code === 'en') || SUPPORTED_LANGUAGES[1])
      : (SUPPORTED_LANGUAGES.find(l => l.code === 'vi') || SUPPORTED_LANGUAGES[1])
  ));
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
  } = useAuth(!interviewMode);

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
    deleteSession,
    handleNewConversation
  } = useConversationHistory({
    // Surface local-history write failures as an error toast (#39).
    // The callback only runs after a failed save, by which point `uiLangCode`
    // (declared below) is initialized.
    onSaveFailure: (reason) => {
      const isKo = uiLangCode === 'ko';
      const message = reason === 'quota'
        ? (isKo
            ? '브라우저 저장 공간이 부족해 일부 대화 기록을 저장하지 못했습니다.'
            : 'Not enough browser storage space — some conversation history was not saved.')
        : (isKo
            ? '일부 대화 기록을 저장하지 못했습니다. 브라우저 저장 설정을 확인해 주세요.'
            : 'Some conversation history could not be saved. Check your browser storage settings.');
      enqueueToast(message, 'error');
    },
  });

  // --- UI Settings ---
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  const [uiLangCode, setUiLangCode] = useState<string>(() => {
    const saved = localStorage.getItem(UI_LANG_KEY);
    return saved || 'ko';
  });


  const [interviewGlossaryText, setInterviewGlossaryText] = useState<string>(() => {
    try {
      return localStorage.getItem('global-classroom-interview-glossary-v1') || '';
    } catch {
      return '';
    }
  });

  const interviewGlossary = useMemo<GlossaryEntry[]>(() => (
    interviewGlossaryText
      .split(/\r?\n/)
      .map((line) => {
        const parts = line.split(/\s*(?:=>|→|=)\s*/, 2);
        return parts.length === 2
          ? { source: parts[0].trim(), target: parts[1].trim() }
          : null;
      })
      .filter((entry): entry is GlossaryEntry => Boolean(entry?.source && entry?.target))
      .slice(0, 100)
  ), [interviewGlossaryText]);

  const interviewGlossaryTerms = useMemo(
    () => Array.from(new Set(interviewGlossary.flatMap((entry) => [entry.source, entry.target]))),
    [interviewGlossary],
  );

  useEffect(() => {
    try {
      localStorage.setItem('global-classroom-interview-glossary-v1', interviewGlossaryText);
    } catch {
      // localStorage may be unavailable in privacy modes.
    }
  }, [interviewGlossaryText]);

  const [interviewPairRulesText, setInterviewPairRulesText] = useState<string>(() => {
    try {
      return localStorage.getItem('global-classroom-interview-pair-rules-v1') || '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('global-classroom-interview-pair-rules-v1', interviewPairRulesText);
    } catch {
      // localStorage may be unavailable in privacy modes.
    }
  }, [interviewPairRulesText]);

  // --- Interview language policy: one selected target set, source excluded ---
  const interviewTargets = useMemo<string[]>(() => normalizeInterviewTargets(
    Array.isArray(settings.interviewTargets)
      ? settings.interviewTargets.filter((code): code is string => typeof code === 'string')
      : []
  ), [settings.interviewTargets]);

  const interviewPairRules = useMemo(
    () => parsePairRules(interviewPairRulesText),
    [interviewPairRulesText]
  );

  const interviewPolicy = useMemo<InterviewLanguagePolicy>(
    () => ({ targets: interviewTargets, pairRules: interviewPairRules }),
    [interviewTargets, interviewPairRules]
  );

  const handleInterviewTargetsChange = useCallback((next: string[]) => {
    // Interview mode needs at least two targets so either side of a detected
    // conversation still has somewhere to translate.
    setSettings((prev) => ({
      ...prev,
      interviewTargets: normalizeInterviewTargets(next),
    }));
  }, []);

  // --- UI Language Sync removed at user request ---

  // --- Translation Helpers ---
  const t = TRANSLATIONS[uiLangCode] || TRANSLATIONS['ko'];

  // --- Custom Service: Translation & API ---
  const {
    postApi,
    translateText,
    translateToTargets,
    generateInterviewAnswer,
    translateAnswerToTarget
  } = useTranslationService({
    settings,
    history,
    setHistory,
    isAutoPlay,
    playTTS: (text, id) => playTTS(text, id),
    MODEL_TRANSLATE: settings.translationModel || DEFAULT_TRANSLATION_MODEL,
    onQuotaExhausted: (detail?: string) => {
      enqueueToast(
        uiLangCode === 'ko'
          ? '기본 번역 키의 무료 쿼터를 모두 사용했습니다. 개인 키 설정 또는 로그인 후 다시 시도해 주세요.'
          : 'Free quota for default translation key is exhausted. Please set your own API key or sign in, then try again.',
        'warning',
        6000
      );
      if (detail) {
        console.warn('Quota exhausted detail:', detail);
      }
    }
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
    micRestricted,
    handRaiseStatus,
    pendingHandRaises,
    createRoom,
    joinRoom,
    broadcastMessage,
    leaveRoom,
    toggleMicRestriction,
    raiseHand,
    lowerHand,
    approveHandRaise,
    denyHandRaise,
    localStream,
    remoteStreams,
    isVideoOn,
    startWebRTC,
    stopWebRTC
  } = useLiveSharing({ user, onMessageReceived: onLiveMessageReceived });

  // Gemini Props Helpers
  const onTranscriptReceived = useCallback((text: string, isFinal: boolean) => {
    if (isFinal) {
      // The finalized row becomes the source of truth; never leave the previous
      // interim caption rendered beside it.
      setCurrentTurnText('');
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

      // Broadcast if hosting or if we are a student and allowed
      if (roomStatus === 'hosting' || (roomStatus === 'joined' && (!micRestricted || handRaiseStatus === 'approved'))) {
        broadcastMessage(text, langInput.code);
      }
    } else {
      setCurrentTurnText(text);
    }
  }, [langInput, langOutput, setHistory, roomStatus, micRestricted, handRaiseStatus, broadcastMessage]);

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
    ensureAudioContext,
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

  // 자동 읽기 토글 시 오디오 컨텍스트를 즉시 깨워서 브라우저 자동재생 차단을 회피
  const handleToggleAutoPlay = useCallback(async () => {
    try {
      await ensureAudioContext();
    } catch (e) {
      console.warn('ensureAudioContext 실패', e);
    }
    setIsAutoPlay(prev => !prev);
  }, [ensureAudioContext]);

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
    exportResult,
    setExportResult,
    handleExport,
    handleSubmitCourseWork
  } = useExport({
    accessToken,
    history,
    selectedVoice,
    uiLangCode,
    t,
    setIsLoginModalOpen,
    settings
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
  const [interviewLivePreview, setInterviewLivePreview] = useState('');
  const [interviewLiveError, setInterviewLiveError] = useState('');
  const [interviewLiveWarning, setInterviewLiveWarning] = useState('');
  const historyRef = useRef<HTMLDivElement>(null);
  const pendingHistoryExpandRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const langInputRef = useRef(langInput);
  const langOutputRef = useRef(langOutput);
  const isLangAutoRef = useRef(false);
  const interviewLivePreviewRef = useRef('');
  // The translation currently displayed for the utterance in progress.
  const interviewActiveTargetRef = useRef<string>('');
  // Live translation is keyed by the utterance it belongs to, so a delayed
  // completion can only ever land on the row that produced it.
  const interviewUtteranceIdRef = useRef<string | null>(null);
  const interviewRowIdsRef = useRef<Set<string>>(new Set());
  const interviewPreviewByUtteranceRef = useRef<Map<string, Map<string, string>>>(new Map());
  const interviewFinalByUtteranceRef = useRef<Map<string, Map<string, string>>>(new Map());
  // Per-utterance routing: which selected targets this utterance may produce.
  // The detected source language is removed from the selected set.
  const interviewTargetsByUtteranceRef = useRef<Map<string, readonly string[]>>(new Map());
  const interviewPolicyRef = useRef(interviewPolicy);
  interviewPolicyRef.current = interviewPolicy;
  // The target the user last picked manually (#63): new utterances default to
  // it while it is still a selected target and not the source language.
  const preferredInterviewTargetRef = useRef<string>('');
  // Bounded recent interview context for the answer assist (#62): a few
  // finalized interviewer utterances, oldest first.
  const recentInterviewUtterancesRef = useRef<string[]>([]);

  const interviewEnglish = SUPPORTED_LANGUAGES.find((language) => language.code === 'en') || SUPPORTED_LANGUAGES[1];
  const interviewAuto = SUPPORTED_LANGUAGES.find((language) => language.code === 'auto') || SUPPORTED_LANGUAGES[0];

  useEffect(() => {
    if (!interviewMode) return;
    setLangInput(interviewAuto);
    setLangOutput(interviewEnglish);
    setIsOutputOnly(false);
    setIsScrollLocked(false);
    setCurrentTurnText('');
    setInterviewLivePreview('');
    interviewLivePreviewRef.current = '';
    interviewUtteranceIdRef.current = null;
    interviewRowIdsRef.current = new Set();
    interviewPreviewByUtteranceRef.current = new Map();
    interviewFinalByUtteranceRef.current = new Map();
    interviewTargetsByUtteranceRef.current = new Map();
    interviewActiveTargetRef.current = '';
    setInterviewLiveError('');
    setInterviewLiveWarning('');
  }, [interviewMode, interviewAuto, interviewEnglish]);

  const onInterviewUtteranceStart = useCallback((utteranceId: string) => {
    interviewUtteranceIdRef.current = utteranceId;
    // The source language is unknown until the first transcript arrives, so
    // every selected target may produce until then.
    interviewTargetsByUtteranceRef.current.set(utteranceId, interviewPolicyRef.current.targets);
    interviewActiveTargetRef.current = pickInitialActiveTarget('', interviewPolicyRef.current.targets, preferredInterviewTargetRef.current);
    interviewLivePreviewRef.current = '';
    setInterviewLivePreview('');
  }, []);

  const onInterviewFinalTranscript = useCallback((
    text: string,
    utteranceId: string,
    detectedLanguageCode?: string
  ) => {
    const normalized = text.trim();
    if (!normalized) return;

    // Real language identity: the transcriber's language code when it provides
    // one, the script heuristic otherwise. Region tags are canonicalized to the
    // base language (ko-KR -> ko) before the policy compares anything.
    const sourceLanguage = normalizeLanguageCode(
      detectedLanguageCode && detectedLanguageCode !== 'auto'
        ? detectedLanguageCode
        : detectSourceLanguageHeuristic(normalized)
    );
    const allowedTargets = getTargetsForSource(sourceLanguage, interviewPolicyRef.current);
    const activeTarget = pickInitialActiveTarget(sourceLanguage, allowedTargets, preferredInterviewTargetRef.current);

    const settled = interviewFinalByUtteranceRef.current.get(utteranceId);
    const previewed = interviewPreviewByUtteranceRef.current.get(utteranceId);
    interviewPreviewByUtteranceRef.current.delete(utteranceId);

    const translations: Record<string, TranslationVariant> = {};
    for (const target of allowedTargets) {
      const liveText = settled?.get(target) || previewed?.get(target) || '';
      if (liveText) {
        translations[target] = { text: liveText, kind: 'live', stale: false, updatedAt: Date.now() };
      }
    }

    // Live Translate is a low-latency preview, not the final-translation
    // authority. Only a completed Live target suppresses the normal translate
    // fallback; an interim preview can stay visible while the missing final is
    // resolved through /api/translate.
    const missingFinalTargetsAtBoundary = allowedTargets.filter((target) => !settled?.get(target)?.trim());

    // Snapshot earlier turns before the current one joins the context.
    const recentContext = recentInterviewUtterancesRef.current.slice(-MAX_ANSWER_CONTEXT_TURNS);
    recentInterviewUtterancesRef.current.push(normalized);
    if (recentInterviewUtterancesRef.current.length > MAX_ANSWER_CONTEXT_TURNS * 2) {
      recentInterviewUtterancesRef.current.splice(
        0,
        recentInterviewUtterancesRef.current.length - MAX_ANSWER_CONTEXT_TURNS * 2,
      );
    }

    const newItem: ConversationItem = {
      id: utteranceId || crypto.randomUUID(),
      original: normalized,
      originalRaw: normalized,
      translated: (activeTarget && translations[activeTarget]?.text) || '',
      isTranslating: missingFinalTargetsAtBoundary.length > 0,
      sourceKind: 'voice',
      sourceLanguage,
      translations,
      activeTarget: activeTarget || '',
      translationKind: 'live',
      translationStale: false,
      timestamp: Date.now(),
    };

setHistory((prev) => [...prev, newItem]);
    interviewRowIdsRef.current.add(newItem.id);
    interviewTargetsByUtteranceRef.current.delete(utteranceId);

    // #70: the suggested answer follows the finalized transcript/source
    // language so it is immediately speakable. Its translation is generated
    // automatically into this row's active question-translation target.
    const answerLanguage = resolveAnswerLanguage(activeTarget, interviewPolicyRef.current.targets, sourceLanguage);
    const answerLanguageName = SUPPORTED_LANGUAGES.find((language) => language.code === answerLanguage)?.name || answerLanguage;
    void generateInterviewAnswer(normalized, newItem.id, recentContext, answerLanguage, {
      answerLanguageName,
      sourceLanguage,
      answerTranslationTarget: activeTarget,
    });

    if (missingFinalTargetsAtBoundary.length > 0) {
      // Keep an entry present only while this row is inside the final grace
      // window. This lets late Live finals suppress fallback without allowing
      // very-late callbacks to recreate per-utterance bookkeeping indefinitely.
      if (!interviewFinalByUtteranceRef.current.has(utteranceId)) {
        interviewFinalByUtteranceRef.current.set(utteranceId, new Map());
      }
      window.setTimeout(() => {
        if (!interviewRowIdsRef.current.has(newItem.id)) {
          interviewFinalByUtteranceRef.current.delete(utteranceId);
          return;
        }

        const latestSettled = interviewFinalByUtteranceRef.current.get(utteranceId);
        const missingFinalTargets = allowedTargets.filter((target) => !latestSettled?.get(target)?.trim());
        interviewFinalByUtteranceRef.current.delete(utteranceId);

        if (missingFinalTargets.length === 0) {
          setHistory((prev) => prev.map((item) =>
            item.id === newItem.id ? { ...item, isTranslating: false } : item
          ));
          return;
        }

        const sourceLang = SUPPORTED_LANGUAGES.find((language) => language.code === sourceLanguage) || interviewAuto;
        const finalPolicy: InterviewLanguagePolicy = {
          targets: missingFinalTargets,
          pairRules: interviewPolicyRef.current.pairRules,
        };
        void translateToTargets(
          normalized,
          newItem.id,
          sourceLang,
          finalPolicy,
          interviewGlossary,
          sourceLanguage,
          preferredInterviewTargetRef.current,
        );
      }, INTERVIEW_FINAL_TRANSLATION_GRACE_MS);
    } else {
      interviewFinalByUtteranceRef.current.delete(utteranceId);
    }

    setCurrentTurnText('');
  }, [interviewAuto, interviewGlossary, setHistory, translateToTargets, generateInterviewAnswer]);

  const onInterviewInterimTranscript = useCallback((text: string) => {
    const sourceLanguage = detectSourceLanguageHeuristic(text);
    const allowedTargets = getTargetsForSource(sourceLanguage, interviewPolicyRef.current);
    const nextActiveTarget = pickInitialActiveTarget(sourceLanguage, allowedTargets, preferredInterviewTargetRef.current);
    if (nextActiveTarget !== interviewActiveTargetRef.current) {
      // A language switch starts a different translation stream; drop the
      // previews that belong to the abandoned target.
      interviewLivePreviewRef.current = '';
      interviewPreviewByUtteranceRef.current = new Map();
      setInterviewLivePreview('');
    }
    interviewActiveTargetRef.current = nextActiveTarget;
    const utteranceId = interviewUtteranceIdRef.current;
    if (utteranceId) {
      interviewTargetsByUtteranceRef.current.set(utteranceId, allowedTargets);
    }
    setCurrentTurnText(text);
  }, []);

  const onInterviewLiveTranslation = useCallback(({ utteranceId, target, text, isFinal }: LiveTranslationUpdate) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (isFinal) {
      const rowAlreadyExists = interviewRowIdsRef.current.has(utteranceId);
      const finalGracePending = interviewFinalByUtteranceRef.current.has(utteranceId);
      if (!rowAlreadyExists || finalGracePending) {
        const settled = interviewFinalByUtteranceRef.current.get(utteranceId) || new Map<string, string>();
        settled.set(target, trimmed);
        interviewFinalByUtteranceRef.current.set(utteranceId, settled);
      }
    }

    // The row already exists: the translation of a frozen utterance may keep
    // streaming in, and it can only ever touch its own row.
    if (interviewRowIdsRef.current.has(utteranceId)) {
      setHistory((prev) => prev.map((item) => {
        if (item.id !== utteranceId || item.translationKind !== 'live') return item;
        // The source language never becomes a translation of itself.
        if (item.sourceLanguage && target === item.sourceLanguage) return item;
        const translations: Record<string, TranslationVariant> = {
          ...(item.translations || {}),
          [target]: { text: trimmed, kind: 'live', stale: false, updatedAt: Date.now() },
        };
        const activeTarget = pickActiveTarget(Object.keys(translations), item.activeTarget);
        return {
          ...item,
          translations,
          activeTarget,
          translated: (activeTarget && translations[activeTarget]?.text) || item.translated,
          translationStale: false,
        };
      }));
      return;
    }

    // Before the row exists the utterance's routed targets decide what lands.
    const allowedTargets = interviewTargetsByUtteranceRef.current.get(utteranceId);
    if (allowedTargets && !allowedTargets.includes(target)) return;

    if (isFinal) {
      // The translation may settle before its transcript row is created.
      if (utteranceId === interviewUtteranceIdRef.current && target === interviewActiveTargetRef.current) {
        interviewLivePreviewRef.current = '';
        setInterviewLivePreview('');
      }
      return;
    }

    if (utteranceId !== interviewUtteranceIdRef.current) return;
    const previews = interviewPreviewByUtteranceRef.current.get(utteranceId) || new Map<string, string>();
    previews.set(target, trimmed);
    interviewPreviewByUtteranceRef.current.set(utteranceId, previews);
    if (target !== interviewActiveTargetRef.current) return;
    interviewLivePreviewRef.current = trimmed;
    setInterviewLivePreview(trimmed);
  }, [setHistory]);

  const {
    status: interviewLiveStatus,
    backend: interviewBackend,
    start: startInterviewLive,
    stop: stopInterviewLive,
  } = useInterviewLive({
    onInterimTranscript: onInterviewInterimTranscript,
    onFinalTranscript: onInterviewFinalTranscript,
    onUtteranceStart: onInterviewUtteranceStart,
    onLiveTranslation: onInterviewLiveTranslation,
    translationTargets: interviewTargets,
    glossaryTerms: interviewGlossaryTerms,
    // Fallback transcribers (browser/Groq) report no language code; reuse the
    // text path's detector so voice routing uses one authoritative source.
    detectLanguage: async (text: string) => {
      try {
        const detected = await postApi<{ code?: string }>('detect-language', { text });
        return typeof detected?.code === 'string' ? detected.code : undefined;
      } catch (detectionError) {
        console.warn('Voice source-language detection failed', detectionError);
        return undefined;
      }
    },
    onWarning: (message) => setInterviewLiveWarning(message),
    onFatalError: (message) => setInterviewLiveError(message),
  });

  const interviewConnectionStatus =
    interviewLiveStatus === 'connecting'
      ? ConnectionStatus.CONNECTING
      : interviewLiveStatus === 'live'
        ? ConnectionStatus.CONNECTED
        : interviewLiveStatus === 'error'
          ? ConnectionStatus.ERROR
          : ConnectionStatus.DISCONNECTED;

  const toggleInterviewMic = useCallback(() => {
    if (interviewLiveStatus === 'live' || interviewLiveStatus === 'connecting') {
      stopInterviewLive();
      // Mic stop invalidates every pending utterance: outstanding translation
      // callbacks must not repopulate a conversation the user just cleared.
      interviewUtteranceIdRef.current = null;
      interviewRowIdsRef.current = new Set();
      interviewPreviewByUtteranceRef.current = new Map();
      interviewFinalByUtteranceRef.current = new Map();
      interviewTargetsByUtteranceRef.current = new Map();
      interviewActiveTargetRef.current = '';
      interviewLivePreviewRef.current = '';
      setCurrentTurnText('');
      setInterviewLivePreview('');
      return;
    }

    setInterviewLiveError('');
    setInterviewLiveWarning('');
    void startInterviewLive().catch((liveError) => {
      setInterviewLiveError(liveError instanceof Error ? liveError.message : String(liveError));
    });
  }, [interviewLiveStatus, startInterviewLive, stopInterviewLive]);

  useEffect(() => {
    if (!interviewMode) {
      stopInterviewLive();
    }
  }, [interviewMode, stopInterviewLive]);

  const effectiveStatus = interviewMode ? interviewConnectionStatus : status;
  const effectiveIsMicOn = interviewMode ? interviewLiveStatus === 'live' : isMicOn;
  const effectiveAnalyser = interviewMode ? null : analyser;
  const effectiveToggleMic = interviewMode ? toggleInterviewMic : toggleMic;
  const effectiveConnect = interviewMode ? (() => { void startInterviewLive(); }) : connectToGemini;
  const effectiveErrorMessage = interviewMode
    ? interviewLiveError || interviewLiveWarning
    : errorMessage;

  const handleInterviewTextSubmit = useCallback((text: string) => {
    if (!text.trim()) return;
    const newItem: ConversationItem = {
      id: crypto.randomUUID(),
      original: text,
      originalRaw: text,
      translated: '',
      isTranslating: true,
      sourceKind: 'text',
      translationKind: 'manual',
      translationStale: false,
      timestamp: Date.now(),
    };
    setHistory((prev) => [...prev, newItem]);
    // Voice and text share one routing policy: detect the source, then
    // translate into every selected target except the source language.
    void translateToTargets(text, newItem.id, interviewAuto, interviewPolicyRef.current, interviewGlossary, undefined, preferredInterviewTargetRef.current);
  }, [interviewAuto, interviewGlossary, setHistory, translateToTargets]);

  const handleInterviewRetranslate = useCallback((item: ConversationItem) => {
    setHistory((prev) => prev.map((entry) =>
      entry.id === item.id
        ? { ...entry, isTranslating: true }
        : entry
    ));
    const sourceLanguage = item.sourceLanguage
      ? (SUPPORTED_LANGUAGES.find((language) => language.code === item.sourceLanguage) || interviewAuto)
      : interviewAuto;
    const activeTarget = item.activeTarget && item.translations?.[item.activeTarget]
      ? item.activeTarget
      : '';
    const retranslatePolicy = activeTarget
      ? { ...interviewPolicyRef.current, targets: [activeTarget] }
      : interviewPolicyRef.current;
    void translateToTargets(
      item.original,
      item.id,
      sourceLanguage,
      retranslatePolicy,
      interviewGlossary,
      item.sourceLanguage,
      preferredInterviewTargetRef.current
    );
  }, [interviewAuto, interviewGlossary, setHistory, translateToTargets]);

  const handleInterviewSelectTarget = useCallback((itemId: string, target: string) => {
    // A manual tab selection becomes the preferred default for future rows (#63).
    preferredInterviewTargetRef.current = target;
    setHistory((prev) => prev.map((item) => {
      if (item.id !== itemId) return item;
      const variant = item.translations?.[target];
      if (!variant) return item;
      return {
        ...item,
        activeTarget: target,
        translated: variant.text,
        translationKind: variant.kind || 'manual',
        translationStale: Boolean(variant.stale),
        updatedAt: Date.now(),
      };
    }));
    void translateAnswerToTarget(itemId, target);
  }, [setHistory, translateAnswerToTarget]);

  // --- Editing State ---
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<'original' | 'translated' | 'both'>('both');
  const [editOriginalText, setEditOriginalText] = useState('');
  const [editTranslatedText, setEditTranslatedText] = useState('');

  const startEditing = useCallback((item: ConversationItem, field: 'original' | 'translated' | 'both' = 'both') => {
    setEditingItemId(item.id);
    setEditingField(field);
    setEditOriginalText(item.original);
    setEditTranslatedText(item.translated);
  }, []);

  const handleSaveEditAction = useCallback((id: string) => {
    handleSaveEdit(id, editOriginalText, editTranslatedText);
    setEditingItemId(null);
    setEditingField('both');
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

  // 공유방 전환 시 로컬 표시 히스토리 초기화
  useEffect(() => {
    if (roomStatus === 'hosting' || roomStatus === 'joined') {
      setHistory([]);
      setCurrentTurnText('');
      setEditingItemId(null);
    }
  }, [roomStatus, setHistory]);

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

  const handleNewConversationAction = useCallback(() => {
    if (history.length === 0) {
      handleNewConversation();
      return;
    }

    const confirmMsg = uiLangCode === 'ko'
      ? '현재 대화를 저장하고 새로운 대화를 시작하시겠습니까?'
      : 'Would you like to save the current conversation and start a new one?';

    if (window.confirm(confirmMsg)) {
      // The saving logic is already handled by the auto-sync in useConversationHistory
      handleNewConversation();
      setCurrentTurnText('');
      setLangInput(SUPPORTED_LANGUAGES[0]); // Reset to Auto
      // Interview mode keeps its automatic selected-target routing, so a new
      // conversation must never reset the output to one fixed language.
      setLangOutput(interviewMode
        ? (SUPPORTED_LANGUAGES.find(l => l.code === 'en') || SUPPORTED_LANGUAGES[1])
        : (SUPPORTED_LANGUAGES.find(l => l.code === 'vi') || SUPPORTED_LANGUAGES[1]));
      enqueueToast(uiLangCode === 'ko' ? '새 대화가 시작되었습니다.' : 'New conversation started.', 'success');
    }
  }, [history, handleNewConversation, interviewMode, uiLangCode, enqueueToast]);

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

  // Personal API keys are credentials: persist to this browser's localStorage
  // only. Never write or read them via the Firestore user profile (#32).
  useEffect(() => {
    try {
      persistSettings(settings);
    } catch { }
  }, [settings]);

  useEffect(() => {
    if (!isAdmin) {
      setIsAdminPanelOpen(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    setHistoryRenderLimit(200);
  }, [currentSessionId, setHistoryRenderLimit]);

  useEffect(() => {
    const hasConversationContent = history.length > 0 || !!currentTurnText || !!interviewLivePreview;
    if (!isScrollLocked && hasConversationContent && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history, currentTurnText, interviewLivePreview, isScrollLocked]);

  useLayoutEffect(() => {
    if (!pendingHistoryExpandRef.current || !historyRef.current) return;
    const { prevScrollHeight, prevScrollTop } = pendingHistoryExpandRef.current;
    pendingHistoryExpandRef.current = null;
    const delta = historyRef.current.scrollHeight - prevScrollHeight;
    historyRef.current.scrollTop = prevScrollTop + delta;
  }, [historyRenderLimit]);

  return (
    <div className="flex flex-col h-screen h-[100dvh] bg-slate-50 font-sans text-gray-900 overflow-hidden">
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
        onNewConversation={handleNewConversationAction}
        interviewMode={interviewMode}
        interviewBackend={interviewBackend}
        interviewTargetBadge={formatTargetBadge(interviewTargets)}
        onToggleInterviewMode={() => {
          const url = new URL(window.location.href);
          if (interviewMode) url.searchParams.delete('mode');
          else url.searchParams.set('mode', 'interview');
          window.location.href = url.toString();
        }}
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
        uiLangCode={uiLangCode}
        interviewMode={interviewMode}
        interviewTargetBadge={formatTargetBadge(interviewTargets)}
      />

      <ConversationList
        key={`list_${currentSessionId}`}
        analyser={effectiveAnalyser}
        isMicOn={effectiveIsMicOn}
        history={history}
        currentTurnText={currentTurnText}
        isOutputOnly={isOutputOnly}
        historyRef={historyRef}
        t={t}
        status={effectiveStatus}
        errorMessage={effectiveErrorMessage}
        connectToGemini={effectiveConnect}
        toggleMic={effectiveToggleMic}
        currentTurnTranslation={interviewMode ? interviewLivePreview : ''}
        interviewMode={interviewMode}
        editingItemId={editingItemId}
        editingField={editingField}
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
        onRetranslate={interviewMode ? handleInterviewRetranslate : undefined}
        onSubmitText={interviewMode ? handleInterviewTextSubmit : undefined}
        onSelectTranslationTarget={interviewMode ? handleInterviewSelectTarget : undefined}
      />

      <BottomControls
        key={`controls_${currentSessionId}`}
        isAutoPlay={isAutoPlay}
        setIsAutoPlay={setIsAutoPlay}
        isScrollLocked={isScrollLocked}
        setIsScrollLocked={setIsScrollLocked}
        status={effectiveStatus}
        toggleMic={effectiveToggleMic}
        playAll={playAll}
        stopTTS={stopTTS}
        setIsCameraOpen={setIsCameraOpen}
        t={t}
        micRestricted={micRestricted}
        handRaiseStatus={handRaiseStatus}
        isHost={isHost}
        uiLangCode={uiLangCode}
        onTextSubmit={interviewMode ? undefined : (text) => {
          const newItem = {
            id: crypto.randomUUID(),
            original: text,
            translated: '',
            isTranslating: true,
            timestamp: Date.now(),
          };
          setHistory(prev => [...prev, newItem]);
          translateText(text, newItem.id, langInput, langOutput);
          if (roomStatus === 'hosting' || (roomStatus === 'joined' && (!micRestricted || handRaiseStatus === 'approved'))) {
            broadcastMessage(text, langInput.code);
          }
        }}
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
        interviewMode={interviewMode}
        interviewGlossaryText={interviewGlossaryText}
        onInterviewGlossaryChange={setInterviewGlossaryText}
        interviewTargets={interviewTargets}
        onInterviewTargetsChange={handleInterviewTargetsChange}
        interviewPairRulesText={interviewPairRulesText}
        onInterviewPairRulesChange={setInterviewPairRulesText}
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

      <ExportResultSurface
        result={exportResult}
        onClose={() => setExportResult(null)}
        langCode={uiLangCode}
      />

      <LiveSharingModal
        isOpen={isLiveModalOpen}
        onClose={() => setIsLiveModalOpen(false)}
        roomId={roomId}
        roomStatus={roomStatus}
        onJoin={joinRoom}
        onCreate={createRoom}
        onLeave={leaveRoom}
        micRestricted={micRestricted}
        handRaiseStatus={handRaiseStatus}
        pendingHandRaises={pendingHandRaises}
        localStream={localStream}
        remoteStreams={remoteStreams}
        isVideoOn={isVideoOn}
        onStartVideo={startWebRTC}
        onStopVideo={stopWebRTC}
        onToggleMicRestriction={toggleMicRestriction}
        onRaiseHand={raiseHand}
        onLowerHand={lowerHand}
        onApproveHandRaise={approveHandRaise}
        onDenyHandRaise={denyHandRaise}
      />

      <ToastSystem toasts={toasts} onDismiss={dismissToast} />

    </div >
  );
}

