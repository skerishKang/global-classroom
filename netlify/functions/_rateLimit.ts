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
