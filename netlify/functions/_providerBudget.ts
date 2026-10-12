// Shared provider-latency budget, error classification and telemetry.
//
// Two public AI endpoints (/api/translate #84 and /api/interview-answer) route
// the same owner-approved model pool through the same two SDKs, and both were
// exposed to the same failure: the Groq client defaults to a 60s timeout with 2
// retries, the Google client had no bound at all, and five sequential candidates
// with no shared ceiling can overrun the ~30s platform window and die as a 504.
//
// The mechanics live here once. The *limits* are injected, because a short
// translation turn and a JSON-mode interview answer do not need the same
// per-model allowance. Nothing in this module knows about prompts, payloads or
// response shapes, so it stays unit-testable without a provider.

import { safeErrorDetail } from './_aiGuards';

export type ProviderName = 'groq' | 'google';

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

export type ProviderLimits = {
  totalBudgetMs: number;
  groqModelTimeoutMs: number;
  googleModelTimeoutMs: number;
  googleReserveMs: number;
  minUsefulAttemptMs: number;
};

export type ProviderBudget = {
  limits: ProviderLimits;
  planAttempt(input: {
    provider: ProviderName;
    elapsedMs: number;
    googleCandidatesRemaining: number;
  }): AttemptPlan;
};

/**
 * Build a budget from explicit limits, rejecting an incoherent configuration
 * rather than discovering it as a production 504.
 */
export function createProviderBudget(limits: ProviderLimits): ProviderBudget {
  if (limits.totalBudgetMs <= 0) throw new Error('totalBudgetMs must be positive');
  if (limits.googleModelTimeoutMs > limits.totalBudgetMs) {
    throw new Error('a single Google attempt must fit inside the total budget');
  }
  if (limits.googleReserveMs + limits.minUsefulAttemptMs > limits.totalBudgetMs) {
    throw new Error('the Google reserve would leave no time for any candidate');
  }
  if (limits.minUsefulAttemptMs <= 0) throw new Error('minUsefulAttemptMs must be positive');

  return {
    limits,
    planAttempt: (input) => planAttemptWithLimits(input, limits),
  };
}

function planAttemptWithLimits(
  input: {
    provider: ProviderName;
    elapsedMs: number;
    googleCandidatesRemaining: number;
  },
  limits: ProviderLimits,
): AttemptPlan {
  const remaining = limits.totalBudgetMs - input.elapsedMs;

  // The reserve is what keeps the approved fallback alive: without it, a slow
  // first pool can spend the whole budget and silently delete the candidates the
  // owner approved, which looks identical to "the pool order changed".
  const reserve =
    input.provider === 'groq' && input.googleCandidatesRemaining > 0
      ? limits.googleReserveMs
      : 0;
  const allowance = remaining - reserve;

  if (allowance < limits.minUsefulAttemptMs) {
    return { state: 'skip', reason: 'budget_exhausted' };
  }

  const cap = input.provider === 'groq'
    ? limits.groqModelTimeoutMs
    : limits.googleModelTimeoutMs;
  const timeoutMs = Math.min(cap, allowance);

  if (input.provider === 'google' && timeoutMs < limits.googleModelTimeoutMs) {
    // Below the floor the Google client cannot be given a bounded timeout, so
    // starting it would re-open the unbounded path this budget exists to close.
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
  provider: ProviderName;
  model: string;
  ms: number;
  outcome: AttemptOutcome;
  /** Set instead of a real duration when the candidate was never started. */
  skipped?: SkipReason;
};

/**
 * Run one provider attempt inside a hard wall-clock bound and report what
 * happened.
 *
 * The bound is enforced twice, deliberately. The `AbortSignal` is handed to the
 * provider so a stalled request is really cancelled and its socket released
 * instead of finishing in the background after we already answered. The deadline
 * is also raced locally, because a bound that depends on the provider honouring
 * cancellation is not a bound: a client that ignores its signal would otherwise
 * keep the handler waiting past the platform window.
 *
 * `run` resolves to `null` to report an unusable result (for example an empty
 * completion). That is recorded as `empty_response` and counted as a failed
 * candidate, so a blank payload can never be returned as a success.
 */
export async function runWithDeadline<T>(input: {
  label: string;
  provider: ProviderName;
  model: string;
  timeoutMs: number;
  telemetry: ProviderTelemetry;
  run: (signal: AbortSignal) => Promise<T | null>;
}): Promise<{ state: 'ok'; value: T } | { state: 'failed'; outcome: AttemptOutcome }> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(Object.assign(
        new Error(`${input.provider} ${input.model} exceeded its ${input.timeoutMs}ms budget`),
        { name: 'AbortError' },
      ));
    }, input.timeoutMs);
  });

  const startedAt = Date.now();

  try {
    const value = await Promise.race([input.run(controller.signal), deadline]);
    const ms = Date.now() - startedAt;
    if (value === null) {
      input.telemetry.record({ provider: input.provider, model: input.model, ms, outcome: 'empty_response' });
      return { state: 'failed', outcome: 'empty_response' };
    }
    input.telemetry.record({ provider: input.provider, model: input.model, ms, outcome: 'ok' });
    return { state: 'ok', value };
  } catch (error: any) {
    const ms = Date.now() - startedAt;
    // A deadline abort is reported as a timeout, not as a generic abort: the
    // distinction is what tells an operator that the bound fired.
    const outcome: AttemptOutcome = timedOut ? 'timeout' : classifyProviderError(error);
    input.telemetry.record({ provider: input.provider, model: input.model, ms, outcome });
    console.error(
      `${input.label}: ${input.provider} ${input.model} failed after ${ms}ms (${outcome}):`,
      safeErrorDetail(error),
    );
    return { state: 'failed', outcome };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Also covers the success path: a provider promise that resolves late, or is
    // still pending after we lost interest, must not keep running.
    controller.abort();
  }
}

/**
 * Accumulates per-attempt latency and emits one bounded summary line.
 *
 * Only the endpoint label, provider, model, duration and outcome class are
 * recorded. Request text, model output, caller headers and every API key stay
 * out, so a log line can never carry interview content.
 */
export class ProviderTelemetry {
  readonly attempts: AttemptRecord[] = [];

  private readonly startedAtValue: number;

  constructor(
    private readonly label: string,
    private readonly now: () => number,
    startedAt?: number,
  ) {
    this.startedAtValue = startedAt ?? this.now();
  }

  get elapsedMs(): number {
    return this.now() - this.startedAtValue;
  }

  record(record: AttemptRecord): void {
    this.attempts.push(record);
    console.info(
      `[${this.label}] attempt provider=${record.provider} model=${record.model} `
      + `ms=${record.ms} outcome=${record.outcome}`,
    );
  }

  skipped(provider: ProviderName, model: string, reason: SkipReason): void {
    this.attempts.push({ provider, model, ms: 0, outcome: 'unknown', skipped: reason });
    console.info(
      `[${this.label}] skipped provider=${provider} model=${model} reason=${reason} `
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
      `[${this.label}] done status=${final.statusCode} totalMs=${this.elapsedMs} `
      + `attempts=${this.attempts.length} served=${final.provider ?? 'none'}/`
      + `${final.model ?? 'none'} ${tally}`
    );
  }
}
