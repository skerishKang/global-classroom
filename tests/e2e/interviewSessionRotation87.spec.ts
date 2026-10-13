import { test, expect } from '@playwright/test';

/**
 * #87 — microphone audio must survive a Live transcription session rotation in a
 * real browser.
 *
 * The rotation fires at LIVE_SESSION_ROTATE_MS (9m20s) and awaits a fresh
 * ephemeral token plus a new WebSocket. The outgoing session is invalidated
 * before that await, so on main every microphone frame produced while the new
 * session was still connecting was sent to a session whose callbacks no longer
 * reported anything: the audio was transcribed and discarded, and the incoming
 * session never received the start of the sentence.
 *
 * The provider is faked here (no Gemini call, no key). This proves the client's
 * audio hand-off, not the provider's accuracy — the real long-form accuracy
 * measurement is reported separately.
 */
const ROTATE_MS = 9 * 60_000 + 20_000;

/**
 * Shared browser-side harness. Fakes the Live WebSocket, the legacy
 * ScriptProcessor capture path, the token endpoint and the follow-up API calls,
 * and exposes `window.__rotateProbe` so a spec can drive and observe rotations.
 */
const installRotationHarness = () => {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/live-token')) {
      return new Response(JSON.stringify({ token: 'e2e-fake-token' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/detect-language')) {
      return new Response(JSON.stringify({ code: 'en' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/translate')) {
      const body = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ translated: `KO:${body.text}`, provider: 'test' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/interview-answer')) {
      return new Response(JSON.stringify({ shouldAnswer: false, answer: '', language: 'en' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input, init);
  };

  const fakeTrack = { stop: () => {} } as unknown as MediaStreamTrack;
  const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => fakeStream },
  });

  /** Legacy ScriptProcessor nodes, so the test can push real PCM frames. */
  const processors: any[] = [];
  class FakeAudioContext {
    sampleRate = 16000;
    audioWorklet = undefined; // force the legacy capture path
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
    createScriptProcessor() {
      const node: any = { onaudioprocess: null, connect: () => {}, disconnect: () => {} };
      processors.push(node);
      return node;
    }
  }
  (window as any).AudioContext = FakeAudioContext;
  (window as any).webkitAudioContext = FakeAudioContext;

  const sockets: any[] = [];
  /** Open sockets whose handshake the test releases on purpose. */
  const pendingOpens: Array<() => void> = [];

  class FakeLiveSocket {
    readyState = 0;
    onopen: ((event?: unknown) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;
    onclose: ((event?: unknown) => void) | null = null;
    model = '';
    frames: string[] = [];
    closed = false;
    constructor(readonly url: string) {
      if (!url.includes('generativelanguage.googleapis.com')) return;
      sockets.push(this);
      let released = false;
      const open = () => {
        if (released) return;
        released = true;
        this.readyState = 1;
        this.onopen?.({});
      };
      // Only the session the test is waiting for is held; everything else
      // handshakes immediately. A microtask (not a timer) is used so the
      // fake clock can stay frozen from page load onwards.
      if (probeState.holdNextOpen) {
        pendingOpens.push(open);
      } else {
        queueMicrotask(open);
      }
    }
    emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
    send(raw: string) {
      const message = JSON.parse(raw);
      if (message.setup) {
        this.model = String(message.setup.model || '');
        this.emit({ setupComplete: {} });
      }
      // The SDK sends mic audio as realtimeInput.mediaChunks[].data.
      const chunk = message?.realtimeInput?.mediaChunks?.[0];
      const audio = chunk?.data ?? chunk?.inlineData?.data
        ?? message?.realtimeInput?.media?.inlineData?.data;
      if (typeof audio === 'string') this.frames.push(audio);
    }
    close() { this.readyState = 3; this.closed = true; }
  }
  (window as any).WebSocket = FakeLiveSocket;

  const probeState = { holdNextOpen: false };
  let frameCounter = 0;
  (window as any).__rotateProbe = {
    setHold: (value: boolean) => { probeState.holdNextOpen = value; },
    /** A socket that never handshakes has no model yet, so count creations
     * separately from model classification. */
    created: () => sockets.length,
    /** Frame counts for every socket already identified as a transcriber. */
    transcribeFrames: () => sockets
      .filter((socket) => socket.model.includes('transcribe'))
      .map((socket) => socket.frames.length),
    /** Push one 2048-sample PCM frame through the capture callback. */
    emitFrame() {
      frameCounter += 1;
      const marker = String(frameCounter).padStart(4, '0');
      for (const node of processors) {
        if (!node.onaudioprocess) continue;
        const channel = new Float32Array(2048);
        // Encode the marker in the first samples so frames are identifiable.
        for (let i = 0; i < marker.length; i += 1) channel[i] = Number(marker[i]) / 9;
        node.onaudioprocess({ inputBuffer: { getChannelData: () => channel } });
      }
      return marker;
    },
    /** Release the handshake of the newest pending session. */
    openNext() {
      const open = pendingOpens.shift();
      open?.();
      return Boolean(open);
    },
    /**
     * Deliver an `inputTranscription` chunk on the session that is already
     * retired, the way the provider does when it finalises cached audio.
     */
    emitOnRetired(text: string, finished: boolean) {
      const socket = sockets.find((item) => item.model.includes('transcribe'));
      socket?.emit({ serverContent: { inputTranscription: { text, finished } } });
      return Boolean(socket);
    },
    /** Deliver an `inputTranscription` chunk on the newest live transcriber. */
    emitLatest(text: string, finished: boolean) {
      const socket = [...sockets].reverse().find((item) => item.model.includes('transcribe'));
      socket?.emit({ serverContent: { inputTranscription: { text, finished } } });
      return Boolean(socket);
    },
    rows: () => document.querySelectorAll('[data-testid="interview-row"]').length,
    pending: () => pendingOpens.length,
  };
};

test.describe('Interview Live session rotation (#87)', () => {
  test('frames captured while the new session connects are delivered to it', async ({ page }) => {
    await page.addInitScript(installRotationHarness);

    // The rotation timer is scheduled during page init, so the clock must be
    // fake before navigation for it to be advanceable at all.
    await page.clock.install();
    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    await page.getByTitle(/마이크 켜기/).first().click();
    await expect(page.getByTitle(/마이크 끄기/).first()).toBeVisible({ timeout: 10000 });

    const probe = () => (page as any).evaluate(() => ({
      created: (window as any).__rotateProbe.created(),
      transcribe: (window as any).__rotateProbe.transcribeFrames(),
    }));

    // Baseline: one transcribe session, receiving audio.
    await page.evaluate(() => (window as any).__rotateProbe.emitFrame());
    let state = await probe();
    expect(state.transcribe).toEqual([1]);
    const createdBefore = state.created;

    // Hold the rotation handshake open so the gap is observable, then freeze
    // time so the 9m20s rotation timer fires without waiting for it.
    await page.evaluate(() => (window as any).__rotateProbe.setHold(true));
    await page.clock.fastForward(ROTATE_MS + 1_000);

    state = await probe();
    expect(state.created, 'a replacement session should be connecting').toBe(createdBefore + 1);
    // It has not handshaked yet, so it is not yet classified as a transcriber.
    expect(state.transcribe).toEqual([1]);

    const gapMarkers: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      gapMarkers.push(await page.evaluate(() => (window as any).__rotateProbe.emitFrame()));
    }

    // The old session must not keep receiving audio it can no longer report.
    state = await probe();
    expect(state.transcribe).toEqual([1]);

    // CENTRAL gate #1: the provider finalises the retired session's audio *during*
    // the handshake gap. Before the fix those chunks had nowhere to go — the old
    // generation was already invalid and the flush was only armed after connect.
    const tailDelivered = await page.evaluate(() => (
      (window as any).__rotateProbe.emitOnRetired('the final ', false)
      && (window as any).__rotateProbe.emitOnRetired('sentence.', true)
    ));
    expect(tailDelivered, 'the retired session must still be reachable').toBe(true);

    const rows = page.getByTestId('interview-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('the final sentence.');

    await page.evaluate(() => (window as any).__rotateProbe.openNext());
    await page.clock.runFor(200);

    // The incoming session got exactly the frames produced during the gap, and the
    // retired tail was neither dropped nor re-emitted once it started reporting.
    state = await probe();
    expect(state.transcribe, `gap frames were: ${gapMarkers.join(',')}`).toEqual([1, 3]);
    await expect(rows).toHaveCount(1);
  });

  test('four consecutive rotations past 30 virtual minutes keep every generation fed', async ({ page }) => {
    await page.addInitScript(installRotationHarness);
    await page.clock.install();
    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    await page.getByTitle(/마이크 켜기/).first().click();
    await expect(page.getByTitle(/마이크 끄기/).first()).toBeVisible({ timeout: 10000 });

    const probe = () => page.evaluate(() => ({
      created: (window as any).__rotateProbe.created(),
      transcribe: (window as any).__rotateProbe.transcribeFrames(),
      pending: (window as any).__rotateProbe.pending(),
    }));

    // Seed the first generation so it is classified as a transcriber.
    await page.evaluate(() => (window as any).__rotateProbe.emitFrame());
    const seed = await probe();
    expect(seed.transcribe).toEqual([1]);
    const createdBefore = seed.created;

    // Four rotations = 37m20s of virtual time, well past the vendor's ~10 minute
    // session limit, so the re-scheduling of the rotation timer is exercised.
    const ROTATIONS = 4;
    for (let index = 1; index <= ROTATIONS; index += 1) {
      await page.evaluate(() => (window as any).__rotateProbe.setHold(true));
      await page.clock.fastForward(ROTATE_MS + 1_000);

      let state = await probe();
      expect(state.created, `rotation ${index} must open a replacement`).toBe(createdBefore + index);
      // The replacement has not handshaked, so it is not yet a transcriber.
      expect(state.transcribe.length, `rotation ${index} replacement is connecting`).toBe(index);

      // A frame produced during the handshake gap must be buffered, not handed to
      // the generation that is already invalid.
      await page.evaluate(() => (window as any).__rotateProbe.emitFrame());

      await page.evaluate(() => (window as any).__rotateProbe.openNext());
      await page.clock.runFor(200);
      // The new generation received the buffered gap frame plus a fresh one.
      await page.evaluate(() => (window as any).__rotateProbe.emitFrame());

      state = await probe();
      expect(state.pending, `rotation ${index} handshake should be released`).toBe(0);
      expect(state.transcribe.length, `rotation ${index} generation is live`).toBe(index + 1);
      expect(state.transcribe.at(-1), `rotation ${index} received the gap + post audio`).toBe(2);
    }

    // Every generation kept its audio; none was dropped across 37 virtual minutes.
    const final = await probe();
    expect(final.created).toBe(createdBefore + ROTATIONS);
    expect(final.transcribe).toEqual([1, 2, 2, 2, 2]);

    // The microphone never fell back to Browser/Groq STT.
    await expect(page.getByTitle(/마이크 끄기/).first()).toBeVisible();

    // One utterance finalised on the newest generation renders exactly one row, so
    // the rotations neither duplicated nor cross-contaminated rows.
    const rows = page.getByTestId('interview-row');
    await page.evaluate(() => (window as any).__rotateProbe.emitLatest('Thirty seven minutes later.', true));
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Thirty seven minutes later.');

    // A second utterance on the same generation still becomes its own row.
    await page.evaluate(() => (window as any).__rotateProbe.emitLatest('Still transcribing clearly.', true));
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('Still transcribing clearly.');
  });
});
