import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { User, onAuthStateChanged } from 'firebase/auth';
import {
  getAppAuth,
  logOut,
  signInAsGuest,
  signInWithEmailPassword,
  signUpWithEmailPassword
} from './utils/firebase';
import { loadSessions, saveSessions, clearSessions } from './utils/localStorage';
import { getCachedAudioBase64, hasCachedAudio, setCachedAudioBase64, clearCachedAudio } from './utils/idbAudioCache';
import {
  backupToDrive,
  exportToDocs,
  downloadTranscriptLocally,
  listDriveSessions,
  restoreDriveSession,
  listCourses,
  createCourseWork
} from './utils/googleWorkspace';
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
  GOOGLE_SCOPES
} from './constants';
import { createPcmBlob, decodeAudioData, base64ToUint8Array, arrayBufferToBase64 } from './utils/audioUtils';
import { retry } from './utils/retry';
import Visualizer from './components/Visualizer';
import CameraView from './components/CameraView';
import AdminPanelModal from './components/AdminPanelModal';
import NotebookLMGuide from './components/NotebookLMGuide';

// --- Icons ---
const MicIcon = () => <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>;
const MicOffIcon = () => <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 5.586a2 2 0 012.828 0l-.793.793-2.828-2.828.793-.793zM11 18.172l-6.586-6.586a2 2 0 002.828 2.828L11 18.172zm9.9-9.9l-6.586 6.586a2 2 0 01-2.828-2.828l6.586-6.586a2 2 0 012.828 2.828z" /><line x1="1" y1="1" x2="23" y2="23" strokeWidth={2} /></svg>;
const CameraIcon = () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><circle cx="12" cy="13" r="3" /></svg>;
const ArrowRightIcon = () => <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>;
const SpeakerIcon = () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>;
const PlayAllIcon = () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 012 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
const GlobeIcon = () => <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
const ExportIcon = () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>;
const BellIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
  </svg>
);

// --- Brand Icons (Official Colors) ---
const DocsIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M14.5 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V7.5L14.5 2Z" fill="#4285F4" />
    <path d="M14 2V8H20" fill="#A1C2FA" />
    <path d="M14 2V8H20" fillOpacity="0.3" fill="black" />
    <path d="M7 11H14V13H7V11ZM7 15H17V17H7V15ZM7 7H12V9H7V7Z" fill="white" />
  </svg>
);

const DriveIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
    <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
    <path d="M43.65 25l13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2l-13.75 23.8z" fill="#00ac47" />
    <path d="M73.55 76.8c1.55 0 3.1-.4 4.5-1.2l3.85-6.65c.8-1.4 1.2-2.95 1.2-4.5h-27.5z" fill="#ea4335" />
    <path d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.95-3.3 3.3l-20 34.6 13.75 23.8z" fill="#00832d" />
    <path d="M86.4 50.85l-13.75-23.8C71.85 25.7 70.7 24.55 69.35 23.75L49.95 23.75l13.75 23.8z" fill="#2684fc" />
    <path d="M73.55 76.8h-29.9l-13.75-23.8h57.4c0 1.6-.45 3.15-1.25 4.55z" fill="#ffba00" />
  </svg>
);

const ClassroomIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path fill="#0F9D58" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5-9h10v2H7z" />
    <path fill="#0F9D58" d="M12 6c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" />
    <circle cx="12" cy="10" r="1.5" fill="#F6BB16" />
    <path d="M12 12.5c-1.67 0-5 .83-5 2.5V16h10v-1c0-1.67-3.33-2.5-5-2.5z" fill="#F6BB16" />
  </svg>
);

const NotebookLMIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" stroke="#4B5563" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Google Logo for Login Button
const GoogleLogo = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.26.81-.58z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </svg>
);

type VisionNotificationStatus = 'processing' | 'done' | 'error';

type VisionNotification = {
  id: string;
  createdAt: number;
  status: VisionNotificationStatus;
  langA: string;
  langB: string;
  result?: VisionResult;
  error?: string;
  isRead: boolean;
};

type AppSettings = {
  driveBackupMode: 'manual' | 'auto';
  audioCacheEnabled: boolean;
  recordOriginalEnabled: boolean;
};

const SETTINGS_KEY = 'global_classroom_settings';
const ACCESS_TOKEN_STORAGE_KEY = 'global_classroom_google_access_token';
const GOOGLE_USER_STORAGE_KEY = 'global_classroom_google_user';
const ADMIN_EMAIL = 'padiemipu@gmail.com';
const HISTORY_RENDER_STEP = 200;

export default function App() {
  // --- UI Settings ---
  const [uiLangCode, setUiLangCode] = useState('ko');
  const t = TRANSLATIONS[uiLangCode] || TRANSLATIONS['ko'];

  // --- Translation Logic Settings ---
  const [langInput, setLangInput] = useState<Language>(SUPPORTED_LANGUAGES[0]); // Default: Korean
  const [langOutput, setLangOutput] = useState<Language>(SUPPORTED_LANGUAGES[1]); // Default: English
  const [isAutoPlay, setIsAutoPlay] = useState(false);
  const [isScrollLocked, setIsScrollLocked] = useState(true);
  const [selectedVoice, setSelectedVoice] = useState<VoiceOption>(VOICE_OPTIONS[0]);

  // --- Status & Media ---
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  // --- Auth & Data ---
  // We use `any` here to support both Firebase User (Guest) and our custom Google User object
  const [user, setUser] = useState<User | any | null>(() => {
    try {
      const raw = sessionStorage.getItem(GOOGLE_USER_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });
  const [accessToken, setAccessToken] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [emailAuthEmail, setEmailAuthEmail] = useState('');
  const [emailAuthPassword, setEmailAuthPassword] = useState('');
  const [emailAuthError, setEmailAuthError] = useState<string>('');
  const [isEmailAuthBusy, setIsEmailAuthBusy] = useState(false);
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(true);
  const [history, setHistory] = useState<ConversationItem[]>([]);
  const [historyRenderLimit, setHistoryRenderLimit] = useState<number>(HISTORY_RENDER_STEP);
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [isSessionsReady, setIsSessionsReady] = useState(false);
  const [currentTurnText, setCurrentTurnText] = useState('');
  const currentTurnTextRef = useRef('');
  const historyRef = useRef<HTMLDivElement>(null);
  const pendingHistoryExpandRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const langInputRef = useRef<Language>(langInput);
  const langOutputRef = useRef<Language>(langOutput);
  const isLangAutoRef = useRef(true);
  const isHydratingHistoryRef = useRef(false);

  const [isOutputOnly, setIsOutputOnly] = useState(false);

  // --- Modals State ---
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isClassroomModalOpen, setIsClassroomModalOpen] = useState(false);
  const [isNotebookLMGuideOpen, setIsNotebookLMGuideOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [localSessionsPreview, setLocalSessionsPreview] = useState<ConversationSession[]>([]);
  const [selectedLocalSessionId, setSelectedLocalSessionId] = useState<string>('');
  const [driveSessions, setDriveSessions] = useState<any[]>([]);
  const [isLoadingDriveSessions, setIsLoadingDriveSessions] = useState(false);
  const [selectedDriveSessionId, setSelectedDriveSessionId] = useState<string>('');
  const [isRestoringDriveSession, setIsRestoringDriveSession] = useState(false);
  const [driveRestoreMessage, setDriveRestoreMessage] = useState<string>('');
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isNotificationMenuOpen, setIsNotificationMenuOpen] = useState(false);
  const [visionNotifications, setVisionNotifications] = useState<VisionNotification[]>([]);
  const [visionToastIds, setVisionToastIds] = useState<string[]>([]);
  const [activeVisionNotificationId, setActiveVisionNotificationId] = useState<string | null>(null);
  const toastTimeoutsRef = useRef<Record<string, number>>({});
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) {
        return { driveBackupMode: 'manual', audioCacheEnabled: true, recordOriginalEnabled: true };
      }
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
  const [courses, setCourses] = useState<any[]>([]);
  const [isLoadingCourses, setIsLoadingCourses] = useState(false);

  // --- Phase 2: Media & Edit ---
  const [isRecordingOriginal, setIsRecordingOriginal] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editOriginalText, setEditOriginalText] = useState('');
  const [editTranslatedText, setEditTranslatedText] = useState('');

  const exportMenuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const notificationMenuRef = useRef<HTMLDivElement>(null);

  // --- Refs ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const geminiReconnectTimeoutRef = useRef<number | null>(null);
  const geminiReconnectAttemptRef = useRef(0);
  const geminiMicDesiredRef = useRef(false);
  const isGeminiConnectingRef = useRef(false);
  const geminiConnectIdRef = useRef(0);
  const connectToGeminiRef = useRef<(opts?: { isRetry?: boolean }) => Promise<void>>(async () => { });
  const tokenClientRef = useRef<any>(null); // GIS Token Client
  const isGuestSigningInRef = useRef(false);

  // --- Phase 2 Refs ---
  const originalMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const originalAudioChunksRef = useRef<Blob[]>([]);

  const userEmail = typeof (user as any)?.email === 'string' ? String((user as any).email) : '';
  const isAdmin = userEmail.toLowerCase() === ADMIN_EMAIL;

  useEffect(() => {
    try {
      const loaded = loadSessions();
      if (loaded.length === 0) {
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
        isHydratingHistoryRef.current = true;
        setHistory([]);
      } else {
        const latest = loaded.reduce((acc, cur) => {
          const a = typeof acc.updatedAt === 'number' ? acc.updatedAt : acc.createdAt;
          const b = typeof cur.updatedAt === 'number' ? cur.updatedAt : cur.createdAt;
          return b > a ? cur : acc;
        }, loaded[0]);

        setSessions(loaded);
        setCurrentSessionId(latest.id);
        isHydratingHistoryRef.current = true;
        setHistory([...(latest.items || [])]);
      }
    } catch (e) {
      console.error('로컬 세션 로드 실패', e);
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
      isHydratingHistoryRef.current = true;
      setHistory([]);
    } finally {
      setIsSessionsReady(true);
    }
  }, []);

  // 1. Initialize Auth on Mount
  useEffect(() => {
    // Initialize GIS Client
    // We check if google global is available (loaded via script in index.html)
    const checkGoogle = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
        if (!GOOGLE_CLIENT_ID) {
          console.error('GOOGLE_CLIENT_ID is empty. Check VITE_GOOGLE_CLIENT_ID in Netlify env.');
          clearInterval(checkGoogle);
          return;
        }

        try {
          tokenClientRef.current = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: GOOGLE_SCOPES,
            callback: async (tokenResponse: any) => {
              if (tokenResponse && tokenResponse.access_token) {
                setAccessToken(tokenResponse.access_token);
                // Fetch User Profile
                try {
                  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                    headers: { 'Authorization': `Bearer ${tokenResponse.access_token}` }
                  });
                  const profile = await res.json();
                  // Construct a user object compatible with our UI
                  const googleUser = {
                    uid: profile.sub,
                    displayName: profile.name,
                    email: profile.email,
                    photoURL: profile.picture,
                    isAnonymous: false,
                    providerId: 'google.com'
                  };
                  setUser(googleUser);
                  try {
                    sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, tokenResponse.access_token);
                    sessionStorage.setItem(GOOGLE_USER_STORAGE_KEY, JSON.stringify(googleUser));
                  } catch {
                  }
                  setIsLoginModalOpen(false);
                } catch (e) {
                  console.error("Failed to fetch Google profile", e);
                }
              }
            },
          });
          console.log('GIS Token Client initialized');
          clearInterval(checkGoogle);
        } catch (e) {
          console.error('initTokenClient failed:', e);
          tokenClientRef.current = null;
        }
      }
    }, 500);

    return () => {
      clearInterval(checkGoogle);
    };
  }, []); // Only on mount

  // 2. Monitor Firebase Auth State (Guest)
  useEffect(() => {
    const auth = getAppAuth();
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setIsAuthReady(true);
      setUser((prev) => {
        if (accessToken && prev && !prev.isAnonymous) {
          return prev;
        }

        if (!firebaseUser) {
          if (!accessToken && (!prev || prev.isAnonymous) && !isGuestSigningInRef.current) {
            isGuestSigningInRef.current = true;
            signInAsGuest()
              .then(() => {
                const current = getAppAuth().currentUser;
                if (current?.isAnonymous) {
                  setUser(current);
                }
              })
              .catch((error) => console.error('Anonymous sign in failed:', error))
              .finally(() => {
                isGuestSigningInRef.current = false;
              });
          }
          return prev || null;
        }

        isGuestSigningInRef.current = false;

        return firebaseUser;
      });
    });
    return () => unsubscribe();
  }, [accessToken]);

  // 3. Save to Local Storage
  useEffect(() => {
    if (!isSessionsReady) return;
    if (!currentSessionId) return;
    if (isHydratingHistoryRef.current) {
      isHydratingHistoryRef.current = false;
      return;
    }

    const now = Date.now();
    const titleCandidate = history.length > 0
      ? String(history[0].original || '').trim().slice(0, 24)
      : undefined;

    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === currentSessionId);
      if (idx >= 0) {
        const prevSession = prev[idx];
        const nextTitle = prevSession.title || titleCandidate || '새 대화';
        const nextSession: ConversationSession = {
          ...prevSession,
          updatedAt: now,
          items: history,
          title: nextTitle,
        };
        const next = prev.slice();
        next[idx] = nextSession;
        return next;
      }

      const nextTitle = titleCandidate || '새 대화';
      const newSession: ConversationSession = {
        id: currentSessionId,
        createdAt: now,
        updatedAt: now,
        items: history,
        title: nextTitle,
      };
      return [newSession, ...prev];
    });
  }, [history, currentSessionId, isSessionsReady]);

  useEffect(() => {
    if (!isSessionsReady) return;
    saveSessions(sessions);
  }, [sessions, isSessionsReady]);

  useEffect(() => {
    langInputRef.current = langInput;
  }, [langInput]);

  useEffect(() => {
    langOutputRef.current = langOutput;
  }, [langOutput]);

  // Close export menu
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setIsExportMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
    }
  }, [settings]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
        setIsProfileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (notificationMenuRef.current && !notificationMenuRef.current.contains(event.target as Node)) {
        setIsNotificationMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setIsAdminPanelOpen(false);
    }
  }, [isAdmin]);


  // --- Logic ---
  const handleEmailLogin = async () => {
    if (isEmailAuthBusy) return;
    setEmailAuthError('');

    const email = emailAuthEmail.trim();
    const password = emailAuthPassword;
    if (!email || !password) {
      setEmailAuthError('이메일과 비밀번호를 입력해주세요.');
      return;
    }

    setIsEmailAuthBusy(true);
    try {
      const firebaseUser = await signInWithEmailPassword(email, password);

      setAccessToken(null);
      try {
        sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
        sessionStorage.removeItem(GOOGLE_USER_STORAGE_KEY);
      } catch {
      }

      setUser(firebaseUser);
      setIsLoginModalOpen(false);
      setEmailAuthPassword('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setEmailAuthError(`로그인 실패: ${msg}`);
    } finally {
      setIsEmailAuthBusy(false);
    }
  };

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
    setHistoryRenderLimit(HISTORY_RENDER_STEP);
    pendingHistoryExpandRef.current = null;
  }, [currentSessionId]);

  const handleEmailSignUp = async () => {
    if (isEmailAuthBusy) return;
    setEmailAuthError('');

    const email = emailAuthEmail.trim();
    const password = emailAuthPassword;
    if (!email || !password) {
      setEmailAuthError('이메일과 비밀번호를 입력해주세요.');
      return;
    }

    setIsEmailAuthBusy(true);
    try {
      const firebaseUser = await signUpWithEmailPassword(email, password);

      setAccessToken(null);
      try {
        sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
        sessionStorage.removeItem(GOOGLE_USER_STORAGE_KEY);
      } catch {
      }

      setUser(firebaseUser);
      setIsLoginModalOpen(false);
      setEmailAuthPassword('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setEmailAuthError(`가입 실패: ${msg}`);
    } finally {
      setIsEmailAuthBusy(false);
    }
  };

  const handleLoginSelection = async (type: 'google' | 'guest') => {
    setEmailAuthError('');
    console.log('Login selection:', type);
    console.log('google object:', typeof google !== 'undefined' ? 'loaded' : 'not loaded');
    console.log('tokenClientRef.current:', tokenClientRef.current ? 'initialized' : 'not initialized');

    if (type === 'google') {
      if (!tokenClientRef.current) {
        alert("Google Auth가 아직 초기화되지 않았습니다. 페이지를 새로고침해주세요.");
        console.error('TokenClient not initialized');
        return;
      }

      try {
        console.log('Requesting access token...');
        tokenClientRef.current.requestAccessToken();
      } catch (error) {
        console.error('requestAccessToken failed:', error);
        alert('Google 로그인 오류: ' + (error as Error).message);
      }
    } else {
      // Guest
      try {
        const auth = getAppAuth();
        const current = auth.currentUser;
        const guest = current?.isAnonymous ? current : await signInAsGuest();
        setAccessToken(null);
        try {
          sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
          sessionStorage.removeItem(GOOGLE_USER_STORAGE_KEY);
        } catch {
        }
        setUser(guest);
      } catch (e) {
        console.error('게스트 로그인 실패', e);
      }
      setIsLoginModalOpen(false);
    }
  };

  const handleLogout = async () => {
    setIsAdminPanelOpen(false);
    setEmailAuthError('');
    // 1. Clear GIS state
    if (accessToken) {
      // Ideally revoke token here using google.accounts.oauth2.revoke
      if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
        google.accounts.oauth2.revoke(accessToken, () => { console.log('Token revoked') });
      }
      setAccessToken(null);
    }

    try {
      sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(GOOGLE_USER_STORAGE_KEY);
    } catch {
    }

    // 2. Firebase Logout
    await logOut();

    // 3. Reset User
    setUser(null);

    // 4. Re-initiate Guest login if needed by effect
    try {
      const guest = await signInAsGuest();
      setUser(guest);
    } catch (e) {
      console.error('게스트 로그인 재시도 실패', e);
    }
  };

  const openSettings = () => {
    setIsProfileMenuOpen(false);
    setIsSettingsModalOpen(true);
  };

  const handleExport = async (type: 'drive' | 'docs' | 'classroom' | 'notebooklm') => {
    setIsExportMenuOpen(false);

    // Auth Checks before processing
    if (type === 'drive' || type === 'classroom' || type === 'notebooklm') {
      // Check for Google Login (accessToken presence) specifically for these features
      if (!accessToken) {
        setIsLoginModalOpen(true);
        return;
      }
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

        if (result?.folderUrl) {
          window.open(result.folderUrl, '_blank');
        }
        alert(`Drive: ${t.exportSuccess}`);
      }
      else if (type === 'notebooklm') {
        const result = await backupToDrive(accessToken!, history, {
          includeAudio: false,
          generateMissingAudio: false,
          notebookLMMode: true,
        });

        if (result?.folderUrl) {
          window.open(result.folderUrl, '_blank');
        }
        setIsNotebookLMGuideOpen(true);
      }
      else if (type === 'docs') {
        // Docs fallback logic: Login ? API : Download
        if (accessToken) {
          await exportToDocs(accessToken, history);
          alert(`Docs: ${t.exportSuccess}`);
        } else {
          downloadTranscriptLocally(history);
          alert(t.offlineMode);
        }
      }
      else if (type === 'classroom') {
        // Open Modal to list courses
        setIsClassroomModalOpen(true);
        fetchCourses();
      }
    } catch (e) {
      console.error("Export failed", e);
      // Fallback logic on error
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

  const fetchCourses = async () => {
    if (!accessToken) return;
    setIsLoadingCourses(true);
    try {
      const list = await listCourses(accessToken);
      setCourses(list);
    } catch (e) {
      console.error("Failed to fetch courses", e);
      // Fallback: Just open Classroom
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

  // --- Cleanup ---
  const cleanupAudio = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setAnalyser(null);
  }, []);

  const playAudioFromBase64 = async (base64String: string): Promise<void> => {
    return new Promise(async (resolve) => {
      try {
        const playbackCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const audioBuffer = await decodeAudioData(base64ToUint8Array(base64String), playbackCtx, 24000);
        const source = playbackCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackCtx.destination);
        source.onended = () => {
          playbackCtx.close();
          resolve();
        };
        source.start();
      } catch (e) {
        console.error("Audio playback error", e);
        resolve();
      }
    });
  };

  const postApi = async <T,>(
    path: string,
    payload: unknown,
    options?: { timeoutMs?: number; retries?: number }
  ): Promise<T> => {
    const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : 15000;
    const retries = typeof options?.retries === 'number' ? options.retries : 2;

    try {
      return await retry(
        async (_attempt) => {
          const controller = new AbortController();
          const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

          try {
            const res = await fetch(`/api/${path}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });

            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
              const errorMessage = (json as any)?.error || '요청에 실패했습니다.';
              const detailMessage = (json as any)?.detail;
              const err: any = new Error(detailMessage ? `${errorMessage} (${detailMessage})` : errorMessage);
              err.status = res.status;
              throw err;
            }

            return json as T;
          } finally {
            window.clearTimeout(timeoutId);
          }
        },
        {
          retries,
          shouldRetry: (err) => {
            if (err instanceof DOMException && err.name === 'AbortError') return true;
            if (err instanceof TypeError) return true;
            const status = (err as any)?.status;
            if (status === 408 || status === 429) return true;
            if (typeof status === 'number' && status >= 500) return true;
            return false;
          },
        }
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new Error('요청 시간이 초과되었습니다.');
      }
      if (e instanceof TypeError) {
        throw new Error('네트워크 오류가 발생했습니다.');
      }
      throw e;
    }
  };

  const unreadVisionCount = visionNotifications.filter((n) => !n.isRead && n.status !== 'processing').length;

  const enqueueVisionToast = (id: string) => {
    setVisionToastIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [id, ...prev];
      return next.slice(0, 3);
    });

    if (toastTimeoutsRef.current[id]) {
      window.clearTimeout(toastTimeoutsRef.current[id]);
    }

    toastTimeoutsRef.current[id] = window.setTimeout(() => {
      setVisionToastIds((prev) => prev.filter((x) => x !== id));
      delete toastTimeoutsRef.current[id];
    }, 7000);
  };

  const dismissVisionToast = (id: string) => {
    setVisionToastIds((prev) => prev.filter((x) => x !== id));
    if (toastTimeoutsRef.current[id]) {
      window.clearTimeout(toastTimeoutsRef.current[id]);
      delete toastTimeoutsRef.current[id];
    }
  };

  const blobToBase64Data = async (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        resolve(dataUrl.split(',')[1] || '');
      };
      reader.onerror = () => reject(reader.error || new Error('이미지 변환에 실패했습니다.'));
      reader.readAsDataURL(blob);
    });
  };

  const openVisionNotification = (id: string) => {
    setActiveVisionNotificationId(id);
    setIsNotificationMenuOpen(false);
    setVisionNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    dismissVisionToast(id);
  };

  const handleVisionCaptured = (payload: { blob: Blob }) => {
    const createdAt = Date.now();
    const id = `vision_${createdAt}_${Math.random().toString(16).slice(2)}`;
    const langA = langInputRef.current.code;
    const langB = langOutputRef.current.code;

    const item: VisionNotification = {
      id,
      createdAt,
      status: 'processing',
      langA,
      langB,
      isRead: false,
    };

    setVisionNotifications((prev) => [item, ...prev]);

    blobToBase64Data(payload.blob)
      .then((base64Image) => {
        if (!base64Image) {
          throw new Error('이미지 변환에 실패했습니다.');
        }
        return postApi<VisionResult>('vision', {
          base64Image,
          langA,
          langB,
          model: MODEL_VISION,
        });
      })
      .then((result) => {
        setVisionNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, status: 'done', result } : n)));
        enqueueVisionToast(id);
      })
      .catch((e) => {
        const message = (e as Error)?.message || String(e);
        setVisionNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, status: 'error', error: message } : n)));
        enqueueVisionToast(id);
      });
  };

  const detectLanguageCode = async (text: string): Promise<string | null> => {
    try {
      const data = await postApi<{ code: string; confidence: number }>('detect-language', { text });
      if (data?.code && typeof data.confidence === 'number' && data.confidence >= 0.6) {
        return data.code;
      }
    } catch (e) {
      console.error('Language detection failed', e);
    }
    return null;
  };

  const handleOpenHistory = () => {
    const data = sessions;
    setLocalSessionsPreview(data);
    const fallbackId = data.length > 0 ? data[0].id : '';
    setSelectedLocalSessionId(currentSessionId || fallbackId);
    setDriveRestoreMessage('');
    setSelectedDriveSessionId('');

    if (accessToken) {
      setIsLoadingDriveSessions(true);
      listDriveSessions(accessToken, 20)
        .then((list) => {
          setDriveSessions(list || []);
        })
        .catch((e) => {
          console.error('Drive 세션 목록 조회 실패', e);
          setDriveSessions([]);
        })
        .finally(() => {
          setIsLoadingDriveSessions(false);
        });
    } else {
      setDriveSessions([]);
    }
    setIsHistoryModalOpen(true);
  };

  const handleRestoreFromDrive = async (includeAudio: boolean) => {
    if (!accessToken) {
      setIsLoginModalOpen(true);
      return;
    }
    if (!selectedDriveSessionId) return;

    setIsRestoringDriveSession(true);
    setDriveRestoreMessage('복원 중...');
    try {
      const result = await restoreDriveSession(accessToken, selectedDriveSessionId, includeAudio);

      if (result?.history) {
        const now = Date.now();
        const newId = `drive_${now}`;
        const newSession: ConversationSession = {
          id: newId,
          createdAt: now,
          updatedAt: now,
          items: result.history,
          title: result.sessionName || (result.history[0]?.original ? String(result.history[0].original).slice(0, 24) : 'Drive 세션'),
        };
        setSessions((prev) => [newSession, ...prev]);
        setCurrentSessionId(newId);
        isHydratingHistoryRef.current = true;
        setHistory(result.history);
      }

      if (includeAudio) {
        const voiceName = typeof result?.voiceName === 'string' ? result.voiceName : selectedVoice.name;
        const ttsModel = typeof result?.ttsModel === 'string' ? result.ttsModel : MODEL_TTS;

        const v = VOICE_OPTIONS.find(v => v.name === voiceName);
        if (v) {
          setSelectedVoice(v);
        }

        if (settings.audioCacheEnabled) {
          for (const item of result.history || []) {
            if (item.audioBase64) {
              const cacheKey = `${item.id}:${voiceName}:${ttsModel}`;
              const exists = await hasCachedAudio(cacheKey);
              if (!exists) {
                await setCachedAudioBase64(cacheKey, item.audioBase64);
              }
            }
          }
        }
      }

      setDriveRestoreMessage(result?.message || '복원을 완료했습니다.');
      setIsHistoryModalOpen(false);
    } catch (e) {
      console.error('Drive 복원 실패', e);
      setDriveRestoreMessage('복원에 실패했습니다.');
    } finally {
      setIsRestoringDriveSession(false);
    }
  };

  const handleLoadSessionFromLocal = () => {
    if (!selectedLocalSessionId) return;
    const target = localSessionsPreview.find((s) => s.id === selectedLocalSessionId);
    if (!target) return;
    setCurrentSessionId(target.id);
    isHydratingHistoryRef.current = true;
    setHistory([...(target.items || [])]);
    setIsHistoryModalOpen(false);
  };

  const handleClearLocalSessions = () => {
    clearSessions();
    setLocalSessionsPreview([]);
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
    isHydratingHistoryRef.current = true;
    setHistory([]);
  };

  const handleNewConversation = () => {
    const now = Date.now();
    const newId = `local_${now}`;
    const newSession: ConversationSession = {
      id: newId,
      createdAt: now,
      updatedAt: now,
      items: [],
      title: '새 대화',
    };
    setSessions((prev) => [newSession, ...prev]);
    setCurrentSessionId(newId);
    setSelectedLocalSessionId(newId);
    currentTurnTextRef.current = '';
    setCurrentTurnText('');
    isHydratingHistoryRef.current = true;
    setHistory([]);
  };

  const splitTextForTts = (text: string, maxLen: number): string[] => {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    if (normalized.length <= maxLen) return [normalized];

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

    const pushHardSplit = (s: string) => {
      for (let i = 0; i < s.length; i += maxLen) {
        const part = s.slice(i, i + maxLen).trim();
        if (part) chunks.push(part);
      }
    };

    for (const s of sentences) {
      if (!buf) {
        if (s.length <= maxLen) {
          buf = s;
        } else {
          pushHardSplit(s);
          buf = '';
        }
        continue;
      }

      const next = `${buf} ${s}`;
      if (next.length <= maxLen) {
        buf = next;
        continue;
      }

      chunks.push(buf);
      if (s.length <= maxLen) {
        buf = s;
      } else {
        pushHardSplit(s);
        buf = '';
      }
    }

    if (buf) chunks.push(buf);
    return chunks;
  };

  const playTTS = async (text: string, id?: string, notifyOnError: boolean = false): Promise<void> => {
    const normalized = String(text || '').trim();
    if (!normalized) return Promise.resolve();

    const cacheKey = id ? `${id}:${selectedVoice.name}:${MODEL_TTS}` : null;
    if (id) {
      const item = history.find(i => i.id === id);
      if (item?.audioBase64) {
        return playAudioFromBase64(item.audioBase64);
      }
    }
    if (id && cacheKey && settings.audioCacheEnabled) {
      const cached = await getCachedAudioBase64(cacheKey);
      if (cached) {
        setHistory(prev => prev.map(item =>
          item.id === id ? { ...item, audioBase64: cached } : item
        ));
        return playAudioFromBase64(cached);
      }
    }

    const MAX_TTS_CHARS = 200;
    const chunks = splitTextForTts(normalized, MAX_TTS_CHARS);
    if (chunks.length === 0) return Promise.resolve();

    try {
      const pcmChunks: Uint8Array[] = [];

      for (const chunk of chunks) {
        const data = await postApi<{ audioBase64: string }>('tts', {
          text: chunk,
          voiceName: selectedVoice.name,
          model: MODEL_TTS,
        });

        const base64Audio = data.audioBase64;
        if (!base64Audio) {
          throw new Error('TTS 오디오 생성 결과가 비어있습니다.');
        }

        pcmChunks.push(base64ToUint8Array(base64Audio));
        await playAudioFromBase64(base64Audio);
      }

      if (id) {
        const totalLen = pcmChunks.reduce((sum, x) => sum + x.byteLength, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const x of pcmChunks) {
          merged.set(x, offset);
          offset += x.byteLength;
        }
        const mergedBase64 = arrayBufferToBase64(merged.buffer);

        setHistory(prev => prev.map(item =>
          item.id === id ? { ...item, audioBase64: mergedBase64 } : item
        ));
        if (cacheKey && settings.audioCacheEnabled) {
          await setCachedAudioBase64(cacheKey, mergedBase64);
        }
      }
    } catch (e) {
      console.error("TTS failed", e);
      if (notifyOnError) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`TTS 실패: ${msg}`);
      }
    }
    return Promise.resolve();
  };

  const playAll = async () => {
    for (const item of history) {
      if (item.translated) {
        await playTTS(item.translated, item.id);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  };

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

  const startEditing = useCallback((item: ConversationItem) => {
    setEditingItemId(item.id);
    setEditOriginalText(item.original);
    setEditTranslatedText(item.translated);
  }, []);

  const handleSaveEdit = useCallback((id: string) => {
    setHistory(prev => prev.map(item => {
      if (item.id === id) {
        return {
          ...item,
          original: editOriginalText,
          translated: editTranslatedText,
          updatedAt: Date.now()
        };
      }
      return item;
    }));
    setEditingItemId(null);
  }, [editOriginalText, editTranslatedText, setHistory]);

  const handleMergeWithAbove = useCallback((id: string) => {
    setHistory(prev => {
      const idx = prev.findIndex(item => item.id === id);
      if (idx <= 0) return prev;
      const current = prev[idx];
      const above = prev[idx - 1];
      const merged: ConversationItem = {
        ...above,
        original: above.original + ' ' + current.original,
        translated: (above.translated || '') + ' ' + (current.translated || ''),
        updatedAt: Date.now(),
      };
      const next = [...prev];
      next.splice(idx - 1, 2, merged);
      return next;
    });
  }, [setHistory]);

  const handleSplitItem = useCallback((id: string, originalSplitIdx: number, translatedSplitIdx: number) => {
    setHistory(prev => {
      const idx = prev.findIndex(item => item.id === id);
      if (idx === -1) return prev;
      const current = prev[idx];

      const item1: ConversationItem = {
        ...current,
        id: crypto.randomUUID(),
        original: current.original.substring(0, originalSplitIdx).trim(),
        translated: current.translated.substring(0, translatedSplitIdx).trim(),
        updatedAt: Date.now(),
      };
      const item2: ConversationItem = {
        ...current,
        id: crypto.randomUUID(),
        original: current.original.substring(originalSplitIdx).trim(),
        translated: current.translated.substring(translatedSplitIdx).trim(),
        updatedAt: Date.now(),
      };

      const next = [...prev];
      next.splice(idx, 1, item1, item2);
      return next;
    });
    setEditingItemId(null);
  }, [setHistory]);

  const startOriginalRecording = useCallback((stream: MediaStream) => {
    if (!settings.recordOriginalEnabled) return;
    try {
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      originalAudioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          originalAudioChunksRef.current.push(e.data);
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(originalAudioChunksRef.current, { type: 'audio/webm' });
        console.log('Original recording saved. Size:', blob.size);
        // Save to state or auto-download for now to verify
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `original_session_${Date.now()}.webm`;
        // Optional: Auto download can be annoying, maybe we just save the URL
        // setLastRecordingUrl(url); 
      };
      recorder.start();
      originalMediaRecorderRef.current = recorder;
      setIsRecordingOriginal(true);
    } catch (err) {
      console.error('Failed to start original recording:', err);
    }
  }, [settings.recordOriginalEnabled]);

  const stopOriginalRecording = useCallback(() => {
    if (originalMediaRecorderRef.current && originalMediaRecorderRef.current.state !== 'inactive') {
      originalMediaRecorderRef.current.stop();
      originalMediaRecorderRef.current = null;
    }
    setIsRecordingOriginal(false);
  }, []);

  const connectToGemini = useCallback(async (opts?: { isRetry?: boolean }) => {
    let connectId = 0;
    const isCurrentAttempt = () => geminiConnectIdRef.current === connectId;

    try {
      const isRetry = opts?.isRetry === true;
      if (!isRetry) {
        setErrorMessage('');
        geminiMicDesiredRef.current = true;
        geminiReconnectAttemptRef.current = 0;
      }

      if (isGeminiConnectingRef.current) return;
      isGeminiConnectingRef.current = true;

      connectId = geminiConnectIdRef.current + 1;
      geminiConnectIdRef.current = connectId;

      if (geminiReconnectTimeoutRef.current) {
        window.clearTimeout(geminiReconnectTimeoutRef.current);
        geminiReconnectTimeoutRef.current = null;
      }

      cleanupAudio();
      setStatus(ConnectionStatus.CONNECTING);

      const tokenData = await postApi<{ token: string }>('live-token', { model: MODEL_LIVE });
      if (!geminiMicDesiredRef.current || !isCurrentAttempt()) {
        if (isCurrentAttempt()) {
          cleanupAudio();
          isGeminiConnectingRef.current = false;
        }
        return;
      }
      if (!tokenData?.token) {
        setStatus(ConnectionStatus.ERROR);
        setIsMicOn(false);
        setErrorMessage('토큰 발급 실패');
        geminiMicDesiredRef.current = false;
        if (isCurrentAttempt()) isGeminiConnectingRef.current = false;
        return;
      }
      const ai = new GoogleGenAI({ apiKey: tokenData.token, apiVersion: 'v1alpha' });

      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const inputCtx = inputAudioContextRef.current;
      const audioCtx = audioContextRef.current;
      await inputCtx?.resume();
      await audioCtx?.resume();
      if (!geminiMicDesiredRef.current || !isCurrentAttempt()) {
        if (isCurrentAttempt()) {
          cleanupAudio();
          isGeminiConnectingRef.current = false;
        }
        return;
      }

      const analyserNode = audioContextRef.current.createAnalyser();
      analyserNode.fftSize = 256;
      setAnalyser(analyserNode);

      const instruction = `
        You are a helpful assistant acting as a transcriber. 
        Your task is to listen to the user speaking in ${langInput.name}.
        Just listen and let the transcription engine handle the text.
      `;

      const scheduleReconnect = (reason?: unknown) => {
        if (!isCurrentAttempt()) return;
        if (!geminiMicDesiredRef.current) return;

        const attempt = geminiReconnectAttemptRef.current;
        const maxAttempts = 3;
        if (attempt >= maxAttempts) {
          geminiMicDesiredRef.current = false;
          setStatus(ConnectionStatus.ERROR);
          setIsMicOn(false);
          const msg = reason instanceof Error ? reason.message : String(reason || '연결 오류');
          setErrorMessage(msg);
          return;
        }

        const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        geminiReconnectAttemptRef.current = attempt + 1;
        setStatus(ConnectionStatus.CONNECTING);
        setIsMicOn(false);

        if (geminiReconnectTimeoutRef.current) {
          window.clearTimeout(geminiReconnectTimeoutRef.current);
        }

        geminiReconnectTimeoutRef.current = window.setTimeout(() => {
          connectToGeminiRef.current({ isRetry: true });
        }, delayMs);
      };

      const sessionPromise = ai.live.connect({
        model: MODEL_LIVE,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice.name } },
          },
          systemInstruction: instruction,
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: async () => {
            if (!geminiMicDesiredRef.current || !isCurrentAttempt()) {
              try {
                const session = await sessionPromise;
                session.close();
              } catch {
              }
              return;
            }
            console.log("Gemini Live Connected");
            setErrorMessage('');
            geminiReconnectAttemptRef.current = 0;
            if (geminiReconnectTimeoutRef.current) {
              window.clearTimeout(geminiReconnectTimeoutRef.current);
              geminiReconnectTimeoutRef.current = null;
            }
            setStatus(ConnectionStatus.CONNECTED);
            setIsMicOn(true);
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              if (!geminiMicDesiredRef.current || !isCurrentAttempt()) {
                stream.getTracks().forEach(track => track.stop());
                try {
                  const session = await sessionPromise;
                  session.close();
                } catch {
                }
                return;
              }
              streamRef.current = stream;
              if (!inputAudioContextRef.current || !audioContextRef.current) return;

              const source = inputAudioContextRef.current.createMediaStreamSource(stream);
              const inputGain = inputAudioContextRef.current.createGain();
              inputGain.gain.value = 1.5;
              source.connect(inputGain);

              const visSource = audioContextRef.current!.createMediaStreamSource(stream);
              const visGain = audioContextRef.current!.createGain();
              visGain.gain.value = 1.5;
              visSource.connect(visGain);
              visGain.connect(analyserNode);

              // --- Phase 2: Start Original Recording ---
              startOriginalRecording(stream);

              const processor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
              processorRef.current = processor;

              processor.onaudioprocess = (e) => {
                if (!geminiMicDesiredRef.current || !isCurrentAttempt()) return;
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createPcmBlob(inputData);
                if (sessionPromiseRef.current) {
                  sessionPromiseRef.current.then(session => {
                    session.sendRealtimeInput({ media: pcmBlob });
                  });
                }
              };

              inputGain.connect(processor);
              processor.connect(inputAudioContextRef.current.destination);
            } catch (err) {
              console.error("Mic Error:", err);
              if (isCurrentAttempt()) {
                cleanupAudio();
                setStatus(ConnectionStatus.ERROR);
                setIsMicOn(false);
                geminiMicDesiredRef.current = false;
              }
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            if (!isCurrentAttempt()) return;
            const transcription = message.serverContent?.inputTranscription?.text;
            if (transcription) {
              setCurrentTurnText(prev => {
                const next = prev + transcription;
                currentTurnTextRef.current = next;
                return next;
              });
            }

            if (message.serverContent?.turnComplete) {
              const finalText = currentTurnTextRef.current.trim();
              currentTurnTextRef.current = '';
              setCurrentTurnText('');

              if (!finalText) return;

              const curInput = langInputRef.current;
              const curOutput = langOutputRef.current;

              let fromLang = curInput;
              let toLang = curOutput;

              if (isLangAutoRef.current) {
                const detectedCode = await detectLanguageCode(finalText);
                if (detectedCode && detectedCode !== curInput.code) {
                  const detectedLang = SUPPORTED_LANGUAGES.find(l => l.code === detectedCode);
                  if (detectedLang) {
                    fromLang = detectedLang;
                    toLang = curInput;
                    setLangInput(detectedLang);
                    setLangOutput(curInput);
                  }
                }
              }

              const newItem: ConversationItem = {
                id: Date.now().toString(),
                original: finalText,
                translated: "",
                isTranslating: true,
                timestamp: Date.now()
              };

              setHistory(prev => [...prev, newItem]);
              translateText(newItem.original, newItem.id, fromLang, toLang);
            }
          },
          onclose: () => {
            if (!isCurrentAttempt()) return;
            console.log("Session Closed");
            cleanupAudio();
            setStatus(ConnectionStatus.DISCONNECTED);
            setIsMicOn(false);
            scheduleReconnect('세션이 종료되었습니다.');
          },
          onerror: (err) => {
            if (!isCurrentAttempt()) return;
            console.error("Session Error:", err);
            cleanupAudio();
            setStatus(ConnectionStatus.ERROR);
            setIsMicOn(false);
            scheduleReconnect(err);
          }
        }
      });
      sessionPromiseRef.current = sessionPromise;
      if (isCurrentAttempt()) isGeminiConnectingRef.current = false;
    } catch (error) {
      if (connectId !== 0 && !isCurrentAttempt()) {
        return;
      }
      if (!geminiMicDesiredRef.current) {
        cleanupAudio();
        isGeminiConnectingRef.current = false;
        return;
      }
      console.error("Connection setup failed:", error);
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(msg);
      cleanupAudio();
      setStatus(ConnectionStatus.ERROR);
      setIsMicOn(false);
      isGeminiConnectingRef.current = false;

      if (geminiMicDesiredRef.current) {
        const attempt = geminiReconnectAttemptRef.current;
        const maxAttempts = 3;
        if (attempt < maxAttempts) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
          geminiReconnectAttemptRef.current = attempt + 1;
          if (geminiReconnectTimeoutRef.current) {
            window.clearTimeout(geminiReconnectTimeoutRef.current);
          }
          geminiReconnectTimeoutRef.current = window.setTimeout(() => {
            connectToGeminiRef.current({ isRetry: true });
          }, delayMs);
        } else {
          geminiMicDesiredRef.current = false;
        }
      }
    }
  }, [langInput, langOutput, selectedVoice, cleanupAudio]);

  connectToGeminiRef.current = connectToGemini;

  const toggleMic = () => {
    if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING) {
      geminiMicDesiredRef.current = false;
      geminiConnectIdRef.current += 1;
      isGeminiConnectingRef.current = false;
      geminiReconnectAttemptRef.current = 0;
      if (geminiReconnectTimeoutRef.current) {
        window.clearTimeout(geminiReconnectTimeoutRef.current);
        geminiReconnectTimeoutRef.current = null;
      }
      if (sessionPromiseRef.current) {
        sessionPromiseRef.current.then(session => session.close());
      }
      cleanupAudio();
      stopOriginalRecording();
      setStatus(ConnectionStatus.DISCONNECTED);
      setIsMicOn(false);
    } else {
      connectToGemini();
    }
  };

  useEffect(() => {
    if (!isScrollLocked && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history, currentTurnText, isScrollLocked]);

  useLayoutEffect(() => {
    const pending = pendingHistoryExpandRef.current;
    if (!pending) return;
    pendingHistoryExpandRef.current = null;
    if (!historyRef.current) return;

    const newScrollHeight = historyRef.current.scrollHeight;
    const delta = newScrollHeight - pending.prevScrollHeight;
    historyRef.current.scrollTop = pending.prevScrollTop + delta;
  }, [historyRenderLimit]);

  useEffect(() => () => {
    geminiMicDesiredRef.current = false;
    geminiConnectIdRef.current += 1;
    isGeminiConnectingRef.current = false;
    if (geminiReconnectTimeoutRef.current) {
      window.clearTimeout(geminiReconnectTimeoutRef.current);
      geminiReconnectTimeoutRef.current = null;
    }
    cleanupAudio();
  }, [cleanupAudio]);

  return (
    <div className="h-full flex flex-col bg-slate-50 text-slate-900 font-sans overflow-hidden">

      {/* --- HEADER --- */}
      <header className="px-5 py-3 bg-white border-b border-gray-100 flex flex-col z-20 shadow-sm shrink-0 gap-2">
        <div className="flex items-center justify-between gap-3">
          {/* Title & Logo */}
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-sm">
              <GlobeIcon />
            </div>
            <div className="flex flex-col leading-tight">
              <h1 className="font-bold text-sm sm:text-md text-slate-800 whitespace-nowrap">{t.appTitle}</h1>
              <div className="text-[11px] text-slate-400 font-medium whitespace-nowrap hidden sm:block">{t.subtitle}</div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 justify-end">

            <button
              onClick={handleNewConversation}
              aria-label="새 대화"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 rounded-full shadow-sm hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 hover:shadow-md transition-all active:scale-95 text-xs font-bold text-gray-600 whitespace-nowrap"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <span className="hidden sm:inline">새 대화</span>
            </button>

            <button
              onClick={handleOpenHistory}
              aria-label="이전 히스토리"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 rounded-full shadow-sm hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 hover:shadow-md transition-all active:scale-95 text-xs font-bold text-gray-600 whitespace-nowrap"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="hidden sm:inline">이전 히스토리</span>
            </button>

            {/* Export Dropdown */}
            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
                aria-label={t.exportMenu}
                disabled={isExporting}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 rounded-full shadow-sm hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 hover:shadow-md transition-all active:scale-95 text-xs font-bold text-gray-600 whitespace-nowrap"
              >
                {isExporting ? (
                  <div className="w-4 h-4 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin"></div>
                ) : (
                  <ExportIcon />
                )}
                <span className="hidden sm:inline">{isExporting ? t.exporting : t.exportMenu}</span>
              </button>

              {isExportMenuOpen && (
                <div className="absolute top-full right-0 mt-2 w-56 bg-white rounded-xl shadow-xl border border-gray-100 py-1 z-50 animate-in fade-in zoom-in-95 duration-200">
                  <button onClick={() => handleExport('docs')} className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium border-b border-gray-50">
                    <DocsIcon /> {t.exportDocs}
                  </button>
                  <button onClick={() => handleExport('drive')} className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium border-b border-gray-50">
                    <DriveIcon /> {t.exportDrive}
                  </button>
                  <button onClick={() => handleExport('classroom')} className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium border-b border-gray-50">
                    <ClassroomIcon /> {t.exportClassroom}
                  </button>
                  <button onClick={() => handleExport('notebooklm')} className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium">
                    <NotebookLMIcon /> {t.exportNotebookLM}
                  </button>
                </div>
              )}
            </div>

            {!accessToken && (
              <span className="hidden sm:inline text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-3 py-1 whitespace-nowrap">
                Drive·Classroom 사용을 위해 Google 로그인이 필요합니다
              </span>
            )}

            <div className="relative" ref={notificationMenuRef}>
              <button
                onClick={() => setIsNotificationMenuOpen(!isNotificationMenuOpen)}
                aria-label="알림"
                className="relative flex items-center justify-center w-9 h-9 bg-white border border-gray-200 rounded-full shadow-sm hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 hover:shadow-md transition-all active:scale-95"
              >
                <BellIcon />
                {unreadVisionCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {unreadVisionCount}
                  </span>
                )}
              </button>

              {isNotificationMenuOpen && (
                <div className="absolute top-full right-0 mt-2 w-80 bg-white rounded-xl shadow-xl border border-gray-100 py-1 z-50 animate-in fade-in zoom-in-95 duration-200">
                  {visionNotifications.length === 0 ? (
                    <div className="px-4 py-3 text-xs text-gray-400">알림이 없습니다.</div>
                  ) : (
                    <div className="max-h-[60vh] overflow-y-auto">
                      {visionNotifications.slice(0, 20).map((n) => {
                        const statusLabel =
                          n.status === 'processing'
                            ? t.visionAnalyzing
                            : n.status === 'done'
                              ? t.exportSuccess
                              : t.visionFail;

                        const statusClass =
                          n.status === 'processing'
                            ? 'text-gray-500'
                            : n.status === 'done'
                              ? 'text-emerald-600'
                              : 'text-red-600';

                        const snippet =
                          n.status === 'done'
                            ? (n.result?.translatedText || n.result?.originalText || t.visionNoText).trim().slice(0, 60)
                            : n.status === 'error'
                              ? (n.error || t.visionFail).trim().slice(0, 60)
                              : '';

                        return (
                          <button
                            key={n.id}
                            onClick={() => openVisionNotification(n.id)}
                            className="w-full text-left px-4 py-3 hover:bg-indigo-50 hover:shadow-inner flex flex-col gap-1 border-b border-gray-50 last:border-0 transition-all group"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                {!n.isRead && n.status !== 'processing' ? (
                                  <span className="w-2 h-2 rounded-full bg-red-500 shrink-0 animate-pulse" />
                                ) : (
                                  <span className="w-2 h-2 rounded-full bg-transparent shrink-0" />
                                )}
                                <div className="text-xs font-bold text-gray-700 truncate group-hover:text-indigo-700 transition-colors">{t.visionTitle}</div>
                              </div>
                              <div className={`text-[10px] font-bold shrink-0 ${statusClass}`}>{statusLabel}</div>
                            </div>
                            {snippet ? (
                              <div className="text-[11px] text-gray-500 whitespace-pre-wrap break-words line-clamp-2 group-hover:text-gray-600 transition-colors">{snippet}</div>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* AUTH BUTTON */}
            {user && !user.isAnonymous ? (
              <div className="relative" ref={profileMenuRef}>
                <button
                  onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
                  aria-label="프로필 메뉴"
                  className="flex items-center gap-2 bg-gray-50 rounded-full pl-1 pr-2 py-1 border border-gray-200 whitespace-nowrap hover:bg-white hover:border-indigo-200 hover:shadow-md transition-all active:scale-95"
                >
                  {user.photoURL ? (
                    <img src={user.photoURL} alt="Profile" className="w-7 h-7 rounded-full" />
                  ) : (
                    <div className="w-7 h-7 bg-indigo-500 rounded-full text-white flex items-center justify-center text-xs">{user.email ? user.email[0] : (user.displayName ? user.displayName[0] : 'U')}</div>
                  )}
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {isProfileMenuOpen && (
                  <div className="absolute top-full right-0 mt-2 w-44 bg-white rounded-xl shadow-xl border border-gray-100 py-1 z-50 animate-in fade-in zoom-in-95 duration-200">
                    <button
                      onClick={openSettings}
                      className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium border-b border-gray-50"
                    >
                      <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      설정
                    </button>

                    {isAdmin && (
                      <button
                        onClick={() => {
                          setIsProfileMenuOpen(false);
                          setIsAdminPanelOpen(true);
                        }}
                        className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium border-b border-gray-50"
                      >
                        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622C17.176 19.29 21 14.59 21 9c0-1.042-.133-2.052-.382-3.016z" />
                        </svg>
                        관리자 모드
                      </button>
                    )}

                    <button
                      onClick={() => {
                        setIsProfileMenuOpen(false);
                        handleLogout();
                      }}
                      className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium"
                    >
                      <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                      </svg>
                      로그아웃
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => setIsLoginModalOpen(true)}
                aria-label="로그인"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 border border-indigo-700 rounded-full shadow-md hover:bg-indigo-700 hover:shadow-lg transition-all active:scale-95 text-xs font-bold text-white whitespace-nowrap"
              >
                {uiLangCode === 'ko' ? '로그인' : 'Login'}
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          {/* Voice Selector */}
          <div className="flex items-center bg-gray-100 rounded-full px-3 py-1.5 border border-gray-200 hover:bg-white hover:border-indigo-200 hover:shadow-sm transition-all group">
            <span className="text-[10px] text-gray-500 font-bold mr-2 uppercase tracking-wide whitespace-nowrap group-hover:text-indigo-500 transition-colors">{t.voiceLabel}</span>
            <select
              value={selectedVoice.name}
              onChange={(e) => {
                const v = VOICE_OPTIONS.find(v => v.name === e.target.value);
                if (v) setSelectedVoice(v);
              }}
              className="bg-transparent text-xs font-bold text-indigo-600 outline-none cursor-pointer w-20"
            >
              {VOICE_OPTIONS.map(v => (
                <option key={v.name} value={v.name}>{v.label} ({v.gender})</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsOutputOnly(!isOutputOnly)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 shadow-sm whitespace-nowrap ${isOutputOnly
                ? 'bg-indigo-600 border-indigo-700 text-white hover:bg-indigo-700 hover:shadow-md'
                : 'bg-white border-gray-200 text-gray-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 hover:shadow-md'
                }`}
            >
              출력만
            </button>

            {/* UI Language */}
            <div className="flex items-center gap-1 bg-white rounded-full px-2 py-1.5 border border-gray-200 cursor-pointer hover:bg-indigo-50 hover:border-indigo-200 hover:shadow-sm transition-all group min-w-[70px]">
              <div className="group-hover:text-indigo-500 transition-colors">
                <GlobeIcon />
              </div>
              <select
                value={uiLangCode}
                onChange={(e) => setUiLangCode(e.target.value)}
                className="bg-transparent text-xs font-medium text-gray-600 outline-none cursor-pointer w-full"
              >
                <option value="ko">한국어</option>
                <option value="en">Eng</option>
                <option value="ja">日本語</option>
                <option value="zh">中文</option>
                <option value="es">Esp</option>
              </select>
            </div>
          </div>
        </div>
      </header>

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

      {/* --- LANGUAGE & MODE CONTROLS --- */}
      <div className="bg-white px-4 py-4 shadow-sm z-10 flex flex-col gap-3 shrink-0">
        {/* Language Pair */}
        <div className="flex items-center justify-between gap-2 bg-gray-50 p-1.5 rounded-2xl border border-gray-200">
          {/* Input Language */}
          <div className="flex-1 flex flex-col items-center min-w-0 hover:bg-white hover:shadow-sm rounded-xl transition-all cursor-pointer group py-1">
            <span className="text-[10px] text-gray-800 font-bold mb-1 whitespace-nowrap group-hover:text-indigo-600 transition-colors">{t.inputLang}</span>
            <div className="w-full relative px-2 py-1">
              <select
                value={langInput.code}
                onChange={(e) => {
                  isLangAutoRef.current = false;
                  const l = SUPPORTED_LANGUAGES.find(l => l.code === e.target.value);
                  if (l) setLangInput(l);
                }}
                className="opacity-0 absolute inset-0 w-full h-full z-10 cursor-pointer"
              >
                {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
              </select>
              <div className="text-sm font-bold text-gray-900 truncate max-w-[120px] sm:max-w-xs text-center group-hover:scale-105 transition-transform">
                {langInput.flag} {langInput.name}
              </div>
            </div>
          </div>

          <div className="text-gray-300 shrink-0"><ArrowRightIcon /></div>

          {/* Output Language */}
          <div className="flex-1 flex flex-col items-center min-w-0 hover:bg-white hover:shadow-sm rounded-xl transition-all cursor-pointer group py-1">
            <span className="text-[10px] text-gray-800 font-bold mb-1 whitespace-nowrap group-hover:text-indigo-600 transition-colors">{t.outputLang}</span>
            <div className="w-full relative px-2 py-1">
              <select
                value={langOutput.code}
                onChange={(e) => {
                  isLangAutoRef.current = false;
                  const l = SUPPORTED_LANGUAGES.find(l => l.code === e.target.value);
                  if (l) setLangOutput(l);
                }}
                className="opacity-0 absolute inset-0 w-full h-full z-10 cursor-pointer"
              >
                {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
              </select>
              <div className="text-sm font-bold text-gray-900 truncate max-w-[120px] sm:max-w-xs text-center group-hover:scale-105 transition-transform">
                {langOutput.flag} {langOutput.name}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* --- MAIN LIST AREA (Split View) --- */}
      <div className="flex-1 overflow-hidden relative bg-slate-50 flex flex-col">
        {/* Visualizer Background */}
        <div className="absolute top-0 left-0 right-0 h-32 opacity-30 pointer-events-none z-0">
          <Visualizer analyser={analyser} isActive={isMicOn} color="#6366f1" />
        </div>

        {/* Scrollable Content */}
        <div
          ref={historyRef}
          className="flex-1 overflow-y-auto p-4 z-10 relative scroll-smooth"
        >
          {history.length === 0 && !currentTurnText && (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 text-center px-6 opacity-60">
              <MicIcon />
              <p className="mt-4 whitespace-pre-wrap text-sm">{t.emptyHint}</p>
              <div className="mt-4 w-full max-w-xl text-left space-y-2 text-[12px] text-gray-500 bg-white/80 border border-gray-200 rounded-2xl p-4 shadow-sm">
                <div className="font-bold text-gray-700 text-sm">빠른 안내</div>
                <ul className="list-disc list-inside space-y-1">
                  <li>마이크 버튼을 눌러 실시간 번역을 시작하세요.</li>
                  <li>Google 로그인 시 Drive 백업·Classroom 제출·Docs 저장 기능 사용 가능.</li>
                  <li>칠판 촬영(비전)으로 사진 속 텍스트를 감지해 번역합니다.</li>
                  <li>자동 읽기/자동 스크롤 토글로 듣기/보기 방식을 선택하세요.</li>
                </ul>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                    <div className="font-bold text-gray-700">단축키</div>
                    <div className="mt-1 text-gray-500">스페이스: 마이크 on/off<br />Enter: 최근 번역 듣기</div>
                  </div>
                  <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                    <div className="font-bold text-gray-700">모바일 팁</div>
                    <div className="mt-1 text-gray-500">하단 고정 버튼으로 한 손 조작, 세로 모드 최적화</div>
                  </div>
                </div>
              </div>
              <button
                onClick={toggleMic}
                className="mt-6 px-6 py-3 rounded-full bg-indigo-600 text-white text-sm font-bold shadow-lg hover:bg-indigo-700 hover:shadow-xl hover:-translate-y-0.5 transition-all active:scale-95"
              >
                {status === ConnectionStatus.CONNECTING
                  ? t.connecting
                  : status === ConnectionStatus.ERROR
                    ? t.retry
                    : t.statusStandby}
              </button>
            </div>
          )}

          <div className="flex flex-col gap-4">
            {(status === ConnectionStatus.CONNECTING || status === ConnectionStatus.ERROR) && (
              <div
                className={`px-4 py-3 rounded-xl border shadow-sm flex items-start justify-between gap-3 ${status === ConnectionStatus.ERROR
                  ? 'bg-red-50 border-red-200'
                  : 'bg-indigo-50 border-indigo-100'
                  }`}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-xs font-bold flex items-center gap-2 ${status === ConnectionStatus.ERROR ? 'text-red-700' : 'text-indigo-700'
                      }`}
                  >
                    {status === ConnectionStatus.CONNECTING && (
                      <div className="w-4 h-4 border-2 border-indigo-300 border-t-indigo-700 rounded-full animate-spin" />
                    )}
                    <span>
                      {status === ConnectionStatus.CONNECTING ? t.connecting : t.connectionError}
                    </span>
                  </div>
                  {status === ConnectionStatus.ERROR && !!errorMessage && (
                    <div className="mt-1 text-xs text-red-700/80 break-words">{errorMessage}</div>
                  )}
                </div>
                {status === ConnectionStatus.ERROR && (
                  <button
                    onClick={() => {
                      setErrorMessage('');
                      connectToGemini();
                    }}
                    className="shrink-0 px-3 py-1.5 rounded-full bg-red-600 text-white text-xs font-bold hover:bg-red-700 transition-colors"
                  >
                    {t.retry}
                  </button>
                )}
              </div>
            )}

            {hiddenHistoryCount > 0 && (
              <div className="flex justify-center">
                <button
                  onClick={handleLoadMoreHistory}
                  className="px-4 py-2 rounded-full bg-white border border-gray-200 shadow-sm hover:bg-gray-50 transition-colors text-xs font-bold text-gray-600"
                >
                  {t.loadMoreHistory}
                </button>
              </div>
            )}

            {visibleHistory.map((item) => {
              if (isOutputOnly) {
                return (
                  <div key={item.id} className="group border-b border-gray-100 pb-4 last:border-0 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div
                      className={`relative p-4 rounded-xl shadow-sm flex flex-col justify-between transition-colors ${item.isTranslating ? 'bg-gray-100 border border-gray-200' : 'bg-indigo-50 border border-indigo-100'
                        } ${!item.isTranslating && item.translated ? 'cursor-pointer hover:bg-indigo-100 active:scale-[0.99]' : ''
                        }`}
                      onClick={() => {
                        if (editingItemId === item.id) return;
                        if (!item.isTranslating && item.translated) {
                          playTTS(item.translated, item.id, true);
                        }
                      }}
                    >
                      {editingItemId === item.id ? (
                        <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
                          <textarea
                            value={editTranslatedText}
                            onChange={(e) => setEditTranslatedText(e.target.value)}
                            className="w-full p-3 rounded-lg border border-indigo-200 text-sm md:text-base outline-none focus:ring-2 focus:ring-indigo-100 min-h-[100px]"
                            autoFocus
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => setEditingItemId(null)}
                              className="px-3 py-1.5 rounded-full bg-gray-100 text-gray-600 text-xs font-bold hover:bg-gray-200 transition-all active:scale-95"
                            >
                              취소
                            </button>
                            <button
                              onClick={() => handleSaveEdit(item.id)}
                              className="px-3 py-1.5 rounded-full bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 hover:shadow-md transition-all active:scale-95"
                            >
                              저장
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {!item.isTranslating && (
                            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleMergeWithAbove(item.id);
                                }}
                                className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                title="위 항목과 병합"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 11l7-7 7 7M5 19l7-7 7 7" /></svg>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startEditing(item);
                                }}
                                className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                title="수정"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                              </button>
                            </div>
                          )}
                          {item.isTranslating ? (
                            <div className="flex gap-1 h-6 items-center">
                              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></div>
                              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-75"></div>
                              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-150"></div>
                            </div>
                          ) : (
                            <span className="text-indigo-900 font-medium leading-relaxed text-sm md:text-base">{item.translated}</span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div key={item.id} className="group relative grid grid-cols-2 gap-4 items-stretch border-b border-gray-100 pb-4 last:border-0 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  {editingItemId === item.id ? (
                    <div className="col-span-2 space-y-4 bg-white p-4 rounded-xl border border-indigo-100 shadow-sm" onClick={(e) => e.stopPropagation()}>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-gray-400 uppercase">Original</label>
                          <textarea
                            value={editOriginalText}
                            onChange={(e) => setEditOriginalText(e.target.value)}
                            className="w-full p-3 rounded-lg border border-gray-100 bg-gray-50 text-sm outline-none focus:border-indigo-300 min-h-[120px]"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-indigo-400 uppercase">Translated</label>
                          <textarea
                            value={editTranslatedText}
                            onChange={(e) => setEditTranslatedText(e.target.value)}
                            className="w-full p-3 rounded-lg border border-indigo-100 bg-indigo-50/30 text-sm outline-none focus:ring-2 focus:ring-indigo-100 min-h-[120px]"
                          />
                        </div>
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <div className="flex gap-2">
                          <button
                            onClick={(e) => {
                              const origArea = (e.currentTarget.parentElement?.parentElement?.parentElement?.querySelector('textarea') as HTMLTextAreaElement);
                              const transArea = (e.currentTarget.parentElement?.parentElement?.parentElement?.querySelectorAll('textarea')[1] as HTMLTextAreaElement);
                              handleSplitItem(item.id, origArea.selectionStart, transArea.selectionStart);
                            }}
                            className="px-3 py-1.5 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-bold hover:bg-indigo-100 transition-all active:scale-95 border border-indigo-100"
                          >
                            여기서 나누기
                          </button>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setEditingItemId(null)}
                            className="px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-xs font-bold hover:bg-gray-200 transition-all active:scale-95"
                          >
                            취소
                          </button>
                          <button
                            onClick={() => handleSaveEdit(item.id)}
                            className="px-4 py-2 rounded-full bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 hover:shadow-md transition-all active:scale-95"
                          >
                            저장
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      {!item.isTranslating && (
                        <div className="absolute top-0 right-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMergeWithAbove(item.id);
                            }}
                            className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                            title="위 항목과 병합"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 11l7-7 7 7M5 19l7-7 7 7" /></svg>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditing(item);
                            }}
                            className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                            title="수정"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                          </button>
                        </div>
                      )}
                      <div className="bg-white border border-gray-200 p-4 rounded-xl shadow-sm text-gray-800 leading-relaxed text-sm md:text-base">
                        {item.original}
                      </div>
                      <div
                        className={`relative p-4 rounded-xl shadow-sm flex flex-col justify-between transition-colors ${item.isTranslating ? 'bg-gray-100 border border-gray-200' : 'bg-indigo-50 border border-indigo-100'
                          } ${!item.isTranslating && item.translated ? 'cursor-pointer hover:bg-indigo-100 active:scale-[0.99]' : ''
                          }`}
                        onClick={() => {
                          if (!item.isTranslating && item.translated) {
                            playTTS(item.translated, item.id);
                          }
                        }}
                      >
                        {item.isTranslating ? (
                          <div className="flex gap-1 h-6 items-center">
                            <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></div>
                            <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-75"></div>
                            <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-150"></div>
                          </div>
                        ) : (
                          <span className="text-indigo-900 font-medium leading-relaxed text-sm md:text-base">{item.translated}</span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            {/* Live Transcription Placeholder (Left Side) */}
            {currentTurnText && (
              isOutputOnly ? (
                <div className="opacity-70">
                  <div className="flex items-center justify-center text-gray-300 text-sm italic border border-gray-200 border-dashed p-4 rounded-xl bg-white">
                    ...
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4 opacity-70">
                  <div className="bg-gray-50 border border-gray-300 border-dashed p-4 rounded-xl text-gray-600 italic animate-pulse">
                    {currentTurnText}
                  </div>
                  <div className="flex items-center justify-center text-gray-300 text-sm italic">
                    ...
                  </div>
                </div>
              )
            )}
          </div>

          <div className="h-20"></div> {/* Spacer for bottom bar */}
        </div>
      </div>

      {/* --- BOTTOM CONTROLS --- */}
      <div className="bg-white px-6 py-4 rounded-t-[2rem] shadow-[0_-5px_20px_rgba(0,0,0,0.05)] flex items-center justify-between z-30 shrink-0">

        <div className="flex items-center gap-0">
          <button
            onClick={() => setIsAutoPlay(!isAutoPlay)}
            className={`flex flex-col items-center gap-1 transition-all active:scale-90 w-16 group ${isAutoPlay ? 'text-indigo-600' : 'text-gray-500'
              }`}
          >
            <div className={`p-3 rounded-full shadow-sm group-hover:shadow-md transition-all ${isAutoPlay ? 'bg-indigo-100 group-hover:bg-indigo-200' : 'bg-gray-100 group-hover:bg-gray-200'
              }`}>
              <SpeakerIcon />
            </div>
            <span className="text-[10px] font-bold group-hover:text-indigo-600 transition-colors">{t.autoPlay}</span>
          </button>

          <button
            onClick={() => setIsScrollLocked(!isScrollLocked)}
            className={`flex flex-col items-center gap-1 transition-all active:scale-90 w-16 group ${!isScrollLocked ? 'text-indigo-600' : 'text-gray-500'
              }`}
          >
            <div className={`p-3 rounded-full shadow-sm group-hover:shadow-md transition-all ${!isScrollLocked ? 'bg-indigo-100 group-hover:bg-indigo-200' : 'bg-gray-100 group-hover:bg-gray-200'
              }`}>
              {isScrollLocked ? (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 002-2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              ) : (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                </svg>
              )}
            </div>
            <span className="text-[10px] font-bold group-hover:text-indigo-600 transition-colors">자동스크롤</span>
          </button>
        </div>

        {/* Main Mic */}
        <button
          onClick={toggleMic}
          className={`w-20 h-20 -mt-10 rounded-full flex items-center justify-center shadow-xl border-4 border-white transition-all transform hover:scale-110 hover:brightness-110 active:scale-95 ${status === ConnectionStatus.CONNECTED
            ? 'bg-red-500 text-white shadow-red-200 ring-4 ring-red-50'
            : 'bg-indigo-600 text-white shadow-indigo-200 ring-4 ring-indigo-50'
            }`}
        >
          {status === ConnectionStatus.CONNECTING ? (
            <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
          ) : status === ConnectionStatus.CONNECTED ? (
            <MicOffIcon />
          ) : (
            <MicIcon />
          )}
        </button>

        <div className="flex items-center gap-0">
          <button
            onClick={playAll}
            className="flex flex-col items-center gap-1 text-gray-500 transition-all active:scale-90 w-16 group"
          >
            <div className="p-3 bg-gray-100 rounded-full shadow-sm group-hover:bg-indigo-100 group-hover:text-indigo-600 group-hover:shadow-md transition-all">
              <PlayAllIcon />
            </div>
            <span className="text-[10px] font-bold group-hover:text-indigo-600 transition-colors">{t.playAll}</span>
          </button>

          <button
            onClick={() => setIsCameraOpen(true)}
            className="flex flex-col items-center gap-1 text-gray-500 transition-all active:scale-90 w-16 group"
          >
            <div className="p-3 bg-gray-100 rounded-full shadow-sm group-hover:bg-emerald-100 group-hover:text-emerald-600 group-hover:shadow-md transition-all">
              <CameraIcon />
            </div>
            <span className="text-[10px] font-bold group-hover:text-emerald-600 transition-colors">{t.visionButton}</span>
          </button>
        </div>
      </div>

      <CameraView
        isOpen={isCameraOpen}
        onClose={() => setIsCameraOpen(false)}
        onCaptured={handleVisionCaptured}
        t={t}
      />

      {activeVisionNotificationId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
              <h2 className="text-lg font-bold text-gray-800">{t.visionTitle}</h2>
              <button
                onClick={() => setActiveVisionNotificationId(null)}
                className="text-gray-400 hover:text-gray-600 p-1 bg-white rounded-full shadow-sm"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            {(() => {
              const n = visionNotifications.find((x) => x.id === activeVisionNotificationId);
              if (!n) {
                return <div className="p-6 text-sm text-gray-500">알림을 찾을 수 없습니다.</div>;
              }

              if (n.status === 'processing') {
                return <div className="p-6 text-sm text-gray-500">{t.visionAnalyzing}</div>;
              }

              if (n.status === 'error') {
                return (
                  <div className="p-6 space-y-2">
                    <div className="text-sm font-bold text-red-600">{t.visionFail}</div>
                    <div className="text-xs text-gray-500 whitespace-pre-wrap break-words">{n.error || t.visionError}</div>
                  </div>
                );
              }

              const originalText = (n.result?.originalText || '').trim();
              const translatedText = (n.result?.translatedText || '').trim();

              return (
                <div className="p-6 space-y-4 overflow-y-auto">
                  <div>
                    <div className="text-xs font-bold text-gray-500 mb-1">{t.visionDetected}</div>
                    <div className="bg-gray-50 border border-gray-200 p-4 rounded-xl text-sm text-gray-800 whitespace-pre-wrap break-words">
                      {originalText || t.visionNoText}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-gray-500 mb-1">{t.visionTranslated}</div>
                    <div className="bg-indigo-50 border border-indigo-100 p-4 rounded-xl text-sm text-indigo-900 whitespace-pre-wrap break-words">
                      {translatedText || t.visionNoText}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* --- LOGIN MODAL --- */}
      {isLoginModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden flex flex-col p-6" role="dialog" aria-label="로그인">
            <div className="text-center mb-6">
              <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-3 text-indigo-600">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" /></svg>
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
                    value={emailAuthEmail}
                    onChange={(e) => setEmailAuthEmail(e.target.value)}
                    placeholder="이메일"
                    autoComplete="email"
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white transition-all shadow-sm"
                  />
                  <input
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
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                </div>
                <div>
                  <h3 className="font-bold text-gray-700 group-hover:text-gray-900 transition-colors">{t.loginGuest}</h3>
                  <p className="text-xs text-gray-400 mt-0.5 group-hover:text-gray-500 transition-colors">{t.loginGuestDesc}</p>
                </div>
              </button>
            </div>

            <button
              onClick={() => setIsLoginModalOpen(false)}
              className="mt-6 text-sm text-gray-400 hover:text-indigo-600 transition-colors underline font-bold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* --- 히스토리 모달 --- */}
      {isHistoryModalOpen && (
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
                onClick={() => setIsHistoryModalOpen(false)}
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
                  <div className="text-xs text-gray-500">로컬 세션: <span className="font-bold text-gray-800">{localSessionsPreview.length}</span></div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleLoadSessionFromLocal}
                      disabled={!selectedLocalSessionId || localSessionsPreview.length === 0}
                      className="px-3 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 shadow-sm whitespace-nowrap bg-indigo-600 border-indigo-700 text-white hover:bg-indigo-700 hover:shadow-md disabled:opacity-40"
                    >
                      불러오기
                    </button>

                    <button
                      onClick={handleClearLocalSessions}
                      disabled={localSessionsPreview.length === 0}
                      className="px-3 py-1.5 rounded-full text-xs font-bold border transition-all active:scale-95 shadow-sm whitespace-nowrap bg-white border-gray-200 text-gray-500 hover:bg-red-50 hover:border-red-200 hover:text-red-600 hover:shadow-md disabled:opacity-40"
                    >
                      삭제
                    </button>
                  </div>
                </div>

                {localSessionsPreview.length === 0 ? (
                  <div className="text-center py-6 text-gray-400 text-sm">저장된 로컬 세션이 없습니다.</div>
                ) : (
                  <div className="space-y-2">
                    {localSessionsPreview
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
                          </div>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {isSettingsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
              <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                설정
              </h2>

              <button
                onClick={() => setIsSettingsModalOpen(false)}
                className="text-gray-400 hover:text-indigo-600 p-1 bg-white rounded-full shadow-sm hover:shadow-md transition-all active:scale-95"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="p-6 space-y-6">
              <div className="space-y-2">
                <div className="text-sm font-bold text-gray-800">Drive 백업 방식</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSettings(prev => ({ ...prev, driveBackupMode: 'manual' }))}
                    className={`flex-1 px-3 py-2 rounded-xl text-sm font-bold border transition-all active:scale-95 shadow-sm ${settings.driveBackupMode === 'manual'
                      ? 'bg-indigo-600 border-indigo-700 text-white shadow-indigo-100'
                      : 'bg-white border-gray-200 text-gray-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600'
                      }`}
                  >
                    수동
                  </button>
                  <button
                    onClick={() => setSettings(prev => ({ ...prev, driveBackupMode: 'auto' }))}
                    className={`flex-1 px-3 py-2 rounded-xl text-sm font-bold border transition-all active:scale-95 shadow-sm ${settings.driveBackupMode === 'auto'
                      ? 'bg-indigo-600 border-indigo-700 text-white shadow-indigo-100'
                      : 'bg-white border-gray-200 text-gray-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600'
                      }`}
                  >
                    자동
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-bold text-gray-800">음성 캐시(IndexedDB)</div>
                <button
                  onClick={() => setSettings(prev => ({ ...prev, audioCacheEnabled: !prev.audioCacheEnabled }))}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all active:scale-[0.98] shadow-sm ${settings.audioCacheEnabled
                    ? 'bg-indigo-600 border-indigo-700 text-white shadow-indigo-100'
                    : 'bg-white border-gray-200 text-gray-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600'
                    }`}
                >
                  <span className="text-sm font-bold">사용</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${settings.audioCacheEnabled ? 'bg-white/20' : 'bg-gray-100 text-gray-400'}`}>{settings.audioCacheEnabled ? 'ON' : 'OFF'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- CLASSROOM MODAL --- */}
      {isClassroomModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
              <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                <ClassroomIcon /> {t.selectCourse}
              </h2>
              <button
                onClick={() => setIsClassroomModalOpen(false)}
                className="text-gray-400 hover:text-indigo-600 p-1 bg-white rounded-full shadow-sm hover:shadow-md transition-all active:scale-95"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-4">
              {isLoadingCourses ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                  <div className="w-8 h-8 border-2 border-indigo-200 border-t-indigo-500 rounded-full animate-spin mb-3"></div>
                  <p className="text-sm">{t.fetchingCourses}</p>
                </div>
              ) : courses.length === 0 ? (
                <div className="text-center py-10 text-gray-400">
                  <p>{t.noCourses}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {courses.map((course) => (
                    <button
                      key={course.id}
                      onClick={() => handleSubmitCourseWork(course.id)}
                      disabled={isExporting}
                      className="w-full flex items-center justify-between p-3 rounded-xl border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 transition-all group text-left"
                    >
                      <div>
                        <h3 className="font-bold text-gray-800 group-hover:text-indigo-700">{course.name}</h3>
                        <p className="text-xs text-gray-500">{course.section}</p>
                      </div>
                      {isExporting ? (
                        <div className="w-4 h-4 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin"></div>
                      ) : (
                        <div className="text-gray-300 group-hover:text-indigo-500"><ArrowRightIcon /></div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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

    </div>
  );
}

