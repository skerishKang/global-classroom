import { test, expect } from '@playwright/test';

/**
 * #87 regression: production emitted several partial English rows for one long
 * sentence because every `inputTranscription` chunk was committed as its own
 * final row. The transcript boundary must be the Live turn, not the chunk.
 */
test.describe('Interview transcription turn boundary (#87)', () => {
  test('several chunks of one utterance render as exactly one row', async ({ page }) => {
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      const mock = {
        finalize(text: string, finished: boolean) {
          for (const socket of sockets) {
            if (socket.model.includes('transcribe')) {
              socket.emit({ serverContent: { inputTranscription: { text, finished } } });
            }
          }
        },
        countRows: () => document.querySelectorAll('[data-testid="interview-row"]').length,
      };
      (window as any).__turnMock = mock;

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
          const body = JSON.parse(String(init?.body || '{}'));
          return new Response(JSON.stringify({ translated: `KO:${body.text}`, provider: 'test' }), {
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
        constructor(readonly url: string) {
          if (url.includes('generativelanguage.googleapis.com')) sockets.push(this);
          setTimeout(() => this.onopen?.({}), 0);
        }
        emit(data: unknown) {
          this.onmessage?.({ data: JSON.stringify(data) });
        }
        send(raw: string) {
          const message = JSON.parse(raw);
          if (message.setup) {
            this.model = String(message.setup.model || '');
            this.emit({ setupComplete: {} });
          }
        }
        close() {
          this.readyState = 3;
        }
      }
      (window as any).WebSocket = FakeLiveSocket;
    });

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    await page.getByTitle(/마이크 켜기/).first().click();
    await expect(page.getByTitle(/마이크 끄기/).first()).toBeVisible({ timeout: 10000 });

    const rows = page.getByTestId('interview-row');
    const sayChunk = (text: string, finished: boolean) =>
      page.evaluate(
        ([value, done]) => (window as any).__turnMock.finalize(value, done),
        [text, finished] as [string, boolean],
      );

    // One utterance, delivered as two chunks the way the Live API emits them.
    await sayChunk('Could you tell me which', false);
    await expect(rows).toHaveCount(0);
    await sayChunk(' city you grew up in?', true);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Could you tell me which city you grew up in?');

    // A second utterance still becomes its own row.
    await sayChunk('Taste the refreshing', false);
    await sayChunk(' drink on a hot day.', true);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('Taste the refreshing drink on a hot day.');
  });

  test('a chunk after turnComplete cannot reopen the finished row', async ({ page }) => {
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      const mock = {
        finish(text: string) {
          for (const socket of sockets) {
            if (socket.model.includes('transcribe')) {
              socket.emit({ serverContent: { inputTranscription: { text, finished: true } } });
            }
          }
        },
        turnComplete() {
          for (const socket of sockets) {
            if (socket.model.includes('transcribe')) {
              socket.emit({ serverContent: { turnComplete: true } });
            }
          }
        },
      };
      (window as any).__turnMock = mock;

      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/live-token')) {
          return new Response(JSON.stringify({ token: 'e2e-fake-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/translate')) {
          const body = JSON.parse(String(init?.body || '{}'));
          return new Response(JSON.stringify({ translated: `KO:${body.text}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/interview-answer')) {
          return new Response(JSON.stringify({ shouldAnswer: false, answer: '', language: 'en' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return realFetch(input, init);
      };

      const fakeTrack = { stop: () => {} } as unknown as MediaStreamTrack;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [fakeTrack] }) },
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
        constructor(readonly url: string) {
          if (url.includes('generativelanguage.googleapis.com')) sockets.push(this);
          setTimeout(() => this.onopen?.({}), 0);
        }
        emit(data: unknown) {
          this.onmessage?.({ data: JSON.stringify(data) });
        }
        send(raw: string) {
          const message = JSON.parse(raw);
          if (message.setup) {
            this.model = String(message.setup.model || '');
            this.emit({ setupComplete: {} });
          }
        }
        close() {
          this.readyState = 3;
        }
      }
      (window as any).WebSocket = FakeLiveSocket;
    });

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    await page.getByTitle(/마이크 켜기/).first().click();
    await expect(page.getByTitle(/마이크 끄기/).first()).toBeVisible({ timeout: 10000 });

    const rows = page.getByTestId('interview-row');
    await page.evaluate(() => (window as any).__turnMock.finish('Explain dependency injection.'));
    await expect(rows).toHaveCount(1);
    // The same turn boundary may arrive twice (finished + turnComplete).
    await page.evaluate(() => (window as any).__turnMock.turnComplete());
    await expect(rows).toHaveCount(1);
  });
});
