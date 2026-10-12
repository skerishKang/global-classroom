// Translation latency budget and provider-error classification (#84).
//
// Production observed ~30s HTTP 504 on /api/translate. The cause is not the
// model list: the Groq client defaults to a 60s timeout with 2 retries, and the
// Google call had no bound at all, so a single stalled candidate could consume
// the whole platform window before the next fallback was ever reached.
//
// The mechanics are shared with /api/interview-answer in _providerBudget.ts;
// this module binds them to the limits that were measured and shipped for the
// translation path. Those numbers are the deployed #84 contract and are not
// tuned here — changing them changes production translation behaviour.

import {
  ProviderTelemetry,
  createProviderBudget,
  type AttemptOutcome,
  type AttemptPlan,
  type ProviderName,
  type SkipReason,
} from './_providerBudget';

export type { AttemptOutcome, AttemptPlan, SkipReason };
export type TranslationProvider = ProviderName;

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

const translationBudget = createProviderBudget({
  totalBudgetMs: TRANSLATION_TOTAL_BUDGET_MS,
  groqModelTimeoutMs: GROQ_MODEL_TIMEOUT_MS,
  googleModelTimeoutMs: GOOGLE_MODEL_TIMEOUT_MS,
  googleReserveMs: GOOGLE_RESERVE_MS,
  minUsefulAttemptMs: MIN_USEFUL_ATTEMPT_MS,
});

export const planAttempt = translationBudget.planAttempt;

/** Endpoint-labelled telemetry so existing `[translate]` log lines are unchanged. */
export class TranslationTelemetry extends ProviderTelemetry {
  constructor(now: () => number, startedAt?: number) {
    super('translate', now, startedAt);
  }
}

export type AttemptRecord = {
  provider: TranslationProvider;
  model: string;
  ms: number;
  outcome: AttemptOutcome;
  skipped?: SkipReason;
};

export { classifyProviderError } from './_providerBudget';
