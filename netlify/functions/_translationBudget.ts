// Translation latency budget and provider-error classification (#84).
//
// Production observed ~30s HTTP 504 on /api/translate. The cause is not the
// model list: the Groq client defaults to a 60s timeout with 2 retries, and the
// Google call had no bound at all, so a single stalled candidate could consume
// the whole platform window before the next fallback was ever reached.
//
// This module is deliberately provider-free, like _aiGuards.ts, so the schedule
// can be unit tested with an injected clock and no network access.

/** Total handler time allowed for provider work. Comfortably under the ~30s
 * platform limit that produced the 504, leaving room for response assembly. */
export const TRANSLATION_TOTAL_BUDGET_MS = 24_000;

/** Per-request bound for one Groq candidate. */
export const GROQ_MODEL_TIMEOUT_MS = 6_000;

/** Per-request bound for one Google candidate. Also the floor the Google client
 * accepts on this path (#85 established 10s as the usable minimum). */
export const GOOGLE_MODEL_TIMEOUT_MS = 10_000;

/** Time kept back so that at least one Google fallback can still be attempted
 * after the Groq pool. Without a reserve, three slow Groq routes would spend the
 * whole budget and silently remove the fallback the owner approved. */
export const GOOGLE_RESERVE_MS = GOOGLE_MODEL_TIMEOUT_MS;

/** A candidate that cannot finish inside what is left is not started at all. */
export const MIN_USEFUL_ATTEMPT_MS = 1_200;

export type TranslationProvider = 'groq' | 'google';

export type AttemptOutcome =
  | 'ok'
  | 'empty_response'
  | 'timeout'
  | 'aborted'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'network'
  | 'unknown';

export type SkipReason = 'budget_exhausted' | 'below_sdk_minimum';

// A string discriminant, not a boolean one: this project compiles without
// `strict`, so `strictNullChecks` is off and boolean-literal narrowing does not
// work. A skipped plan must not be able to read `timeoutMs`, and a started plan
// must not be able to read `reason`.
export type AttemptPlan =
  | { state: 'start'; timeoutMs: number }
  | { state: 'skip'; reason: SkipReason };

/**
 * Decide whether one candidate may start, and with what timeout.
 *
 * `elapsedMs` is time already spent inside this handler, so the decision depends
 * on real latency rather than on a fixed per-model allowance repeated N times.
 */
export function planAttempt(input: {
  provider: TranslationProvider;
  elapsedMs: number;
  googleCandidatesRemaining: number;
}): AttemptPlan {
  const remaining = TRANSLATION_TOTAL_BUDGET_MS - input.elapsedMs;
  const reserve =
    input.provider === 'groq' && input.googleCandidatesRemaining > 0
      ? GOOGLE_RESERVE_MS
      : 0;
  const allowance = remaining - reserve;

  if (allowance < MIN_USEFUL_ATTEMPT_MS) {
    return { state: 'skip', reason: 'budget_exhausted' };
  }

  const cap = input.provider === 'groq' ? GROQ_MODEL_TIMEOUT_MS : GOOGLE_MODEL_TIMEOUT_MS;
  const timeoutMs = Math.min(cap, allowance);

  if (input.provider === 'google' && timeoutMs < GOOGLE_MODEL_TIMEOUT_MS) {
    // Below the floor the Google client cannot be given a bounded timeout, so
    // starting it would re-open the unbounded path this change exists to close.
    return { state: 'skip', reason: 'below_sdk_minimum' };
  }

  return { state: 'start', timeoutMs };
}

/**
 * Map a provider failure onto a closed vocabulary.
 *
 * Status codes decide the class; message text is never used as evidence, and it
 * is redacted separately by safeErrorDetail before it reaches a log.
 */
export function classifyProviderError(error: unknown): AttemptOutcome {
  if (error === null || typeof error !== 'object') return 'unknown';

  const err = error as Record<string, any>;
  const name = typeof err.name === 'string' ? err.name : '';
  const cause = (err.cause ?? {}) as Record<string, any>;
  const causeName = typeof cause.name === 'string' ? cause.name : '';

  if (name === 'AbortError' || name === 'APIUserAbortError' || causeName === 'AbortError') {
    // A timeout surfaces as an abort through the signal we pass down, so this is
    // checked before status: an aborted request has no response status.
    return 'aborted';
  }

  const status = statusCodeOf(err);
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status !== null && status >= 500) return 'server_error';
  if (status !== null && status >= 400) return 'client_error';

  if (name === 'APIConnectionTimeoutError' || causeName === 'TimeoutError') return 'timeout';
  if (
    name === 'APIConnectionError'
    || name === 'ConnectionError'
    || name === 'TypeError'
    || name === 'NetworkError'
    || causeName === 'TypeError'
    || causeName === 'NetworkError'
  ) {
    return 'network';
  }

  return 'unknown';
}

function statusCodeOf(error: Record<string, any>): number | null {
  const candidates = [
    error.status,
    error.statusCode,
    error.$?.status,
    error.$meta?.status,
    error.error?.code,
    error.response?.status,
  ];
  for (const candidate of candidates) {
    const numeric = typeof candidate === 'string' ? Number(candidate) : candidate;
    if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 100) {
      return numeric;
    }
  }
  return null;
}

export type AttemptRecord = {
  provider: TranslationProvider;
  model: string;
  ms: number;
  outcome: AttemptOutcome;
  /** Set instead of `ms` when the candidate was never started. */
  skipped?: SkipReason;
};

/**
 * Accumulates per-attempt latency and emits one bounded summary line.
 *
 * Only provider, model, duration and outcome class are recorded. Request text,
 * translated text, glossary terms, caller headers and every key stay out.
 */
export class TranslationTelemetry {
  private readonly startedAt: number;
  readonly attempts: AttemptRecord[] = [];

  constructor(private readonly now: () => number, startedAt?: number) {
    this.startedAt = startedAt ?? this.now();
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  record(record: AttemptRecord): void {
    this.attempts.push(record);
    console.info(
      `[translate] attempt provider=${record.provider} model=${record.model} `
      + `ms=${record.ms} outcome=${record.outcome}`,
    );
  }

  skipped(provider: TranslationProvider, model: string, reason: SkipReason): void {
    this.attempts.push({ provider, model, ms: 0, outcome: 'unknown', skipped: reason });
    console.info(
      `[translate] skipped provider=${provider} model=${model} reason=${reason} `
      + `elapsedMs=${this.elapsedMs}`,
    );
  }

  summary(final: { statusCode: number; provider: string | null; model: string | null }): string {
    const outcomes = new Map<AttemptOutcome | SkipReason, number>();
    for (const attempt of this.attempts) {
      const key = attempt.skipped ?? attempt.outcome;
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }
    const tally = [...outcomes.entries()]
      .map(([key, count]) => `${key}=${count}`)
      .join(' ');
    return (
      `[translate] done status=${final.statusCode} totalMs=${this.elapsedMs} `
      + `attempts=${this.attempts.length} served=${final.provider ?? 'none'}/`
      + `${final.model ?? 'none'} ${tally}`
    );
  }
}
