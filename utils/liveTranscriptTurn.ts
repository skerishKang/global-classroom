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

/**
 * Captures microphone frames while the Live transcription session is being
 * swapped (#87).
 *
 * Rotating a session means `await`ing a fresh ephemeral token and a new
 * WebSocket. The outgoing session is invalidated *before* that await, because an
 * old session's callbacks must never be mistaken for a provider failure — so any
 * frame handed to it during the gap is transcribed and then thrown away, and the
 * incoming session never saw the start of the sentence. Buffering the gap and
 * replaying it into the new session is what keeps a long utterance that straddles
 * the rotation boundary intact.
 *
 * The buffer is bounded on purpose. A stalled connect must degrade into a
 * measurable, reportable loss rather than unbounded memory growth, so overflow is
 * counted and never silent.
 */
export type AudioHandoffBuffer<T> = {
  /** True while a rotation is in flight and frames are being captured. */
  readonly capturing: boolean;
  /** Frames currently held, oldest first. */
  readonly size: number;
  /** Frames discarded because the cap was reached. Must stay observable. */
  readonly droppedFrames: number;
  start(): void;
  /**
   * Capture one frame. Returns true when it was buffered (so the caller must not
   * also send it), and false when the cap was reached and it was dropped.
   */
  push(frame: T): boolean;
  /** Hand every captured frame to the caller in arrival order and stop capturing. */
  release(): T[];
  /** Abandon everything captured (teardown, or a rotation that will not be used). */
  reset(): void;
};

export function createAudioHandoffBuffer<T>(maxFrames: number): AudioHandoffBuffer<T> {
  let frames: T[] = [];
  let capturing = false;
  let dropped = 0;

  return {
    get capturing() { return capturing; },
    get size() { return frames.length; },
    get droppedFrames() { return dropped; },
    start() {
      capturing = true;
    },
    push(frame: T) {
      if (!capturing) return false;
      if (frames.length >= maxFrames) {
        dropped += 1;
        return false;
      }
      frames.push(frame);
      return true;
    },
    release() {
      const pending = frames;
      frames = [];
      capturing = false;
      return pending;
    },
    reset() {
      frames = [];
      capturing = false;
    },
  };
}

/**
 * One microphone frame is 2048 samples (both the AudioWorklet and the legacy
 * ScriptProcessor path), i.e. 128ms at the 16kHz the Live API expects. 40 frames
 * therefore cover ~5.1s of connect latency, which is far beyond a normal token
 * fetch plus WebSocket handshake while staying a bounded amount of memory.
 */
export const LIVE_AUDIO_HANDOFF_FRAMES = 40;

/**
 * Finalise the audio a retired Live session still holds (#87).
 *
 * Gemini's activity detection closes a turn only after it has *received* enough
 * silence. A microphone stream that simply stops — a mute, a teardown, or the
 * outgoing half of a rotation — never delivers that silence, so the tail of the
 * sentence stays cached inside the session and dies with the socket. Measured
 * against the live provider on one 28.7s utterance: stopping the stream with no
 * signal transcribed 51/64 ground-truth words and lost the whole final clause,
 * while the identical audio plus `audioStreamEnd` transcribed 62/64 with the
 * final chunk 261ms later.
 *
 * The drain window is deliberately generous against that 261ms observation but
 * bounded: a socket that never answers must not pin the teardown path.
 */
export const LIVE_TAIL_FLUSH_DRAIN_MS = 1_200;

export type LiveTranscribeSessionLike = {
  sendRealtimeInput?: (input: { audioStreamEnd: boolean }) => unknown;
  close?: () => unknown;
};

/** One `inputTranscription` observation from the session being drained. */
export type LiveTailChunk = {
  text?: string | null;
  /** The provider's turn boundary: `finished`, `turnComplete` or `generationComplete`. */
  finished?: boolean;
};

export type LiveTailFlush = {
  /** True while the flush has not settled, so callers can skip redundant work. */
  readonly armed: boolean;
  /**
   * Feed one chunk observed on the draining session. A backend may deliver the tail
   * as several deltas *or* as cumulative hypotheses, so chunks are merged and only a
   * turn boundary settles — closing on the first non-empty chunk would truncate the
   * sentence, which is the very loss this flush exists to prevent. Settling also
   * requires content: a bare boundary that arrives before any text must not close an
   * empty tail.
   *
   * Returns true when the chunk was taken into account, false when it was ignored
   * (already settled, or nothing usable in it).
   */
  accept(chunk: LiveTailChunk): boolean;
  /**
   * Stop waiting for a tail (restart, fallback) and close the session. Anything
   * already captured is still reported: cancelling the wait must not discard words
   * the provider was given, or muting and immediately un-muting would re-open the
   * exact loss this flush exists to close.
   */
  cancel(): void;
};

export function flushLiveTranscriptTail(
  session: LiveTranscribeSessionLike | null,
  {
    onSettled,
    deadlineMs = LIVE_TAIL_FLUSH_DRAIN_MS,
    setTimer = (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimer = (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }: {
    onSettled: (text: string | null) => void;
    deadlineMs?: number;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  },
): LiveTailFlush {
  if (!session) {
    return { armed: false, accept: () => false, cancel: () => {} };
  }

  let settled = false;
  let tail = '';
  let timer: ReturnType<typeof setTimeout> | null = setTimer(() => settle(), deadlineMs);

  /** Close the session and hand over everything received, whether or not it was finalised. */
  function settle() {
    if (settled) return;
    settled = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    try {
      session!.close?.();
    } catch {
      // The socket is going away either way.
    }
    onSettled(tail.trim() ? tail : null);
  }

  try {
    session.sendRealtimeInput?.({ audioStreamEnd: true });
  } catch {
    settle();
  }

  return {
    get armed() {
      return !settled;
    },
    accept(chunk) {
      if (settled) return false;
      const text = typeof chunk?.text === 'string' ? chunk.text : '';
      if (!text.trim()) {
        // A bare boundary is only usable once some text has been captured.
        if (!chunk?.finished || !tail) return false;
        settle();
        return true;
      }
      tail = mergeLiveTranscriptChunk(tail, text);
      if (chunk?.finished) settle();
      return true;
    },
    cancel() {
      settle();
    },
  };
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
