import type { ConversationItem } from '../types';
import { normalizeLanguageCode } from './interviewLanguageRouting';

/**
 * Request shaping and language policy for the interview answer assist (#62).
 *
 * Two rules drive everything in this module:
 *
 * 1. The suggested answer is written in the current Interview OUTPUT
 *    (translation) language, not in the interviewer's source language. An
 *    English question with Korean output produces a Korean answer, and a
 *    Korean question with English output produces an English answer.
 * 2. Answer generation starts from the finalized source transcript and the
 *    resolved output target, so it never waits for a translation response.
 *
 * Translating that ONE answer into the opposite language is an on-demand user
 * action (번역), served by the existing /translate path and cached per
 * utterance; the policy helpers below are pure so the caching, hiding and
 * invalidation rules are unit-testable without React or network access.
 */
export const MAX_ANSWER_CONTEXT_TURNS = 5;
export const MAX_ANSWER_CONTEXT_TURN_CHARS = 600;

export interface InterviewAnswerRequestPayload {
  /** The latest interviewer utterance (the finalized source transcript). */
  text: string;
  /** Answer language: the resolved Interview output/translation language. */
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

/**
 * Language the suggested answer must be written in (#62).
 *
 * The visible translation variant of the utterance is authoritative: an
 * utterance whose output target is Korean gets a Korean answer. The source
 * language is only a fallback for the degenerate case where no non-source
 * target exists at all, because then there is no other language on screen to
 * read the answer in.
 */
export function resolveAnswerLanguage(
  activeTarget: string | null | undefined,
  selectedTargets: readonly string[],
  sourceLanguage: string | null | undefined,
): string {
  const active = normalizeLanguageCode(activeTarget || '');
  if (active) return active;

  const source = normalizeLanguageCode(sourceLanguage || '');
  const targets = (selectedTargets || [])
    .map((target) => normalizeLanguageCode(target))
    .filter((target) => target && target !== 'auto');
  const opposite = targets.find((target) => target !== source);
  if (opposite) return opposite;
  return targets[0] || source || 'en';
}

/**
 * Language the on-demand 번역 action translates the answer INTO: the opposite,
 * source-side language of the conversation.
 *
 * Returns '' when the two sides are the same language or either side is
 * unknown, which hides the button instead of offering a pointless translation.
 */
export function resolveAnswerTranslationTarget(
  answerLanguage: string | null | undefined,
  sourceLanguage: string | null | undefined,
): string {
  const answer = normalizeLanguageCode(answerLanguage || '');
  const source = normalizeLanguageCode(sourceLanguage || '');
  if (!answer || !source || answer === source) return '';
  return source;
}

/**
 * A cached answer translation is usable only while it was produced from the
 * exact `suggestedAnswer` currently on screen. Any regeneration of the answer
 * invalidates it (#62), so a stale translation is never displayed.
 */
export function isAnswerTranslationFresh(
  state: Pick<
    ConversationItem,
    'suggestedAnswer' | 'answerTranslation' | 'answerTranslationSource'
  >,
  suggestedAnswer: string | null | undefined = state.suggestedAnswer,
): boolean {
  const source = normalize(suggestedAnswer || '');
  if (!source) return false;
  const cached = String(state.answerTranslation || '').trim();
  if (!cached) return false;
  return String(state.answerTranslationSource || '').trim() === source;
}

/** What one press of the answer 번역 control must do. */
export type AnswerTranslationAction =
  | { kind: 'ignore' }
  | { kind: 'hide' }
  | { kind: 'show' }
  | { kind: 'request'; targetLanguage: string };

/**
 * Single policy for the answer translation button (#62).
 *
 * `hide` and `show` are pure visibility changes on an already cached
 * translation and therefore never call the API — which is what makes repeated
 * hide/show free. `request` is the only action that reaches /translate, and it
 * requires a live translation for the exact answer on screen.
 */
export function planAnswerTranslation(
  state: Pick<
    ConversationItem,
    | 'suggestedAnswer'
    | 'answerLanguage'
    | 'sourceLanguage'
    | 'answerTranslation'
    | 'answerTranslationSource'
    | 'answerTranslationVisible'
    | 'answerTranslationStatus'
  >,
): AnswerTranslationAction {
  const suggestedAnswer = normalize(state.suggestedAnswer || '');
  if (!suggestedAnswer) return { kind: 'ignore' };
  // A request for this utterance is already in flight: never double-spend it.
  if (state.answerTranslationStatus === 'loading') return { kind: 'ignore' };

  const targetLanguage = resolveAnswerTranslationTarget(state.answerLanguage, state.sourceLanguage);
  if (!targetLanguage) return { kind: 'ignore' };

  if (isAnswerTranslationFresh(state, suggestedAnswer)) {
    return state.answerTranslationVisible ? { kind: 'hide' } : { kind: 'show' };
  }
  return { kind: 'request', targetLanguage };
}