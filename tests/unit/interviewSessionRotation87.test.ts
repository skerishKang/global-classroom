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
          closed: false,
          callbacks: options.callbacks || {},
          sendRealtimeInput: (input: { media?: { data?: string } }) => {
            session.frames.push(String(input?.media?.data ?? ''));
          },
          close: () => { session.closed = true; },
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
  createAudioHandoffBuffer,
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
    expect(outgoing.closed).toBe(true);
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
    expect(outgoing.frames).toEqual([]);
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
