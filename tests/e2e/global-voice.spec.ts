import { test, expect } from '@playwright/test';

test.describe('Global Classroom normal-mode voice transcription (#58)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('global_class_settings', JSON.stringify({
        driveBackupMode: 'manual',
        audioCacheEnabled: true,
        recordOriginalEnabled: false,
      }));

      const fakeTrack = { stop: () => {} } as unknown as MediaStreamTrack;
      const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => fakeStream },
      });

      let audioHandler: ((event: any) => void) | null = null;
      class FakeAudioContext {
        sampleRate = 16000;
        state = 'running';
        destination = {};
        async resume() {}
        async close() {}
        createAnalyser() {
          return {
            fftSize: 256,
            frequencyBinCount: 128,
            connect: () => {},
            disconnect: () => {},
            getByteFrequencyData: () => {},
            getByteTimeDomainData: () => {},
          };
        }
        createMediaStreamSource() {
          return { connect: () => {} };
        }
        createScriptProcessor() {
          const node = {
            onaudioprocess: null as ((event: any) => void) | null,
            connect: () => {},
            disconnect: () => {},
          };
          audioHandler = (event: any) => node.onaudioprocess?.(event);
          return node;
        }
        createBuffer() {
          return { getChannelData: () => new Float32Array(1) };
        }
        createBufferSource() {
          return { connect: () => {}, start: () => {}, stop: () => {}, onended: null as any };
        }
      }
      (window as any).AudioContext = FakeAudioContext;
      (window as any).webkitAudioContext = FakeAudioContext;

      let callbacks: any = null;
      (window as any).__globalVoiceConfig = null;
      (window as any).ai_client = {
        live: {
          connect: async (args: any) => {
            callbacks = args.callbacks;
            (window as any).__globalVoiceConfig = {
              model: args.model,
              config: args.config,
            };
            const session = {
              sendRealtimeInput: () => {},
              close: () => {},
            };
            window.setTimeout(() => callbacks?.onopen?.(), 0);
            return session;
          },
        },
      };

      (window as any).__globalVoiceMock = {
        emitFinal(text: string) {
          callbacks?.onmessage?.({
            serverContent: {
              inputTranscription: { text, finished: true },
              turnComplete: true,
            },
          });
        },
        feedAudio() {
          const samples = new Float32Array(1024);
          samples.fill(0.05);
          audioHandler?.({ inputBuffer: { getChannelData: () => samples } });
        },
        emitEmptyTurn() {
          callbacks?.onmessage?.({ serverContent: { turnComplete: true } });
        },
      };
    });

    await page.route('**/live-token', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'test-live-token' }),
      });
    });
    await page.route('**/detect-language', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'ko' }),
      });
    });
    await page.route('**/translate', async route => {
      const body = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ translated: `translated:${body.text}` }),
      });
    });
    await page.route('**/transcribe', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: '복구된 음성' }),
      });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByTitle(/마이크 켜기/).first().click();
    await expect(page.getByTitle(/마이크 끄기/).first()).toBeVisible({ timeout: 5000 });
  });

  test('uses dedicated Live Transcribe and commits consecutive utterances', async ({ page }) => {
    const config = await page.evaluate(() => (window as any).__globalVoiceConfig);
    expect(config.model).toBe('gemini-3.5-transcribe-live');
    expect(config.config.responseModalities).toEqual(['TEXT']);
    expect(config.config.inputAudioTranscription.languageCodes).toEqual([]);

    await page.evaluate(() => (window as any).__globalVoiceMock.emitFinal('안녕하세요'));
    await expect(page.getByText('안녕하세요', { exact: true })).toBeVisible();

    await page.evaluate(() => (window as any).__globalVoiceMock.emitFinal('두 번째입니다'));
    await expect(page.getByText('두 번째입니다', { exact: true })).toBeVisible();

    await expect(page.getByText('안녕하세요', { exact: true })).toHaveCount(1);
    await expect(page.getByText('두 번째입니다', { exact: true })).toHaveCount(1);
  });

  test('recovers an empty Live turn through the bounded transcribe fallback', async ({ page }) => {
    await page.evaluate(() => (window as any).__globalVoiceMock.feedAudio());
    // AudioWorklet/ScriptProcessor delivery completes asynchronously in the
    // browser; model the real gap between receiving PCM and server turn end.
    await page.waitForTimeout(25);
    await page.evaluate(() => (window as any).__globalVoiceMock.emitEmptyTurn());

    await expect(page.getByText('복구된 음성', { exact: true })).toBeVisible({ timeout: 5000 });
  });
});
