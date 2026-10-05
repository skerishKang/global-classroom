/**
 * Request shaping for the interview answer assist (#62).
 *
 * The endpoint is a single bounded call, so the payload is bounded here as
 * well: the latest interviewer utterance plus a handful of earlier turns,
 * with a language hint that is the SOURCE language (the answer is written in
 * the language the interviewer spoke, never in the translation language).
 */
export const MAX_ANSWER_CONTEXT_TURNS = 5;
export const MAX_ANSWER_CONTEXT_TURN_CHARS = 600;

export interface InterviewAnswerRequestPayload {
  /** The latest interviewer utterance (the source transcript). */
  text: string;
  /** Answer language hint: the source language, e.g. 'en' or 'ko'. */
  language: string;
  /** Recent finalized interview utterances, oldest first, bounded. */
  recentContext: string[];
}

const normalize = (text: string): string => String(text || '').replace(/\s+/g, ' ').trim();

export function buildAnswerRequest(
  text: string,
  recentUtterances: readonly string[],
  sourceLanguage: string,
): InterviewAnswerRequestPayload {
  const turns = recentUtterances
    .map(normalize)
    .filter((turn) => turn.length > 0)
    .slice(-MAX_ANSWER_CONTEXT_TURNS)
    .map((turn) => turn.slice(0, MAX_ANSWER_CONTEXT_TURN_CHARS));

  return {
    text: normalize(text),
    language: String(sourceLanguage || 'en').trim() || 'en',
    recentContext: turns,
  };
}
