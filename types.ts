declare global {
  var google: any;
}

export interface Language {
  code: string;
  name: string;
  flag: string; // Emoji
}

export interface VisionResult {
  originalText: string;
  translatedText: string;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

// Conversation Item Structure
export interface GlossaryEntry {
  source: string;
  target: string;
}

// One translation produced for a specific target language.
export interface TranslationVariant {
  text: string;
  kind?: 'live' | 'manual';
  stale?: boolean;
  updatedAt?: number;
}

export interface ConversationItem {
  id: string;
  original: string;
  translated: string;
  isTranslating: boolean;
  timestamp: number;
  sourceKind?: 'voice' | 'text' | 'image';
  originalRaw?: string;
  translationKind?: 'live' | 'manual';
  translationStale?: boolean;
  /** Authoritative detected source language (BCP-47), when known. */
  sourceLanguage?: string;
  /** Per-target translations keyed by target language code. */
  translations?: Record<string, TranslationVariant>;
  /** Which translation key to display when several targets exist. */
  activeTarget?: string;
  /**
   * Technical answer assist state (#62), bound to this utterance's identity so
   * a late response can never land on another row.
   *
   * `suggestedAnswer` is written in `answerLanguage`, which follows the
   * finalized transcript/source language (#70).
   */
  answerStatus?: 'loading' | 'ready' | 'none' | 'error';
  suggestedAnswer?: string;
  answerLanguage?: string;
  /**
   * Automatic translation of `suggestedAnswer` into the row's active
   * question-translation target. The result is cached on this utterance and
   * dropped/replaced when the answer text or active target changes.
   */
  answerTranslationStatus?: 'idle' | 'loading' | 'ready' | 'error';
  answerTranslation?: string;
  answerTranslationLanguage?: string;
  /** The `suggestedAnswer` text the cached translation was produced from. */
  answerTranslationSource?: string;
  answerTranslationVisible?: boolean;
  audioBase64?: string; // Cache for TTS audio (in-memory)
  /**
   * Provenance of `audioBase64`: `<target>:<textHash>:<voice>:<model>` of the
   * translation variant it was generated for. Audio without a provenance that
   * matches the currently displayed variant must never be replayed (#34).
   */
  audioProvenance?: string;
  audioUrl?: string; // Firebase Storage URL
  updatedAt?: number;
  ttsStatus?: 'loading' | 'playing' | 'paused' | 'error';
}

export interface ConversationSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  items: ConversationItem[];
  title?: string;
  /** Cached one- or two-sentence AI description of this saved session. */
  summary?: string;
}

export interface VoiceOption {
  name: string;
  label: string;
  gender: 'Male' | 'Female';
  style: string;
}

export interface TranslationMap {
  appTitle: string;
  subtitle: string;
  inputLang: string;
  outputLang: string;
  autoPlay: string;
  playAll: string;
  statusListening: string;
  statusStandby: string;
  connectionError: string;
  retry: string;
  connecting: string;
  visionButton: string;
  visionTitle: string;
  visionDetected: string;
  visionTranslated: string;
  visionRetake: string;
  visionAnalyzing: string;
  visionNoText: string;
  visionFail: string;
  visionError: string;
  voiceLabel: string;
  emptyHint: string;
  loadMoreHistory: string;
  // Export & Login
  exportMenu: string;
  exportDocs: string;
  exportDrive: string;
  exportClassroom: string;
  exportNotebookLM: string;
  loginRequired: string; // Generic
  loginRequiredDrive: string; // Specific for Drive
  loginRequiredClassroom: string; // Specific for Classroom
  loginUnavailable: string;
  offlineMode: string;
  exporting: string;
  exportSuccess: string;
  // Classroom UI
  selectCourse: string;
  fetchingCourses: string;
  noCourses: string;
  submitTo: string;
  // Login Modal
  loginModalTitle: string;
  loginGoogle: string;
  loginGoogleDesc: string;
  loginGuest: string;
  loginGuestDesc: string;
  copySuccess: string;
  noAudioToExport: string;
  downloadCombinedAudio: string;
  autoScroll: string;
  guideTitle: string;
  guideMic: string;
  guideDrive: string;
  guideVision: string;
  guideAuto: string;
  shortcutTitle: string;
  shortcutSpace: string;
  mobileTipTitle: string;
  mobileTipDesc: string;
}

export type VisionNotificationStatus = 'capturing' | 'analyzing' | 'translating' | 'done' | 'error';

/**
 * 통역 입력 소스 (#114):
 * - mic: 브라우저 마이크 (기존 동작)
 * - system: 화면 공유 오디오(탭·시스템 소리)만
 * - both: 마이크 + 화면 공유 오디오를 섞어서
 */
export type AudioInputMode = 'mic' | 'system' | 'both';

export interface VisionNotification {
  id: string;
  timestamp: number;
  status: VisionNotificationStatus;
  isRead: boolean;
  result?: VisionResult;
  interviewImported?: boolean;
  error?: string;
}

export interface AppSettings {
  driveBackupMode: 'manual' | 'auto';
  audioCacheEnabled: boolean;
  recordOriginalEnabled: boolean;
  userApiKey?: string;
  translationModel?: string;
  savedApiKeys?: string[]; // 로컬에만 저장하는 즐겨찾기 키 슬롯
  /** Interview mode: selected output target language set. */
  interviewTargets?: string[];
  /** 일반 통역의 입력 소스 (#114). 기본값 mic. */
  audioInputMode?: AudioInputMode;
}