import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GROQ_MAX_CHUNK_MS,
  GROQ_MIN_CHUNK_MS,
  GROQ_SILENCE_CUT_MS,
  LIVE_SESSION_ROTATE_MS,
  TRANSCRIPT_TURN_STALL_MS,
  LIVE_TRANSCRIBE_MODEL,
  LIVE_VAD_SILENCE_MS,
  createTranscriptTurnBuffer,
  mergeLiveTranscriptChunk,
  resolveRecognitionLanguage,
  shouldCutGroqChunk,
  shouldFlushStalledTurn,
  startSpeechSilenceProbe,
} from '../../utils/liveTranscriptTurn';

const interviewHookSource = () =>
  readFileSync(join(process.cwd(), 'hooks/useInterviewLive.ts'), 'utf8');
const normalHookSource = () =>
  readFileSync(join(process.cwd(), 'hooks/useGeminiLive.ts'), 'utf8');

describe('#87 Live transcription turn authority', () => {
  test('delta and cumulative hypotheses merge without duplication', () => {
    expect(mergeLiveTranscriptChunk('', 'Could you tell me')).toBe('Could you tell me');
    expect(mergeLiveTranscriptChunk('Could you tell me', ' which city')).toBe(
      'Could you tell me which city',
    );
    // Cumulative hypothesis: the replay must replace, not append.
    expect(
      mergeLiveTranscriptChunk('Could you tell me', 'Could you tell me which city'),
    ).toBe('Could you tell me which city');
    // Replayed delta: the duplicate must not be appended twice.
    expect(mergeLiveTranscriptChunk('Could you tell me', 'me')).toBe('Could you tell me');
    expect(mergeLiveTranscriptChunk('', '')).toBe('');
  });

  test('two chunks of one Live turn produce exactly one final row', () => {
    const turn = createTranscriptTurnBuffer();

    turn.merge('Could you tell me');
    turn.merge(' which city you grew up in?');
    // Merging chunks emits nothing: only the turn boundary creates a row.
    expect(turn.pending).toBe('Could you tell me which city you grew up in?');
    expect(turn.finishTurn()).toBe('Could you tell me which city you grew up in?');
    // A repeated boundary must not duplicate the row.
    expect(turn.finishTurn()).toBeNull();

    turn.merge('Taste the refreshing');
    expect(turn.finishTurn()).toBe('Taste the refreshing');
    expect(turn.finishTurn()).toBeNull();
  });

  test('a turn whose boundary never arrives is flushed instead of held forever', () => {
    expect(shouldFlushStalledTurn({ hasPending: false, sinceLastChunkMs: 60_000 })).toBe(false);
    expect(
      shouldFlushStalledTurn({ hasPending: true, sinceLastChunkMs: TRANSCRIPT_TURN_STALL_MS - 1 }),
    ).toBe(false);
    expect(
      shouldFlushStalledTurn({ hasPending: true, sinceLastChunkMs: TRANSCRIPT_TURN_STALL_MS }),
    ).toBe(true);
    // The stall window must never preempt a normal turn boundary.
    expect(TRANSCRIPT_TURN_STALL_MS).toBeGreaterThan(LIVE_VAD_SILENCE_MS);
  });

  test('an empty or whitespace-only turn never creates a row', () => {
    const turn = createTranscriptTurnBuffer();
    expect(turn.finishTurn()).toBeNull();
    turn.merge('   ');
    expect(turn.finishTurn()).toBeNull();
  });

  test('the activity-detection window no longer ends a turn on a thinking pause', () => {
    // Issue #87 asked for a 1200-1600ms trial window instead of 650ms.
    expect(LIVE_VAD_SILENCE_MS).toBeGreaterThanOrEqual(1200);
    expect(LIVE_VAD_SILENCE_MS).toBeLessThanOrEqual(1600);
  });

  test('the Live session rotates before the provider session limit', () => {
    expect(LIVE_SESSION_ROTATE_MS).toBeLessThan(10 * 60_000);
    expect(LIVE_SESSION_ROTATE_MS).toBeGreaterThan(8 * 60_000);
  });

  test('the Groq fallback cuts at a speech pause, not at a fixed clock', () => {
    const cutAt = (elapsedMs: number, silenceMs: number) =>
      shouldCutGroqChunk({ elapsedMs, silenceMs });

    // The previous fixed 5500ms stop cut mid-sentence while speech continued.
    expect(cutAt(5_500, 0)).toBe(false);
    expect(cutAt(GROQ_MIN_CHUNK_MS - 1, 60_000)).toBe(false);
    expect(cutAt(GROQ_MIN_CHUNK_MS, GROQ_SILENCE_CUT_MS - 1)).toBe(false);
    expect(cutAt(GROQ_MIN_CHUNK_MS, GROQ_SILENCE_CUT_MS)).toBe(true);
    // A monologue that never pauses is still bounded.
    expect(cutAt(GROQ_MAX_CHUNK_MS, 0)).toBe(true);
  });

  test('the browser fallback language follows the hint, then the observed source', () => {
    expect(
      resolveRecognitionLanguage({ hint: 'en', observed: 'ko', navigatorLanguage: 'ko-KR' }),
    ).toBe('en');
    expect(resolveRecognitionLanguage({ observed: 'en', navigatorLanguage: 'ko-KR' })).toBe('en');
    expect(resolveRecognitionLanguage({ navigatorLanguage: 'en-US' })).toBe('en-US');
    // `auto` is not a usable SpeechRecognition language tag.
    expect(resolveRecognitionLanguage({ hint: 'auto', navigatorLanguage: 'ko-KR' })).toBe('ko-KR');
  });

  test('the silence probe is inert without a browser AudioContext', () => {
    expect(startSpeechSilenceProbe({} as MediaStream)).toBeNull();
  });

  test('Interview mode commits per turn through the shared buffer', () => {
    const source = interviewHookSource();

    expect(source).toContain("from '../utils/liveTranscriptTurn'");
    expect(source).toContain('turnBufferRef.current.merge(');
    expect(source).toContain('turnBufferRef.current.finishTurn()');
    expect(source).toContain('shouldFlushStalledTurn');
    expect(source).toContain('TRANSCRIPT_TURN_STALL_MS');
    expect(source).toContain('LIVE_VAD_SILENCE_MS');
    expect(source).toContain('LIVE_SESSION_ROTATE_MS');
    expect(source).toContain('shouldCutGroqChunk');
    expect(source).toContain('resolveRecognitionLanguage');
    // The pre-fix behaviour must not come back.
    expect(source).not.toContain('silenceDurationMs: 650');
    expect(source).not.toContain("recognition.lang = navigator.language || 'ko-KR'");
    expect(source).not.toContain('}, 5500);');
  });

  test('normal mode and Interview mode share one transcription authority', () => {
    const source = normalHookSource();

    expect(LIVE_TRANSCRIBE_MODEL).toBe('gemini-3.5-transcribe-live');
    expect(source).toContain("from '../utils/liveTranscriptTurn'");
    expect(source).toContain('LIVE_VAD_SILENCE_MS');
    expect(source).toContain('shouldCutGroqChunk');
    expect(source).not.toContain('silenceDurationMs: 650');
    expect(source).not.toContain('}, 5500);');
  });
});
