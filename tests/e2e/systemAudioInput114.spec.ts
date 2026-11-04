import { test, expect } from '@playwright/test';

type SetupOptions = {
  inputMode: 'system' | 'both';
  withAudio?: boolean;
};

/**
 * #114: 시스템 소리(화면 공유 오디오) 입력 흐름.
 * getDisplayMedia는 가짜로 대체하지만 마이크 경로와 동일하게 브라우저 안에서
 * 전체 파이프라인(Live 세션 → 자막)을 돌린다.
 */
test.describe('Global Classroom system-audio input (#114)', () => {
  async function setup(page: any, options: SetupOptions) {
    const { inputMode, withAudio = true } = options;
    await page.addInitScript(({ inputMode, withAudio }: SetupOptions) => {
      localStorage.clear();
      localStorage.setItem('global_class_settings', JSON.stringify({
        driveBackupMode: 'manual',
        audioCacheEnabled: true,
        recordOriginalEnabled: false,
        audioInputMode: inputMode,
      }));

      const calls = { getUserMedia: 0, getDisplayMedia: 0, videoStopped: 0 };
      (window as any).__systemAudioCalls = calls;

      const micStream = {
        getTracks: () => [],
        getAudioTracks: () => [],
        getVideoTracks: () => [],
      };
      const endedHandlers: Array<() => void> = [];
      const videoTrack = {
        kind: 'video',
        stop: () => { calls.videoStopped += 1; },
      };
      const audioTrack = {
        kind: 'audio',
        stop: () => {},
        addEventListener: (type: string, handler: () => void) => {
          if (type === 'ended') endedHandlers.push(handler);
        },
        removeEventListener: () => {},
      };
      const displayTracks = withAudio ? [videoTrack, audioTrack] : [videoTrack];
      const displayStream = {
        getTracks: () => displayTracks,
        getAudioTracks: () => displayTracks.filter((t: any) => t.kind === 'audio'),
        getVideoTracks: () => displayTracks.filter((t: any) => t.kind === 'video'),
      };

      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            calls.getUserMedia += 1;
            return micStream;
          },
          getDisplayMedia: async () => {
            calls.getDisplayMedia += 1;
            return displayStream;
          },
        },
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
          return { connect: () => {}, disconnect: () => {} };
        }
        createMediaStreamDestination() {
          return {
            stream: { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] },
            disconnect: () => {},
          };
        }
        createGain() {
          return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
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
      (window as any).ai_client = {
        live: {
          connect: async (args: any) => {
            callbacks = args.callbacks;
            const session = {
              sendRealtimeInput: () => {},
              close: () => {},
            };
            window.setTimeout(() => callbacks?.onopen?.(), 0);
            return session;
          },
        },
      };

      (window as any).__systemAudioMock = {
        emitFinal(text: string) {
          callbacks?.onmessage?.({
            serverContent: {
              inputTranscription: { text, finished: true },
              turnComplete: true,
            },
          });
        },
        endAudioTrack() {
          endedHandlers.forEach((handler) => handler());
        },
      };
    }, { inputMode, withAudio });

    await page.route('**/live-token', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'test-live-token' }),
      });
    });
    await page.route('**/detect-language', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'ko' }),
      });
    });
    await page.route('**/translate', async (route: any) => {
      const body = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ translated: `translated:${body.text}` }),
      });
    });
    await page.route('**/transcribe', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: '복구된 음성' }),
      });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  async function startListening(page: any) {
    await page.getByTitle(/마이크 켜기/).first().click();
    await page.waitForFunction(() => (window as any).__systemAudioCalls.getDisplayMedia >= 1);
    await page.waitForFunction(() => (window as any).__systemAudioCalls.videoStopped >= 1);
  }

  test('시스템 소리 모드는 화면 공유 오디오만 입력으로 쓰고 마이크를 잡지 않는다', async ({ page }) => {
    await setup(page, { inputMode: 'system' });
    await startListening(page);

    const calls = await page.evaluate(() => (window as any).__systemAudioCalls);
    expect(calls.getDisplayMedia).toBe(1);
    expect(calls.getUserMedia).toBe(0);

    await page.evaluate(() => (window as any).__systemAudioMock.emitFinal('탭 소리가 자막으로 나온다'));
    await expect(page.getByText('탭 소리가 자막으로 나온다', { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('오디오 트랙 없이 공유하면 안내 문구를 보여주고 세션을 닫는다', async ({ page }) => {
    await setup(page, { inputMode: 'system', withAudio: false });
    await page.getByTitle(/마이크 켜기/).first().click();

    await expect(page.getByText(/탭 오디오 공유/)).toBeVisible({ timeout: 5000 });

    const calls = await page.evaluate(() => (window as any).__systemAudioCalls);
    expect(calls.getUserMedia).toBe(0);
    await expect(page.getByTitle(/마이크 켜기/).first()).toBeVisible({ timeout: 5000 });
  });

  test('화면 공유가 끊기면 통역을 중단하고 안내를 보인다', async ({ page }) => {
    await setup(page, { inputMode: 'system' });
    await startListening(page);

    await page.evaluate(() => (window as any).__systemAudioMock.endAudioTrack());

    await expect(page.getByText(/화면 공유가 종료되어 통역을 중단했습니다/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByTitle(/마이크 켜기/).first()).toBeVisible({ timeout: 5000 });
  });

  test('둘 다 모드는 마이크와 화면 공유 오디오를 함께 요청해 섞어 보낸다', async ({ page }) => {
    await setup(page, { inputMode: 'both' });
    await startListening(page);

    const calls = await page.evaluate(() => (window as any).__systemAudioCalls);
    expect(calls.getDisplayMedia).toBe(1);
    expect(calls.getUserMedia).toBe(1);

    await page.evaluate(() => (window as any).__systemAudioMock.emitFinal('섞은 소리도 자막으로 나온다'));
    await expect(page.getByText('섞은 소리도 자막으로 나온다', { exact: true })).toBeVisible({ timeout: 5000 });
  });
});
