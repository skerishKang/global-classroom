// Shared per-client usage gate for the public AI endpoints (#111).
//
// Cost/availability protection, not an artificial cap: a legitimate interview
// turn fires several AI calls in a row (live-token rotation, translate,
// interview-answer, tts playback) and must pass comfortably, while scripted
// flooding is rejected early with a Korean message and a Retry-After hint.
//
// State lives in this module's memory. One Netlify function instance enforces
// the limits independently of the others — the platform exposes no shared store
// to functions, so the effective allowance scales with instance count.
// transcribe-file.mts additionally carries a platform-side declarative
// rateLimit, and the deployed edge exposed no request-rate headers at review
// time (2026-11-05, read-only check), so this in-process gate is the
// app-level backstop rather than a replacement for platform defenses.
//
// Identity comes from platform-set headers only (x-nf-client-connection-ip
// first). Client-provided values are never trusted alone, and a request that
// arrives without any usable identity shares one tight 'unknown' bucket —
// fail-closed for the expensive paths instead of silently unlimited.

import { createHash } from 'crypto';
import { errorResponse } from './_aiGuards';
import type { AiJsonResponse } from './_aiGuards';

export interface RateLimitRule {
  /** 순간 폭주 허용치(토큰 버킷 용량). 정상 면접 한 턴(STT+번역+답변 연속 호출)이 여유 있게 통과하는 값. */
  burstLimit: number;
  /** 분당 예산(고정 창). 버스트만으로는 장시간 남용을 막지 못하므로 함께 둔다. */
  perMinuteLimit: number;
}

/**
 * 엔드포인트별 기본 한도(#111). 호출 단가와 정상 사용 패턴 기준:
 * - live-token: 면접에서 발화마다 번역 세션 연결 + 주기적 전사 세션 갱신으로 가장 잦다.
 * - tts: "전체 듣기"가 문장 묶음을 연속 호출한다.
 * - summarize/vision: 사용자가 명시적으로 누르는 저빈도 동작.
 * 숫자는 상수로만 존재하며 필요하면 PR에서 조정한다.
 */
export const AI_RATE_LIMITS = {
  liveToken: { burstLimit: 40, perMinuteLimit: 40 },
  translate: { burstLimit: 30, perMinuteLimit: 30 },
  interviewAnswer: { burstLimit: 15, perMinuteLimit: 15 },
  summarize: { burstLimit: 5, perMinuteLimit: 3 },
  sessionMetadata: { burstLimit: 15, perMinuteLimit: 12 },
  tts: { burstLimit: 40, perMinuteLimit: 40 },
  vision: { burstLimit: 12, perMinuteLimit: 8 },
  transcribe: { burstLimit: 12, perMinuteLimit: 8 },
} as const satisfies Record<string, RateLimitRule>;

// 플랫폼이 설정한 신뢰 가능한 IP 헤더 순서. x-forwarded-for는 체인일 수 있어
// 첫 값을 쓰고, 어떤 헤더도 없으면 'unknown' 공용 버킷으로 떨어뜨린다(fail-closed).
const IP_HEADERS = ['x-nf-client-connection-ip', 'cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'];
const UNKNOWN_KEY = 'unknown';

/** 버킷 상한(메모리 보호). 초과분은 오래된(무활동) 버킷부터 정리한다. */
export const BUCKET_MAX = 20_000;
const WINDOW_MS = 60_000;

type Bucket = {
  tokens: number;
  updatedAt: number;
  windowStart: number;
  windowCount: number;
};

const buckets = new Map<string, Bucket>();

/**
 * 클라이언트 식별 키. 플랫폼 헤더만 읽고, 체인 헤더는 첫 값을 쓰며,
 * 식별 불가 요청은 전부 'unknown' 하나로 묶는다.
 */
export function clientKeyFromHeaders(getHeader: (name: string) => string | undefined | null): string {
  for (const name of IP_HEADERS) {
    const raw = getHeader(name);
    if (typeof raw === 'string' && raw.trim()) {
      const first = raw.split(',')[0].trim();
      if (first) return first.slice(0, 64);
    }
  }
  return UNKNOWN_KEY;
}

/** 현재 메모리에 있는 버킷 수(운영 관찰·시험용). */
export function bucketCount(): number {
  return buckets.size;
}

/** 시험 전용: 모듈 상태 버킷을 모두 비운다. 핸들러 단위 시험이 서로의 한도를 오염하지 않게 한다. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 차단 시 재시도까지 권장 대기 초. 허용이면 0. */
  retryAfterSeconds: number;
}

/**
 * 토큰 버킷(버스트) + 고정 창(분당 예산) 이중 판정.
 * - 버스트: 정상적인 연속 호출(면접 한 턴)을 흡수한다.
 * - 분당 예산: 버스트 회복 속도보다 빠른 장시간 남용을 잘라낸다.
 * 시간은 주입받아 시험 가능하다.
 */
export function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
  now: () => number = Date.now,
): RateLimitDecision {
  const current = now();
  let bucket = buckets.get(key);
  if (!bucket) {
    // 새 클라이언트는 가득 찬 버스트에서 시작한다 — 정상 첫 사용은 곧바로 통과.
    bucket = { tokens: rule.burstLimit, updatedAt: current, windowStart: current, windowCount: 0 };
    buckets.set(key, bucket);
    pruneBuckets(current);
  }

  // 분당 리필: 지난 시간만큼 토큰을 보충(버스트 한도까지만).
  const elapsedMinutes = Math.max(0, (current - bucket.updatedAt) / WINDOW_MS);
  bucket.tokens = Math.min(rule.burstLimit, bucket.tokens + elapsedMinutes * rule.perMinuteLimit);

  // 고정 창 경계를 지났으면 분당 카운트를 초기화한다.
  if (current - bucket.windowStart >= WINDOW_MS) {
    bucket.windowStart = current;
    bucket.windowCount = 0;
  }

  const hasToken = bucket.tokens >= 1;
  const inWindow = bucket.windowCount < rule.perMinuteLimit;

  if (hasToken && inWindow) {
    bucket.tokens -= 1;
    bucket.windowCount += 1;
    bucket.updatedAt = current;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucket.updatedAt = current;
  const windowWaitSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - current) / 1000);
  const tokenWaitSeconds = Math.ceil(((1 - bucket.tokens) / rule.perMinuteLimit) * 60);
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, inWindow ? tokenWaitSeconds : windowWaitSeconds),
  };
}

function pruneBuckets(current: number): void {
  if (buckets.size <= BUCKET_MAX) return;
  // 1) 창 하나 이상 활동이 없던 버킷부터 버린다.
  for (const [key, bucket] of buckets) {
    if (current - bucket.updatedAt > WINDOW_MS) buckets.delete(key);
    if (buckets.size <= BUCKET_MAX) return;
  }
  // 2) 그래도 넘치면 가장 오래된 것부터 밀어낸다(Map은 삽입 순서를 유지).
  for (const key of buckets.keys()) {
    buckets.delete(key);
    if (buckets.size <= BUCKET_MAX) return;
  }
}

/** 429 본문·헤더. 재시도 시간은 초 단위 숫자와 Retry-After 헤더로 함께 전달된다. */
export function rateLimitResponse(decision: RateLimitDecision): AiJsonResponse {
  return {
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(Math.max(1, decision.retryAfterSeconds)),
    },
    body: JSON.stringify({
      error: 'AI 기능 사용량이 일시적으로 제한에 도달했습니다. 잠시 후 다시 시도해 주세요.',
      retryAfterSeconds: decision.retryAfterSeconds,
    }),
  };
}

/**
 * Legacy .ts 핸들러용 게이트. 메서드 검사 직후, 본문 해석보다 앞서 호출한다.
 * 한도를 넘지 않았으면 null(계속 진행), 넘었으면 429 응답을 돌려준다.
 */
export function enforceRateLimit(
  event: any,
  rule: RateLimitRule,
  now: () => number = Date.now,
): AiJsonResponse | null {
  const key = clientKeyFromHeaders((name) => event?.headers?.[name]);
  const decision = consumeRateLimit(key, rule, now);
  return decision.allowed ? null : rateLimitResponse(decision);
}

// ---- #120: 개인 키 > 반 키 > 공용 맛보기. 맛보기는 기기·세션 단위로 센다. ----
// 대표 결정(2026-11-05 08:17, #120 댓글 6644758758): IP가 아니라 기기·세션 단위
// (교실은 한 반이 같은 IP를 쓴다). 키가 있는 요청(개인·반)은 맛보기 한도 밖이다.

export const USER_KEY_HEADER = 'x-user-api-key';
export const DEVICE_ID_HEADER = 'x-device-id';
export const TRIAL_SESSION_HEADER = 'x-trial-session';
/** 공용 맛보기 응답에만 붙는 관찰 머리글. 키 요청에는 붙지 않는다. */
export const TRIAL_REMAINING_HEADER = 'x-trial-remaining';
export const TRIAL_STORE_HEADER = 'x-trial-store';
/** 대표 확정 전 기본값(#120): 기기 누적 30회, 세션 10회. 상수 하나로만 존재한다. */
export const TRIAL_DEVICE_LIMIT = 30;
export const TRIAL_SESSION_LIMIT = 10;

const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 기기 번호·세션 번호는 그 원문을 저장하지 않고 해시해서만 쓴다. */
export function hashedTokenFromHeaders(getHeader: (name: string) => string | undefined | null, header: string): string | null {
  const raw = getHeader(header);
  if (typeof raw !== 'string' || !DEVICE_TOKEN_RE.test(raw.trim())) return null;
  return createHash('sha256').update(raw.trim()).digest('hex').slice(0, 32);
}

type TrialRecord = { count: number; last: string };

/** 기기 누적 카운터: Netlify Blobs(런타임 내장) 우선, 불가하면 인스턴스 메모리. */
const memoryDeviceTrials = new Map<string, TrialRecord>();
let trialStorePromise: Promise<any | null> | null = null;

async function trialStore(): Promise<any | null> {
  if (trialStorePromise === null) {
    // Netlify Functions 런타임은 @netlify/blobs를 내장 제공한다(의존성 추가
    // 불필요). 로컬 시험처럼 모듈이 없으면 null로 귀결되고 인스턴스 메모리가
    // 대신한다(PR 본문 한계 명시).
    // @ts-expect-error - the module ships with the Netlify Functions runtime.
    trialStorePromise = import('@netlify/blobs')
      .then((mod: any) => mod.getStore({ name: 'padiem-trial-usage', consistency: 'strong' }))
      .catch(() => null);
  }
  return trialStorePromise;
}

async function readDeviceTrial(key: string): Promise<TrialRecord> {
  const store = await trialStore();
  if (store) {
    try {
      const raw = await store.get(key, { type: 'json' });
      if (raw && typeof raw.count === 'number' && raw.count >= 0) return raw;
    } catch { /* 읽기 실패는 메모리 값으로 계속한다. */ }
  }
  return memoryDeviceTrials.get(key) || { count: 0, last: '' };
}

/** Returns true only when the record really reached Netlify Blobs. */
async function writeDeviceTrial(key: string, record: TrialRecord): Promise<boolean> {
  memoryDeviceTrials.set(key, record);
  const store = await trialStore();
  if (store) {
    try {
      await store.setJSON(key, record);
      return true;
    } catch { /* 메모리 값은 이미 갱신됐다. */ }
  }
  return false;
}

/** 세션 카운터: 세션은 짧아 메모리만으로 충분하다(기기 누적이 실 게이트). */
const memorySessionTrials = new Map<string, { count: number; startedAt: number }>();

/** 시험 전용: 카운터 상태를 모두 비운다. */
export function resetTrialCountersForTests(): void {
  memoryDeviceTrials.clear();
  memorySessionTrials.clear();
  trialStorePromise = null;
  trialChains.clear();
}

type DeviceTrialResult = { count: number; storeMode: 'blobs' | 'memory' };
const trialChains = new Map<string, Promise<DeviceTrialResult>>();

/** 기기 누적 1회 소비. 같은 기기의 동시 호출은 직렬화해 이중 가산을 막는다. */
async function consumeDeviceTrial(
  key: string, now: number,
): Promise<DeviceTrialResult> {
  const previous: Promise<DeviceTrialResult> = trialChains.get(key) || Promise.resolve({ count: 0, storeMode: 'memory' });
  const run = previous.catch(() => undefined).then(async () => {
    const record = await readDeviceTrial(key);
    const next: TrialRecord = { count: record.count + 1, last: new Date(now).toISOString() };
    const persisted = await writeDeviceTrial(key, next);
    return { count: next.count, storeMode: persisted ? 'blobs' as const : 'memory' as const };
  });
  trialChains.set(key, run);
  run.catch(() => undefined); // 대기자가 없어도 예외가 무시되지 않게 한다.
  trialChains.delete(key);
  return run;
}

export interface TrialDecision {
  allowed: boolean;
  reason: 'device_limit' | 'session_limit' | null;
  retryAfterSeconds: number;
  /** 이번 호출을 반영한 기기 누적 남은 횟수(0 이상). */
  remaining: number;
  /** 카운터가 실제로 저장된 곳. Blobs 쓰기가 실패하면 memory다. */
  storeMode: 'blobs' | 'memory';
}

async function consumeTrialUsage(
  deviceHash: string, sessionHash: string | null, now: number,
): Promise<TrialDecision> {
  const { count: deviceCount, storeMode } = await consumeDeviceTrial(`device:${deviceHash}`, now);
  const remaining = Math.max(0, TRIAL_DEVICE_LIMIT - deviceCount);

  if (deviceCount > TRIAL_DEVICE_LIMIT) {
    return { allowed: false, reason: 'device_limit', retryAfterSeconds: 3600, remaining, storeMode };
  }

  if (sessionHash) {
    const sessionKey = `session:${deviceHash}:${sessionHash}`;
    const row = memorySessionTrials.get(sessionKey) || { count: 0, startedAt: now };
    row.count += 1;
    memorySessionTrials.set(sessionKey, row);
    if (row.count > TRIAL_SESSION_LIMIT) {
      return { allowed: false, reason: 'session_limit', retryAfterSeconds: 3600, remaining, storeMode };
    }
  }
  return { allowed: true, reason: null, retryAfterSeconds: 0, remaining, storeMode };
}

function trialExhaustedResponse(
  reason: 'device_limit' | 'session_limit',
  headers: Record<string, string>,
): AiJsonResponse {
  return {
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': '3600',
      ...headers,
    },
    body: JSON.stringify({
      error: '무료 체험 횟수를 모두 사용했습니다. 설정에서 개인 API 키를 등록하면 계속 사용할 수 있습니다.',
      code: 'trial_exhausted',
      reason,
    }),
  };
}

export interface AiUsageGate {
  /** 차단 응답이면 그 응답, 통과면 null. */
  blocked: AiJsonResponse | null;
  /** 공용 맛보기 응답에만 붙일 머리글. 키 요청·기기 없는 요청은 빈 객체. */
  headers: Record<string, string>;
  /** 이번 호출의 맛보기 관찰값. 키 요청·기기 없는 요청은 null. */
  trial: { remaining: number; storeMode: 'blobs' | 'memory' } | null;
}

/** 성공 응답에 게이트의 맛보기 머리글을 합친다(붙일 것이 없으면 원본 그대로). */
export function withTrialHeaders<T extends AiJsonResponse>(response: T, gate: AiUsageGate): T {
  if (Object.keys(gate.headers).length === 0) return response;
  return { ...response, headers: { ...(response.headers || {}), ...gate.headers } };
}

/**
 * #120 통합 게이트. 메서드 검사 직후, 본문 해석보다 앞서 await로 호출한다.
 * - x-user-api-key가 있으면(개인·반 키) #119의 버스트·분당 한도만 적용하고
 *   맛보기 카운터는 세지 않는다 — 반 키는 개인 키와 동급 자격이다.
 * - 키가 없으면 공용 맛보기: 기기 번호가 있으면 기기 버스트 + 기기 누적(30)·
 *   세션(10) 카운터, 기기 번호가 없으면 IP 보조 버킷만(누적은 미적용).
 * - 통과면 blocked=null. 맛보기 요청이면 남은 횟수·저장 위치 머리글과
 *   관찰 로그 한 줄(endpoint, store, remaining, 기기 해시 앞 8자)을 남긴다.
 * - 한도를 넘으면 429 응답을 돌려준다(맛보기 소진이면 머리글 포함).
 */
export async function enforceAiUsageGate(
  event: any,
  rule: RateLimitRule,
  endpoint: string,
  now: () => number = Date.now,
): Promise<AiUsageGate> {
  const getHeader = (name: string) => event?.headers?.[name];
  const hasUserKey = typeof getHeader(USER_KEY_HEADER) === 'string'
    && getHeader(USER_KEY_HEADER).trim() !== '';
  const deviceHash = hashedTokenFromHeaders(getHeader, DEVICE_ID_HEADER);
  const sessionHash = deviceHash ? hashedTokenFromHeaders(getHeader, TRIAL_SESSION_HEADER) : null;

  const ipKey = clientKeyFromHeaders(getHeader);
  // 기기 없는 요청은 #119와 같은 IP 버킷 키를 그대로 쓴다(보조 버킷 — 사전
  // 충전·운영 관찰이 같은 네임스페이스를 유지한다).
  const burstKey = hasUserKey ? `keyed:${ipKey}`
    : deviceHash ? `device:${deviceHash}`
    : ipKey;
  const decision = consumeRateLimit(burstKey, rule, now);
  if (!decision.allowed) {
    return { blocked: rateLimitResponse(decision), headers: {}, trial: null };
  }

  if (hasUserKey || !deviceHash) {
    return { blocked: null, headers: {}, trial: null };
  }
  const trial = await consumeTrialUsage(deviceHash, sessionHash, now());
  const headers = {
    [TRIAL_REMAINING_HEADER]: String(trial.remaining),
    [TRIAL_STORE_HEADER]: trial.storeMode,
  };
  // 원문·키·IP 없이 어느 저장소에 실제로 쌓이는지만 남긴다.
  console.info(
    `trial endpoint=${endpoint} store=${trial.storeMode} `
    + `remaining=${trial.remaining} device=${deviceHash.slice(0, 8)}`,
  );
  const observation = { remaining: trial.remaining, storeMode: trial.storeMode };
  if (trial.allowed) return { blocked: null, headers, trial: observation };
  return {
    blocked: trialExhaustedResponse(trial.reason as 'device_limit' | 'session_limit', headers),
    headers,
    trial: observation,
  };
}
