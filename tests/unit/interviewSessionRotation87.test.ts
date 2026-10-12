/**
 * #87 — session rotation must not lose microphone audio.
 *
 * The Interview mic rotates its Gemini Live transcription session at
 * LIVE_SESSION_ROTATE_MS, before the vendor's ~10 minute limit. The outgoing
 * session is invalidated *before* `await connectTranscribeSession()`, so on main
 * every frame produced during that await was sent to a session whose callbacks
 * were already inert: the audio was transcribed and then discarded, and the
 * incoming session never saw the start of the sentence.
 *
 * The repo ships without jsdom/@testing-library, so the hook runs against a
 * minimal React dispatcher (same approach as liveSharingLifecycle33) with the
 * provider, the capture layer and the translation lane replaced by
 * record-and-replay doubles. No network and no real provider is touched.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const reactRuntime = vi.hoisted(() => {
  let hookIndex = 0;
  const refSlots: Array<{ current: unknown }> = [];
  const stateSlots: unknown[] = [];

  return {
    useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
      const index = hookIndex++;
      if (!(index in stateSlots)) {
        stateSlots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      const setState = (next: T | ((prev: T) => T)) => {
        const prev = stateSlots[index] as T;
        stateSlots[index] = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        void prev;
      };
      return [stateSlots[index] as T, setState];
    },
    useRef<T>(initial: T) {
      const index = hookIndex++;
      if (!(index in refSlots)) refSlots[index] = { current: initial };
      return refSlots[index] as { current: T };
    },
    useCallback<T>(fn: T, _deps: unknown[]) {
      hookIndex++;
      return fn;
    },
    /** Re-enter the component: slots persist, only the cursor resets. */
    rewind() {
      hookIndex = 0;
    },
    reset() {
      hookIndex = 0;
      refSlots.length = 0;
      stateSlots.length = 0;
    },
  };
});

vi.mock('react', () => ({
  useState: reactRuntime.useState,
  useRef: reactRuntime.useRef,
  useCallback: reactRuntime.useCallback,
}));

const net = vi.hoisted(() => ({
  transcribeSessions: [] as any[],
  /** When set, the next transcribe connect waits on it: a controllable gap. */
  gate: null as Promise<void> | null,
  failNextConnect: false,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    live = {
      connect: async (options: any): Promise<unknown> => {
        const model = String(options.model || '');
        if (!model.includes('transcribe')) {
          return { sendRealtimeInput: () => {}, close: () => {}, callbacks: {} };
        }
        if (net.failNextConnect) throw new Error('connect refused');
        const session: any = {
          kind: model,
          frames: [] as string[],
          /** `audioStreamEnd` calls, counted separately so they cannot masquerade as audio. */
          endSignals: 0,
          closed: false,
          callbacks: options.callbacks || {},
          sendRealtimeInput: (input: { media?: { data?: string }; audioStreamEnd?: boolean }) => {
            if (input?.audioStreamEnd) {
              session.endSignals += 1;
              return;
            }
            session.frames.push(String(input?.media?.data ?? ''));
          },
          close: () => { session.closed = true; },
          /** The provider finalising audio it already holds: one message, one tail. */
          emitTail: (text: string) => session.callbacks.onmessage({
            serverContent: { inputTranscription: { text, finished: true } },
          }),
        };
        net.transcribeSessions.push(session);
        if (net.gate) await net.gate;
        session.callbacks.onopen?.({});
        return session;
      },
    };
    constructor(_options: unknown) {}
  },
}));

const capture = vi.hoisted(() => ({ onPcm: null as null | ((buffer: ArrayBuffer) => void) }));

vi.mock('../../utils/interviewAudioCapture', () => ({
  startInterviewAudioCapture: async (
    _context: unknown,
    _stream: unknown,
    onPcm: (buffer: ArrayBuffer) => void,
  ) => {
    capture.onPcm = onPcm;
    return { mode: 'worklet' as const, stop: () => { capture.onPcm = null; } };
  },
}));

vi.mock('../../utils/interviewTranslationSessions', () => ({
  InterviewTranslationSessions: class {
    activeUtteranceId = 'utt-1';
    rotations = 0;
    async start() { return false; }
    feedAudio(_media: unknown) {}
    rotate() { this.rotations += 1; return this.activeUtteranceId; }
    stop() {}
  },
}));

import { useInterviewLive } from '../../hooks/useInterviewLive';
import {
  LIVE_AUDIO_HANDOFF_FRAMES,
  LIVE_SESSION_ROTATE_MS,
  LIVE_TAIL_FLUSH_DRAIN_MS,
  createAudioHandoffBuffer,
  flushLiveTranscriptTail,
} from '../../utils/liveTranscriptTurn';

type Scheduled = { id: number; fn: () => void; ms: number };

let scheduled: Scheduled[] = [];
let nextTimerId = 1;
let warnings: string[] = [];
let finalRows: Array<{ text: string; utteranceId: string }> = [];

function installBrowserShims() {
  scheduled = [];
  nextTimerId = 1;

  (globalThis as any).window = {    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimerId++;
      scheduled.push({ id, fn, ms: Number(ms) });
      return id;
    },
    clearTimeout: (id: number) => { scheduled = scheduled.filter((item) => item.id !== id); },
    setInterval: (fn: () => void, ms: number) => {
      const id = nextTimerId++;
      scheduled.push({ id, fn, ms: Number(ms) });
      return id;
    },
    clearInterval: (id: number) => { scheduled = scheduled.filter((item) => item.id !== id); },
    AudioContext: class {
      sampleRate = 16000;
      audioWorklet = undefined;
      destination = {};
      async resume() {}
      async close() {}
      createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
      createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
      createAnalyser() {
        return {
          fftSize: 256, frequencyBinCount: 128,
          connect: () => {}, disconnect: () => {}, getByteFrequencyData: () => {},
        };
      }
      createScriptProcessor() { return { onaudioprocess: null, connect: () => {}, disconnect: () => {} }; }
    },
  };
  // Node 22 exposes a real getter-only `navigator`, so it must be redefined
  // rather than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      language: 'en-US',
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
    },
  });
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({ token: 'fake-ephemeral-token' }),
  });
}

/** A frame's identity is its base64 payload, so delivery is assertable per session. */
function frameFor(marker: string): string {
  const pcm = new Int16Array(2048);
  for (let i = 0; i < marker.length; i += 1) pcm[i] = marker.charCodeAt(i);
  return Buffer.from(pcm.buffer).toString('base64');
}

function injectFrame(marker: string): string {
  const pcm = new Int16Array(2048);
  for (let i = 0; i < marker.length; i += 1) pcm[i] = marker.charCodeAt(i);
  capture.onPcm!(pcm.buffer);
  return frameFor(marker);
}

function fireRotation() {
  const timer = scheduled.find((item) => item.ms === LIVE_SESSION_ROTATE_MS);
  if (!timer) throw new Error('the session rotation timer was never scheduled');
  timer.fn();
}

/** Let every queued microtask and immediate run, so the async rotation settles. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function renderHook() {
  let current: any;
  const run = () => {
    reactRuntime.rewind();
    current = useInterviewLive({
      onInterimTranscript: () => {},
      onFinalTranscript: (text: string, utteranceId: string) => finalRows.push({ text, utteranceId }),
      onUtteranceStart: () => {},
      onLiveTranslation: () => {},
      onWarning: (message: string) => warnings.push(message),
    });
    return current;
  };
  run();
  return { get current() { return current; }, rerun: run };
}

async function startMic() {
  const hook = renderHook();
  await hook.current.start();
  await settle();
  expect(net.transcribeSessions).toHaveLength(1);
  return hook;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  reactRuntime.reset();
  net.transcribeSessions = [];
  net.gate = null;
  net.failNextConnect = false;
  warnings = [];
  finalRows = [];
  installBrowserShims();
});

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).navigator;
  delete (globalThis as any).fetch;
});

describe('#87 rotation timer', () => {
  test('a rotation is scheduled before the vendor session limit', async () => {
    await startMic();
    expect(scheduled.some((item) => item.ms === LIVE_SESSION_ROTATE_MS)).toBe(true);
    expect(LIVE_SESSION_ROTATE_MS).toBeLessThan(10 * 60_000);
  });

  test('frames reach the live session untouched when no rotation is in flight', async () => {
    const hook = await startMic();
    const first = net.transcribeSessions[0];
    const frame = injectFrame('aaaa');
    expect(first.frames).toEqual([frame]);
    hook.rerun();
    expect(hook.current.backend).toBe('gemini');
    expect(hook.current.status).toBe('live');
  });
});

describe('#87 audio continuity across the rotation gap', () => {
  test('frames produced while the new session connects are replayed in order', async () => {
    await startMic();
    const outgoing = net.transcribeSessions[0];
    injectFrame('pre0');
    expect(outgoing.frames).toHaveLength(1);

    const gate = deferred();
    net.gate = gate.promise;
    fireRotation();
    await settle();

    const gap1 = injectFrame('gap1');
    const gap2 = injectFrame('gap2');

    // The defect on main: both frames were handed to the invalidated session and
    // their transcripts were then thrown away by the generation guard.
    expect(outgoing.frames).toHaveLength(1);
    // The connecting session exists but is not yet the active one, so it has
    // received nothing at this point.
    expect(net.transcribeSessions[1].frames).toEqual([]);

    gate.resolve();
    await settle();

    const incoming = net.transcribeSessions[1];
    expect(incoming.frames).toEqual([gap1, gap2]);

    // #87: the retired session is told the stream ended, so its socket stays open
    // for the bounded drain instead of being closed with audio still inside it.
    expect(outgoing.endSignals).toBe(1);
    expect(outgoing.frames).toEqual([frameFor('pre0')]);
    expect(outgoing.closed).toBe(false);

    // The tail it then finalises becomes a row, and only now does it close.
    outgoing.emitTail('…under a very tight deadline.');
    expect(outgoing.closed).toBe(true);
    expect(finalRows.map((row) => row.text)).toEqual(['…under a very tight deadline.']);

    // A second chunk from the same retired session must not create a second row.
    outgoing.emitTail('…under a very tight deadline.');
    expect(finalRows).toHaveLength(1);
  });

  test('nothing is delivered twice across the boundary', async () => {
    await startMic();
    const outgoing = net.transcribeSessions[0];
    const before = injectFrame('aaaa');

    const gate = deferred();
    net.gate = gate.promise;
    fireRotation();
    await settle();
    const during = injectFrame('bbbb');
    gate.resolve();
    await settle();

    const delivered = [...outgoing.frames, ...net.transcribeSessions[1].frames];
    expect(delivered).toEqual([before, during]);
    expect(new Set(delivered).size).toBe(2);
  });

  test('an utterance straddling the boundary commits once and carries the tail forward', async () => {
    await startMic();
    const outgoing = net.transcribeSessions[0];

    // The transcriber had already heard part of the sentence.
    outgoing.callbacks.onmessage({
      serverContent: { inputTranscription: { text: 'Could you tell me which', finished: false } },
    });

    const gate = deferred();
    net.gate = gate.promise;
    fireRotation();
    await settle();

    const tail = injectFrame('tail');
    gate.resolve();
    await settle();

    expect(finalRows.map((row) => row.text)).toEqual(['Could you tell me which']);
    expect(net.transcribeSessions[1].frames).toEqual([tail]);
    // No microphone frame reached the retired session, and it was signalled rather
    // than silently closed.
    expect(outgoing.frames).toEqual([]);
    expect(outgoing.endSignals).toBe(1);
  });

  test('a rotation that fails releases the capture path and warns truthfully', async () => {
    const hook = await startMic();
    net.failNextConnect = true;

    fireRotation();
    await settle();

    // The user is told the Gemini lane could not be renewed, and the microphone
    // moves to the fallback chain instead of buffering audio forever.
    expect(warnings.join(' ')).toContain('세션 갱신');
    hook.rerun();
    expect(hook.current.backend).not.toBe('gemini');
    expect(net.transcribeSessions).toHaveLength(1);
  });
});

describe('#87 handoff buffer semantics', () => {
  test('capturing is off until a rotation starts, and off again after release', () => {
    const buffer = createAudioHandoffBuffer<number>(3);
    expect(buffer.capturing).toBe(false);
    expect(buffer.push(1)).toBe(false); // not capturing: caller keeps sending normally
    expect(buffer.size).toBe(0);

    buffer.start();
    expect(buffer.capturing).toBe(true);
    expect(buffer.push(1)).toBe(true);
    expect(buffer.release()).toEqual([1]);
    expect(buffer.capturing).toBe(false);
    expect(buffer.push(2)).toBe(false);
  });

  test('release preserves arrival order and can only be drained once', () => {
    const buffer = createAudioHandoffBuffer<number>(5);
    buffer.start();
    [1, 2, 3].forEach((frame) => buffer.push(frame));
    expect(buffer.release()).toEqual([1, 2, 3]);
    expect(buffer.release()).toEqual([]);
  });

  test('overflow is counted, never silent', () => {
    const buffer = createAudioHandoffBuffer<number>(2);
    buffer.start();
    expect(buffer.push(1)).toBe(true);
    expect(buffer.push(2)).toBe(true);
    expect(buffer.push(3)).toBe(false);
    expect(buffer.droppedFrames).toBe(1);
    expect(buffer.release()).toEqual([1, 2]);
    // A bounded buffer must not grow past its cap over repeated rotations.
    expect(buffer.size).toBe(0);
  });

  test('reset abandons captured frames without emitting them', () => {
    const buffer = createAudioHandoffBuffer<number>(4);
    buffer.start();
    buffer.push(1);
    buffer.reset();
    expect(buffer.size).toBe(0);
    expect(buffer.capturing).toBe(false);
    expect(buffer.release()).toEqual([]);
  });

  test('the cap covers several seconds of microphone audio', () => {
    // 2048 samples at 16kHz is 128ms per frame, so 40 frames is ~5.1s.
    expect(LIVE_AUDIO_HANDOFF_FRAMES * 128).toBeGreaterThanOrEqual(5_000);
    expect(LIVE_AUDIO_HANDOFF_FRAMES * 128).toBeLessThan(LIVE_SESSION_ROTATE_MS);
  });
});

/** A clock the test drives, so a drain deadline is assertable without waiting. */
function manualTimers() {
  const queued: Array<{ delay: number; run: () => void }> = [];
  return {
    queued,
    setTimer: (callback: () => void, ms: number) => {
      const entry = { delay: ms, run: callback };
      queued.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle: unknown) => {
      const index = queued.indexOf(handle as { delay: number; run: () => void });
      if (index >= 0) queued.splice(index, 1);
    },
    fireAll: () => queued.splice(0).forEach((entry) => entry.run()),
  };
}

function fakeSession(input?: { throws?: boolean }) {
  const state = { signals: [] as unknown[], closes: 0 };
  return {
    state,
    session: {
      sendRealtimeInput: (signal: unknown) => {
        if (input?.throws) throw new Error('socket already gone');
        state.signals.push(signal);
      },
      close: () => { state.closes += 1; },
    },
  };
}

describe('#87 tail flush mechanics', () => {
  test('the outgoing session is told the stream ended, and only that', () => {
    const timers = manualTimers();
    const { session, state } = fakeSession();
    flushLiveTranscriptTail(session, {
      onSettled: () => {},
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(state.signals).toEqual([{ audioStreamEnd: true }]);
    expect(state.closes).toBe(0);
  });

  test('the first non-empty tail settles it once and closes exactly once', () => {
    const timers = manualTimers();
    const { session, state } = fakeSession();
    const settled: Array<string | null> = [];
    const flush = flushLiveTranscriptTail(session, {
      onSettled: (text) => settled.push(text),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    // An empty hypothesis is not a finalised tail.
    expect(flush.accept('')).toBe(false);
    expect(flush.accept('   ')).toBe(false);
    expect(state.closes).toBe(0);

    const tail = 'and only after that did I start investigating the root cause.';
    expect(flush.accept(tail)).toBe(true);
    // A backend that re-sends the same turn cannot emit the tail twice.
    expect(flush.accept(tail)).toBe(false);

    expect(settled).toEqual([tail]);
    expect(state.closes).toBe(1);
    expect(timers.queued).toHaveLength(0);
  });

  test('a session that never answers is closed on the bounded deadline', () => {
    const timers = manualTimers();
    const { session, state } = fakeSession();
    const settled: Array<string | null> = [];
    flushLiveTranscriptTail(session, {
      onSettled: (text) => settled.push(text),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(timers.queued.map((entry) => entry.delay)).toEqual([LIVE_TAIL_FLUSH_DRAIN_MS]);
    timers.fireAll();
    // `null` still reports: teardown must commit what the session already said.
    expect(settled).toEqual([null]);
    expect(state.closes).toBe(1);
    timers.fireAll();
    expect(state.closes).toBe(1);
  });

  test('cancelling the wait keeps the words that were already captured', () => {
    const timers = manualTimers();
    const { session, state } = fakeSession();
    const settled: Array<string | null> = [];
    const flush = flushLiveTranscriptTail(session, {
      onSettled: (text) => settled.push(text),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    flush.cancel();
    expect(settled).toEqual([null]);
    expect(state.closes).toBe(1);
    expect(flush.accept('late')).toBe(false);
    expect(state.closes).toBe(1);
  });

  test('a session that cannot be signalled is closed instead of left open', () => {
    const timers = manualTimers();
    const { session, state } = fakeSession({ throws: true });
    const settled: Array<string | null> = [];
    flushLiveTranscriptTail(session, {
      onSettled: (text) => settled.push(text),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(settled).toEqual([null]);
    expect(state.closes).toBe(1);
    expect(timers.queued).toHaveLength(0);
  });

  test('nothing is armed when there is no session to flush', () => {
    const flush = flushLiveTranscriptTail(null, {
      onSettled: () => { throw new Error('a null session must not report'); },
    });
    expect(flush.armed).toBe(false);
    expect(flush.accept('x')).toBe(false);
    flush.cancel();
  });

  test('the drain window covers the measured provider flush latency but stays short', () => {
    // Live provider, one 28.7s utterance: the tail chunk arrived 261ms after
    // `audioStreamEnd`. Teardown must not be pinned by a dead socket.
    expect(LIVE_TAIL_FLUSH_DRAIN_MS).toBeGreaterThanOrEqual(4 * 261);
    expect(LIVE_TAIL_FLUSH_DRAIN_MS).toBeLessThan(2_000);
  });
});

describe('#87 tail flush on mute and teardown', () => {
  test('muting right after a sentence flushes its tail instead of losing it', async () => {
    const hook = await startMic();
    const session = net.transcribeSessions[0];

    // Provider form for an unfinished turn: the chunk carries its trailing space.
    session.callbacks.onmessage({
      serverContent: {
        inputTranscription: { text: 'Then I rolled the service back to the previous stable ', finished: false },
      },
    });
    expect(finalRows).toEqual([]);

    hook.current.stop();
    await settle();
    expect(session.endSignals).toBe(1);
    // Before the fix this text was dropped by `turnBuffer.reset()` and the socket
    // closed without a finalisation signal (measured 51/64 words recovered).
    expect(session.closed).toBe(false);

    session.emitTail('build.');
    expect(finalRows.map((row) => row.text)).toEqual([
      'Then I rolled the service back to the previous stable build.',
    ]);
    expect(session.closed).toBe(true);
  });

  test('a tail that never arrives still commits what the session already said', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hook = await startMic();
      const session = net.transcribeSessions[0];
      session.callbacks.onmessage({
        serverContent: { inputTranscription: { text: 'under a very tight deadline', finished: false } },
      });

      hook.current.stop();
      await vi.advanceTimersByTimeAsync(LIVE_TAIL_FLUSH_DRAIN_MS - 1);
      expect(finalRows).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(finalRows.map((row) => row.text)).toEqual(['under a very tight deadline']);
      expect(session.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a retired session cannot write into the next session turn', async () => {
    const hook = await startMic();
    const retired = net.transcribeSessions[0];
    hook.current.stop();
    await settle();
    await hook.current.start();
    await settle();
    expect(net.transcribeSessions).toHaveLength(2);

    // Its flush already settled at the restart, so a late chunk from that
    // generation must not surface as a row or leak into the live turn.
    retired.emitTail('stale tail from a closed session');
    expect(finalRows).toEqual([]);

    const live = net.transcribeSessions[1];
    live.callbacks.onmessage({
      serverContent: { inputTranscription: { text: 'What I did first', finished: false } },
    });
    live.callbacks.onmessage({
      serverContent: { inputTranscription: { text: ' was to look at the history', finished: true } },
    });
    expect(finalRows.map((row) => row.text)).toEqual(['What I did first was to look at the history']);
  });

  test('stopping twice does not leave two sessions draining', async () => {
    const hook = await startMic();
    const session = net.transcribeSessions[0];
    hook.current.stop();
    hook.current.stop();
    await settle();
    expect(session.endSignals).toBe(1);
  });
});
