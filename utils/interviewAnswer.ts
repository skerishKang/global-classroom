import type { ConversationItem } from '../types';
import { normalizeLanguageCode } from './interviewLanguageRouting';

/**
 * Request shaping and language policy for the interview answer assist (#62/#70).
 *
 * The suggested answer follows the finalized transcript/source language so it
 * is immediately speakable in the interviewer's language. Its translation is
 * produced automatically through the existing /translate path into the row's
 * active translation target. Generation still starts from the finalized source
 * transcript and never waits for the question translation response.
 */
export const MAX_ANSWER_CONTEXT_TURNS = 5;
export const MAX_ANSWER_CONTEXT_TURN_CHARS = 600;

export interface InterviewAnswerRequestPayload {
  /** The latest interviewer utterance (the finalized source transcript). */
  text: string;
  /** Answer language: the finalized transcript/source language. */
  answerLanguage: string;
  /** Display name of `answerLanguage`, used by the prompt for clarity. */
  answerLanguageName?: string;
  /** The interviewer's source language; context only, never the answer language. */
  sourceLanguage?: string;
  /** Recent finalized interview utterances, oldest first, bounded. */
  recentContext: string[];
}

const normalize = (text: string): string => String(text || '').replace(/\s+/g, ' ').trim();

export function buildAnswerRequest(
  text: string,
  recentUtterances: readonly string[],
  answerLanguage: string,
  options?: { answerLanguageName?: string; sourceLanguage?: string },
): InterviewAnswerRequestPayload {
  const turns = recentUtterances
    .map(normalize)
    .filter((turn) => turn.length > 0)
    .slice(-MAX_ANSWER_CONTEXT_TURNS)
    .map((turn) => turn.slice(0, MAX_ANSWER_CONTEXT_TURN_CHARS));

  const answer = normalizeLanguageCode(answerLanguage) || 'en';
  const source = normalizeLanguageCode(options?.sourceLanguage || '');

  return {
    text: normalize(text),
    answerLanguage: answer,
    answerLanguageName: String(options?.answerLanguageName || '').trim() || undefined,
    sourceLanguage: source || undefined,
    recentContext: turns,
  };
}

/** Language the suggested answer must be written in (#70): source first. */
export function resolveAnswerLanguage(
  activeTarget: string | null | undefined,
  selectedTargets: readonly string[],
  sourceLanguage: string | null | undefined,
): string {
  const source = normalizeLanguageCode(sourceLanguage || '');
  if (source && source !== 'auto') return source;

  const active = normalizeLanguageCode(activeTarget || '');
  if (active && active !== 'auto') return active;

  const targets = (selectedTargets || [])
    .map((target) => normalizeLanguageCode(target))
    .filter((target) => target && target !== 'auto');
  return targets[0] || 'en';
}

/**
 * Answer translation follows the row's active question-translation target.
 * Returns '' when there is no distinct target to translate into.
 */
export function resolveAnswerTranslationTarget(
  answerLanguage: string | null | undefined,
  activeTarget: string | null | undefined,
): string {
  const answer = normalizeLanguageCode(answerLanguage || '');
  const target = normalizeLanguageCode(activeTarget || '');
  if (!answer || !target || target === 'auto' || answer === target) return '';
  return target;
}

/**
 * A cached answer translation is usable only while it was produced from the
 * exact `suggestedAnswer` currently on screen. Any regeneration of the answer
 * invalidates it (#62), so a stale translation is never displayed.
 */
export function isAnswerTranslationFresh(
  state: Pick<
    ConversationItem,
    'suggestedAnswer' | 'answerTranslation' | 'answerTranslationSource' | 'answerTranslationLanguage'
  >,
  suggestedAnswer: string | null | undefined = state.suggestedAnswer,
  targetLanguage?: string | null,
): boolean {
  const source = normalize(suggestedAnswer || '');
  if (!source) return false;
  const cached = String(state.answerTranslation || '').trim();
  if (!cached) return false;
  if (String(state.answerTranslationSource || '').trim() !== source) return false;

  const target = normalizeLanguageCode(targetLanguage || '');
  return !target || normalizeLanguageCode(state.answerTranslationLanguage || '') === target;
}

/** Reusable answer-translation planning contract (#62/#70). */
export type AnswerTranslationAction =
  | { kind: 'ignore' }
  | { kind: 'hide' }
  | { kind: 'show' }
  | { kind: 'request'; targetLanguage: string };

/**
 * A cached translation is reusable only for the exact answer and active target.
 * The current #70 UI translates automatically; this helper remains pure so the
 * target/freshness contract stays unit-testable.
 */
export function planAnswerTranslation(
  state: Pick<
    ConversationItem,
    | 'suggestedAnswer'
    | 'answerLanguage'
    | 'activeTarget'
    | 'answerTranslation'
    | 'answerTranslationLanguage'
    | 'answerTranslationSource'
    | 'answerTranslationVisible'
    | 'answerTranslationStatus'
  >,
): AnswerTranslationAction {
  const suggestedAnswer = normalize(state.suggestedAnswer || '');
  if (!suggestedAnswer) return { kind: 'ignore' };
  // A request for this utterance is already in flight: never double-spend it.
  if (state.answerTranslationStatus === 'loading') return { kind: 'ignore' };

  const targetLanguage = resolveAnswerTranslationTarget(state.answerLanguage, state.activeTarget);
  if (!targetLanguage) return { kind: 'ignore' };

  if (isAnswerTranslationFresh(state, suggestedAnswer, targetLanguage)) {
    return state.answerTranslationVisible ? { kind: 'hide' } : { kind: 'show' };
  }
  return { kind: 'request', targetLanguage };
}