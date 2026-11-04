import { test, expect, type Page } from '@playwright/test';

type InputMode = 'system' | 'both' | 'mic';

/**
 * #116: 면접 모드의 시스템 소리(화면 공유 오디오) 입력.
 * getDisplayMedia는 실물 API를 쓰고 --use-fake-ui-for-media-stream이 첫 소스를
 * 자동 승인한다(헤드리스에서도 동작). 세션은 FakeLiveSocket로 대체한다.
 */
// fake-ui가 getDisplayMedia의 첫 소스를 자동 승인해 헤드리스에서도 실물
// 화면 공유 흐름을 검증할 수 있다(#116).
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream'] } });

test.describe('Interview system-audio input (#116)', () => {

  async function setup(page: Page, inputMode: InputMode) {
    await page.addInitScript((mode: InputMode) => {
      localStorage.clear();
      localStorage.setItem('global_class_settings', JSON.stringify({
        driveBackupMode: 'manual',
        audioCacheEnabled: true,
        recordOriginalEnabled: false,
        // 'mic'은 설정 키 없이 기본값 회귀를 검증한다.
        ...(mode !== 'mic' ? { audioInputMode: mode } : {}),
      }));

      const calls = { getUserMedia: 0, getUserMediaConstraints: null as any, getDisplayMedia: 0, videoStopped: 0 };
      (window as any).__interviewCalls = calls;

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

      const micTrack = { kind: 'audio', stop: () => {} };
      const micStream = {
        getTracks: () => [micTrack],
        getAudioTracks: () => [micTrack],
        getVideoTracks: () => [],
      };
      const endedHandlers: Array<() => void> = [];
      const videoTrack = { kind: 'video', stop: () => { calls.videoStopped += 1; } };
      const audioTrack = {
        kind: 'audio',
        stop: () => {},
        addEventListener: (type: string, handler: () => void) => {
          if (type === 'ended') endedHandlers.push(handler);
        },
        removeEventListener: () => {},
      };
      const displayStream = {
        getTracks: () => [videoTrack, audioTrack],
        getAudioTracks: () => [audioTrack],
        getVideoTracks: () => [videoTrack],
      };

      const md = navigator.mediaDevices;
      const origGetDisplayMedia = md && typeof md.getDisplayMedia === 'function'
        ? md.getDisplayMedia.bind(md)
        : null;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async (constraints: any) => {
            calls.getUserMedia += 1;
            calls.getUserMediaConstraints = constraints;
            return micStream;
          },
          getDisplayMedia: async (constraints: any) => {
            calls.getDisplayMedia += 1;
            if (!origGetDisplayMedia) throw new Error('getDisplayMedia unavailable');
            const stream = await origGetDisplayMedia(constraints);
            stream.getTracks().forEach((t: MediaStreamTrack) => {
              const origStop = t.stop.bind(t);
              t.stop = () => { if (t.kind === 'video') calls.videoStopped += 1; return origStop(); };
            });
            return stream;
          },
        },
      });

      // 분석기 #0 = 마이크(나), #1 = 시스템(상대). both 모드에서 상대에 신호를 준다.
      const analyserValues = mode === 'both' ? [0, 0.4] : [0, 0];
      let analyserIndex = 0;
      class FakeAudioContext {
        sampleRate = 16000;
        destination = {};
        audioWorklet = undefined;
        async resume() {}
        async close() {}
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
        createAnalyser() {
          const index = analyserIndex;
          analyserIndex += 1;
          const value = analyserValues[index] ?? 0;
          return {
            fftSize: 512,
            connect: () => {},
            disconnect: () => {},
            getFloatTimeDomainData: (buffer: Float32Array) => {
              buffer.fill(value);
            },
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

      (window as any).__interviewMock = {
        finalize(text: string) {
          for (const socket of sockets) {
            if (socket.model.includes('transcribe')) {
              socket.emit({ serverContent: { inputTranscription: { text, finished: true } } });
            }
          }
        },
      };
    }, inputMode);

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  }

  async function startInterview(page: Page) {
    await page.getByTitle(/마이크 켜기/).first().click();
    await expect(page.getByTitle(/마이크 끄기/).first()).toBeVisible({ timeout: 10000 });
  }

  test('시스템 소리 모드는 화면 공유 오디오만 입력으로 쓰고 마이크를 잡지 않는다', async ({ page }) => {
    await setup(page, 'system');
    await startInterview(page);

    await page.waitForFunction(() => (window as any).__interviewCalls.getDisplayMedia >= 1, null, { timeout: 10000 });
    await page.waitForFunction(() => (window as any).__interviewCalls.videoStopped >= 1, null, { timeout: 10000 });
    await page.waitForTimeout(1500);

    const calls = await page.evaluate(() => (window as any).__interviewCalls);
    expect(calls.getDisplayMedia).toBe(1);
    expect(calls.getUserMedia).toBe(0);
    await expect(page.getByText(/GEMINI LIVE/)).toHaveCount(1);

    await page.evaluate(() => (window as any).__interviewMock.finalize('상대 발언 테스트입니다'));
    const rows = page.getByTestId('interview-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('상대 발언 테스트입니다');
    // system 모드는 모든 발언이 상대여서 배지를 붙이지 않는다(정보 가치 없음).
    await expect(rows.first()).toHaveAttribute('data-speaker', '');
  });

  test('둘 다 모드는 마이크와 화면 공유를 함께 잡고 턴에 상대 배지를 붙인다', async ({ page }) => {
    await setup(page, 'both');
    await startInterview(page);

    await page.waitForFunction(
      () => (window as any).__interviewCalls.getDisplayMedia >= 1
        && (window as any).__interviewCalls.getUserMedia >= 1,
      null,
      { timeout: 10000 },
    );
    await page.waitForFunction(() => (window as any).__interviewCalls.videoStopped >= 1, null, { timeout: 10000 });
    await expect(page.getByText(/GEMINI LIVE/)).toHaveCount(1);

    // 화자 미터가 최소 3회 샘플되도록 잠시 대기한다(250ms 간격).
    await page.waitForTimeout(1000);

    await page.evaluate(() => (window as any).__interviewMock.finalize('섞인 발언 테스트입니다'));
    const rows = page.getByTestId('interview-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('섞인 발언 테스트입니다');
    // 시스템(상대) 분석기에만 신호를 줬으므로 이 턴은 상대로 판정된다.
    await expect(rows.first()).toHaveAttribute('data-speaker', 'counterpart');
    await expect(page.getByTestId('speaker-badge').first()).toHaveText('상대');
  });

  test('마이크 모드는 기존 면접 마이크 제약을 그대로 유지한다', async ({ page }) => {
    await setup(page, 'mic');
    await startInterview(page);

    await page.waitForFunction(() => (window as any).__interviewCalls.getUserMedia >= 1, null, { timeout: 10000 });
    await page.waitForTimeout(1500);

    const calls = await page.evaluate(() => (window as any).__interviewCalls);
    expect(calls.getDisplayMedia).toBe(0);
    expect(calls.getUserMedia).toBe(1);
    expect(calls.getUserMediaConstraints?.audio?.channelCount).toBe(1);
    expect(calls.getUserMediaConstraints?.audio?.sampleRate).toBe(16000);
    expect(calls.getUserMediaConstraints?.audio?.echoCancellation).toBe(true);
    expect(calls.getUserMediaConstraints?.audio?.autoGainControl).toBe(true);
    await expect(page.getByText(/GEMINI LIVE/)).toHaveCount(1);

    await page.evaluate(() => (window as any).__interviewMock.finalize('마이크 발언 테스트입니다'));
    const rows = page.getByTestId('interview-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('마이크 발언 테스트입니다');
    await expect(rows.first()).toHaveAttribute('data-speaker', '');
  });
});
