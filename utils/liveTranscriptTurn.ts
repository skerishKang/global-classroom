/**
 * Shared authority for the Gemini Live transcription paths (#87).
 *
 * Normal Global Classroom voice input and Interview mode both consume the same
 * `gemini-3.5-transcribe-live` session, so the chunk handling, the turn boundary
 * and the activity-detection window must live in one place. Diverging copies of
 * this logic are what produced the Interview-mode "multiple partial English
 * rows" regression (issue #87).
 */

export const LIVE_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';

/**
 * How much silence ends a turn. Gemini's automatic activity detection defaults
 * to 800ms; 650ms cut ordinary 0.7-1.5s thinking pauses into separate
 * utterances, so a long sentence was emitted as several final rows. 1300ms keeps
 * typical thinking pauses inside one utterance at the cost of ~0.5s of extra
 * final-row latency.
 */
export const LIVE_VAD_SILENCE_MS = 1300;

/**
 * Live sessions have a vendor-documented duration limit (~10 minutes). Rotate
 * before it instead of letting the session end and permanently dropping the
 * microphone to Browser/Groq speech recognition.
 */
export const LIVE_SESSION_ROTATE_MS = 9 * 60_000 + 20_000;

/**
 * Some Live backends emit cumulative hypotheses while others emit deltas.
 * Accept both without duplicating an already-seen prefix/suffix.
 */
export function mergeLiveTranscriptChunk(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.endsWith(incoming)) return previous;
  return previous + incoming;
}

export type TranscriptTurnBuffer = {
  /** Transcript merged for the turn that is still open. */
  readonly pending: string;
  /**
   * Merge one `inputTranscription` chunk into the open turn. Merging alone never
   * emits a row; only the turn boundary does.
   */
  merge(chunk?: string | null): string;
  /**
   * Turn boundary (`finished` / `turnComplete` / `generationComplete`): returns
   * the single final row for this turn (null when the turn was empty) and opens
   * a fresh turn, so calling it twice cannot duplicate a row.
   */
  finishTurn(): string | null;
  /** Drop the open turn without emitting it (teardown). */
  reset(): void;
};

export function createTranscriptTurnBuffer(): TranscriptTurnBuffer {
  let pending = '';

  return {
    get pending() {
      return pending;
    },
    merge(chunk) {
      if (!chunk) return pending;
      pending = mergeLiveTranscriptChunk(pending, String(chunk));
      return pending;
    },
    finishTurn() {
      const text = pending.trim();
      pending = '';
      return text || null;
    },
    reset() {
      pending = '';
    },
  };
}

/**
 * Groq Whisper fallback chunk boundary (#87).
 *
 * The previous fixed 5500ms stop clipped speech mid-sentence regardless of what
 * was being said. Cut at a speech boundary instead: wait for a real pause once a
 * minimum window has been captured, and keep a hard maximum so the payload
 * stays bounded.
 */
export const GROQ_MIN_CHUNK_MS = 4_000;
export const GROQ_SILENCE_CUT_MS = 700;
export const GROQ_MAX_CHUNK_MS = 20_000;

export function shouldCutGroqChunk(input: {
  elapsedMs: number;
  silenceMs: number;
}): boolean {
  const { elapsedMs, silenceMs } = input;
  if (elapsedMs >= GROQ_MAX_CHUNK_MS) return true;
  if (elapsedMs < GROQ_MIN_CHUNK_MS) return false;
  return silenceMs >= GROQ_SILENCE_CUT_MS;
}

/**
 * Safety net for the turn boundary. Google documents `input_transcription` as
 * the finalized transcript of one speech segment, emitted on a pause; the Live
 * turn boundary (`finished` / `turnComplete`) is what closes a turn. If that
 * boundary never arrives, a stalled turn must still surface instead of being
 * held forever, so a turn whose last chunk is older than this window and that
 * still has pending text is committed as-is.
 */
export const TRANSCRIPT_TURN_STALL_MS = 2_500;

export function shouldFlushStalledTurn(input: {
  hasPending: boolean;
  sinceLastChunkMs: number;
}): boolean {
  return input.hasPending && input.sinceLastChunkMs >= TRANSCRIPT_TURN_STALL_MS;
}

export type SpeechSilenceProbe = {
  /** Milliseconds since speech was last detected on this stream. */
  silenceMs(): number;
  stop(): void;
};

/**
 * Lightweight RMS probe used by the Groq fallback to cut a chunk at a real
 * speech pause (#87). A MediaRecorder stream carries no voice-activity signal,
 * so this is the only local boundary available. Returns null when the browser
 * cannot provide an AudioContext; the bounded maximum still cuts the chunk.
 */
export function startSpeechSilenceProbe(
  stream: MediaStream,
  options?: { threshold?: number; intervalMs?: number },
): SpeechSilenceProbe | null {
  if (typeof window === 'undefined') return null;
  const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor) return null;

  let lastVoiceAt = Date.now();
  let stopped = false;
  let timer: number | null = null;

  try {
    const context: AudioContext = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const threshold = options?.threshold ?? 0.02;

    timer = window.setInterval(() => {
      if (stopped) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const centered = (samples[index] - 128) / 128;
        sum += centered * centered;
      }
      if (Math.sqrt(sum / samples.length) > threshold) lastVoiceAt = Date.now();
    }, options?.intervalMs ?? 150);

    return {
      silenceMs: () => Date.now() - lastVoiceAt,
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) window.clearInterval(timer);
        try {
          source.disconnect();
        } catch {
          // no-op
        }
        void context.close().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}

/**
 * Browser SpeechRecognition has no language identity of its own. Prefer the
 * explicit Interview hint, then the source language the Live transcriber or the
 * detector actually observed, and only then the browser locale.
 */
export function resolveRecognitionLanguage(input: {
  hint?: string;
  observed?: string;
  navigatorLanguage?: string;
}): string {
  const candidate = input.hint || input.observed;
  if (candidate && candidate !== 'auto') return candidate;
  return input.navigatorLanguage || 'ko-KR';
}
