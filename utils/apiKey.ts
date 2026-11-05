// #120: personal key > class key > shared server trial key.
//
// Selection happens in exactly one place (this module) and the server only
// ever sees whether `x-user-api-key` rides along — personal and class keys are
// indistinguishable server-side, and both exempt a request from the shared
// trial counter. Keys live in this browser's localStorage only (#32 contract);
// the server never stores or sees key material.

const DEVICE_ID_STORAGE_KEY = 'padiem.deviceId';
const TRIAL_SESSION_STORAGE_KEY = 'padiem.trialSession';
const CLASS_API_KEY_STORAGE_KEY = 'padiem.classApiKey';
const TRIAL_COUNT_STORAGE_KEY = 'padiem.trialCount';

/** 서버 상수와 동일(대표 확정 전 기본값): 기기 누적 맛보기 한도. */
export const TRIAL_DEVICE_LIMIT = 30;

function randomToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID().replace(/-/g, '');
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/** 기기 번호: 최초 접근 때 발급해 이 브라우저에 고정한다(맛보기 계수 단위). */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (!id) {
      id = randomToken();
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return 'no-storage-device';
  }
}

function getTrialSessionId(): string {
  try {
    let id = sessionStorage.getItem(TRIAL_SESSION_STORAGE_KEY);
    if (!id) {
      id = randomToken();
      sessionStorage.setItem(TRIAL_SESSION_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return 'no-storage-session';
  }
}

/** 반 키: 교사가 배포한 키를 학생이 설정에 한 번 넣는다(브라우저 저장만). */
export function getClassApiKey(): string {
  try {
    return localStorage.getItem(CLASS_API_KEY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setClassApiKey(value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(CLASS_API_KEY_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(CLASS_API_KEY_STORAGE_KEY);
    }
    // A key arriving makes the local trial counter meaningless; clear it.
    localStorage.removeItem(TRIAL_COUNT_STORAGE_KEY);
  } catch {
    /* 사파리 사생모드 등: 설정은 유지되지 않지만 호출은 계속된다 */
  }
}

export interface ApiKeySettings {
  userApiKey?: string | null;
}

/** 개인 키 > 반 키 > ''(헤더 미전송 = 서버 공용 맛보기). */
export function resolveApiKey(settings?: ApiKeySettings | null): string {
  const personal = (settings?.userApiKey || '').trim();
  if (personal) return personal;
  return getClassApiKey();
}

/**
 * AI 함수 호출 헤더. 키가 있으면 x-user-api-key(개인·반 공용 양식), 없으면
 * 기기·세션 번호(서버가 맛보기 계수에 쓰고 원문은 저장하지 않는다).
 */
export function buildAiHeaders(settings?: ApiKeySettings | null): Record<string, string> {
  const key = resolveApiKey(settings);
  if (key) return { 'x-user-api-key': key };
  return { 'x-device-id': getDeviceId(), 'x-trial-session': getTrialSessionId() };
}

/** 서버 게이트가 매기는 누적과 짝을 이루는 로컬 표시용 카운터(서버가 권위). */
export function trialCount(): number {
  try {
    return Number(localStorage.getItem(TRIAL_COUNT_STORAGE_KEY) || 0);
  } catch {
    return 0;
  }
}

export function bumpTrialCount(): number {
  try {
    const next = trialCount() + 1;
    localStorage.setItem(TRIAL_COUNT_STORAGE_KEY, String(next));
    return next;
  } catch {
    return trialCount() + 1;
  }
}

export function trialRemaining(): number {
  return Math.max(0, TRIAL_DEVICE_LIMIT - trialCount());
}

/** 키가 없을 때만 참: 이 호출이 공용 맛보기로 간다. */
export function isTrialCall(settings?: ApiKeySettings | null): boolean {
  return resolveApiKey(settings) === '';
}
