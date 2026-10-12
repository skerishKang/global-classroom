import { test, expect } from '@playwright/test';

/**
 * #87 regression, measured against the live provider first: Gemini's activity
 * detection finalises a turn only after it has *received* silence, so a
 * microphone stream that simply stops (the user muting right after a sentence)
 * leaves the tail of that sentence cached inside the session. Main closed the
 * socket there and dropped the text; one 28.7s utterance lost its whole final
 * clause (51/64 ground-truth words).
 *
 * This spec drives the real browser path — React teardown, @google/genai, a real
 * WebSocket frame — with only the provider endpoint faked.
 */
test.describe('Interview transcription tail flush (#87)', () => {
  test('muting the microphone asks the session to finalise and keeps the tail', async ({ page }) => {
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);

      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/live-token')) {
          return new Response(JSON.stringify({ token: 'e2e-fake-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/detect-language')) {
          return new Response(JSON.stringify({ code: 'en' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/translate')) {
          return new Response(JSON.stringify({ translated: 'KO', provider: 'test' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/interview-answer')) {
          return new Response(
            JSON.stringify({ shouldAnswer: false, answer: '', language: 'en' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return realFetch(input, init);
      };

      const fakeTrack = { stop: () => {} } as unknown as MediaStreamTrack;
      const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => fakeStream },
      });

      class FakeAudioContext {
        sampleRate = 16000;
        destination = {};
        async resume() {}
        async close() {}
        createMediaStreamSource() {
          return { connect: () => {}, disconnect: () => {} };
        }
        createGain() {
          return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
        }
        createAnalyser() {
          return {
            fftSize: 256,
            frequencyBinCount: 128,
            connect: () => {},
            disconnect: () => {},
            getByteFrequencyData: () => {},
          };
        }
        createScriptProcessor() {
          return { onaudioprocess: null, connect: () => {}, disconnect: () => {} };
        }
        createBuffer() {
          return { getChannelData: () => new Float32Array(1) };
        }
        createBufferSource() {
          return { connect: () => {}, start: () => {}, stop: () => {}, onended: null };
        }
      }
      (window as any).AudioContext = FakeAudioContext;
      (window as any).webkitAudioContext = FakeAudioContext;

      const sockets: any[] = [];
      class FakeLiveSocket {
        readyState = 0;
        onopen: ((event?: unknown) => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: ((event?: unknown) => void) | null = null;
        onclose: ((event?: unknown) => void) | null = null;
        model = '';
        frames = 0;
        endSignals = 0;
        closedSockets = 0;
        constructor(readonly url: string) {
          if (!url.includes('generativelanguage.googleapis.com')) return;
          sockets.push(this);
          queueMicrotask(() => {
            this.readyState = 1;
            this.onopen?.({});
          });
        }
        emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
        send(raw: string) {
          const message = JSON.parse(raw);
          if (message.setup) {
            this.model = String(message.setup.model || '');
            this.emit({ setupComplete: {} });
          }
          if (message?.realtimeInput?.mediaChunks?.[0] || message?.realtimeInput?.media) this.frames += 1;
          // `audioStreamEnd` is the only thing that makes the provider flush the
          // audio it is holding, so its presence on the wire is the assertion.
          if (message?.realtimeInput?.audioStreamEnd) this.endSignals += 1;
        }
        close() { this.readyState = 3; this.closedSockets += 1; }
      }
      (window as any).WebSocket = FakeLiveSocket;

      (window as any).__tailProbe = {
        transcribe: () => {
          const socket = sockets.find((item) => item.model.includes('transcribe'));
          return socket
            ? { endSignals: socket.endSignals, closed: socket.closedSockets, frames: socket.frames }
            : null;
        },
        /** One `inputTranscription` chunk from the provider. */
        emit: (text: string, finished: boolean) => {
          for (const socket of sockets) {
            if (socket.model.includes('transcribe')) {
              socket.emit({ serverContent: { inputTranscription: { text, finished } } });
            }
          }
        },
      };
    });

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    await page.getByTitle(/마이크 켜기/).first().click();
    await expect(page.getByTitle(/마이크 끄기/).first()).toBeVisible({ timeout: 10000 });

    const rows = page.getByTestId('interview-row');

    // One turn is open and unfinished: exactly the state a mute lands in.
    await page.evaluate(() => {
      (window as any).__tailProbe.emit('Then I rolled the service back to the previous stable ', false);
    });
    await expect(rows).toHaveCount(0);

    let before = await page.evaluate(() => (window as any).__tailProbe.transcribe());
    expect(before?.endSignals).toBe(0);
    expect(before?.closed).toBe(0);

    await page.getByTitle(/마이크 끄기/).first().click();
    await expect.poll(async () => {
      const state = await page.evaluate(() => (window as any).__tailProbe.transcribe());
      return state?.endSignals;
    }, { timeout: 5000 }).toBe(1);

    before = await page.evaluate(() => (window as any).__tailProbe.transcribe());
    expect(before?.closed).toBe(0); // still draining, not closed on the way out

    await page.evaluate(() => (window as any).__tailProbe.emit('build.', true));
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(
      'Then I rolled the service back to the previous stable build.',
    );

    await expect.poll(async () => {
      const state = await page.evaluate(() => (window as any).__tailProbe.transcribe());
      return state?.closed;
    }, { timeout: 5000 }).toBeGreaterThan(0);
  });
});
