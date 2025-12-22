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
export interface ConversationItem {
  id: string;
  original: string;
  translated: string;
  isTranslating: boolean;
  timestamp: number;
  audioBase64?: string; // Cache for TTS audio (in-memory)
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

export interface VisionNotification {
  id: string;
  timestamp: number;
  status: VisionNotificationStatus;
  isRead: boolean;
  result?: VisionResult;
  error?: string;
}

export interface AppSettings {
  driveBackupMode: 'manual' | 'auto';
  audioCacheEnabled: boolean;
  recordOriginalEnabled: boolean;
  userApiKey?: string;
}