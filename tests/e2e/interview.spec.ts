import { test, expect } from '@playwright/test';

test.describe('Interview mode on the existing Global Classroom UI', () => {
  test('normal mode exposes an Interview toggle without replacing the main UI', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('button', { name: 'INTERVIEW' })).toBeVisible();
    await expect(page.getByTitle('입력 언어 선택 (내가 말하는 언어)')).toBeVisible();
    await expect(page.getByTitle('번역 언어 선택 (듣고 싶은 언어)')).toBeVisible();
    await expect(page.getByText('AI 면접 실시간 통역')).toHaveCount(0);
  });

  test('interview mode keeps the original UI and switches language defaults to Auto → English', async ({ page }) => {
    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('button', { name: 'GLOBAL CLASSROOM' })).toBeVisible();
    await expect(page.getByText(/AUTO · KO ↔ EN/)).toBeVisible();

    const inputLanguage = page.getByTitle('입력 언어 선택 (내가 말하는 언어)');
    const outputLanguage = page.getByTitle('번역 언어 선택 (듣고 싶은 언어)');
    await expect(inputLanguage).toHaveValue('auto');
    await expect(outputLanguage).toHaveValue('en');
    await expect(page.getByText('인터뷰 모드 · 자동 언어 감지')).toHaveCount(0);
    await expect(page.getByText('인터뷰 모드', { exact: true })).toBeVisible();
    await expect(page.getByText('AI 인터뷰 통역')).toBeVisible();
    // Interview mode uses the persistent bottom mic only; the old empty-state mic overlapped the tools bar.
    await expect(page.getByTitle(/마이크 켜기/)).toHaveCount(1);
    const composer = page.getByRole('textbox', { name: '인터뷰 텍스트 입력' });
    await expect(composer).toBeVisible();
    await expect(page.getByRole('button', { name: '키보드 입력' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '용어집' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '인터뷰 설정' })).toBeVisible();
    const composerBox = await composer.boundingBox();
    expect(composerBox).not.toBeNull();
    const viewport = page.viewportSize() || { width: 1280, height: 720 };
    expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(viewport.width / 2 + 80);
    // The composer must sit above the fixed bottom controls rather than underneath them.
    expect(composerBox!.y + composerBox!.height).toBeLessThan(viewport.height - 70);

    // Auto-scroll must not move an empty interview screen after React effects settle.
    const conversationScroll = page.locator('div.flex-1.overflow-y-auto').first();
    await page.waitForTimeout(750);
    await expect.poll(async () => conversationScroll.evaluate((element) => element.scrollTop)).toBe(0);
  });

  test('anonymous interview history is discoverable and stored locally', async ({ page }) => {
    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('button', { name: '대화 기록' })).toBeVisible();
    await page.getByRole('button', { name: '대화 기록' }).click();
    await expect(page.getByText(/이 브라우저에 자동 저장된 대화:/)).toBeVisible();
    await expect(page.getByText('로그인 없이 저장됩니다. 브라우저 사이트 데이터를 삭제하면 함께 삭제됩니다.')).toBeVisible();
    await expect(page.getByText('Drive 세션을 보려면 Google 로그인이 필요합니다.')).toBeVisible();
  });

  test('the same header toggle enters and exits interview mode', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'INTERVIEW' }).click();
    await expect(page).toHaveURL(/mode=interview/);
    await expect(page.getByRole('button', { name: 'GLOBAL CLASSROOM' })).toBeVisible();

    await page.getByRole('button', { name: 'GLOBAL CLASSROOM' }).click();
    await expect(page).not.toHaveURL(/mode=interview/);
    await expect(page.getByRole('button', { name: 'INTERVIEW' })).toBeVisible();
  });

  test('left text composer waits for Enter, applies glossary, and retranslates only on request', async ({ page }) => {
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      let translateCall = 0;
      (window as any).__translateBodies = [];
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('detect-language')) {
          return new Response(JSON.stringify({ code: 'ko' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('translate')) {
          translateCall += 1;
          const body = JSON.parse(String(init?.body || '{}'));
          (window as any).__translateBodies.push(body);
          return new Response(JSON.stringify({
            translated: translateCall === 1 ? 'I built Padiem.' : 'I personally built Padiem.',
            provider: 'groq',
            model: 'test-groq',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return realFetch(input, init);
      };
    });

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: '용어집' })).toHaveCount(0);
    await page.getByRole('button', { name: '인터뷰 설정' }).click();
    await expect(page.getByText('인터뷰 통역 · 용어집')).toBeVisible();
    await page.getByPlaceholder('파디엠 = Padiem\n컨트롤 플레인 = Control Plane').fill('파디엠 = Padiem');
    await page.locator('div.fixed.inset-0').getByRole('button').first().click();

    const textarea = page.getByRole('textbox', { name: '인터뷰 텍스트 입력' });
    await textarea.fill('저는 파디엠을 만들었습니다.');

    // Typing/pasting does not submit until Enter, so the user can correct mistakes first.
    await expect(page.getByText('I built Padiem.')).toHaveCount(0);
    await textarea.press('Enter');

    await expect(page.getByText('저는 파디엠을 만들었습니다.')).toBeVisible();
    await expect(page.getByText('I built Padiem.')).toBeVisible();
    const translateBodies = await page.evaluate(() => (window as any).__translateBodies);
    expect(translateBodies[0]?.glossary).toEqual([{ source: '파디엠', target: 'Padiem' }]);

    // #24: translation actions are compact icon-only controls in the card corner.
    const actionGroup = page.getByTestId('translation-row-actions').first();
    await expect(actionGroup).toBeVisible();
    await expect(actionGroup).toHaveText('');
    const editAction = actionGroup.getByRole('button', { name: '번역 수정' });
    const playAction = actionGroup.getByRole('button', { name: '재생' });
    const retranslateAction = actionGroup.getByRole('button', { name: '다시 번역' });
    await expect(editAction).toHaveAttribute('title', '번역 수정');
    await expect(playAction).toHaveAttribute('title', '재생');
    await expect(retranslateAction).toHaveAttribute('title', '다시 번역');
    await expect(editAction).toHaveClass(/h-10/);
    await expect(playAction).toHaveClass(/h-10/);
    await expect(retranslateAction).toHaveClass(/h-10/);
    await expect(page.getByText('다시 번역', { exact: true })).toHaveCount(0);

    // Interview editing stays in the same left/right columns. Merge arrows are intentionally hidden.
    await expect(page.getByTitle('위 항목과 병합')).toHaveCount(0);
    await expect(page.getByTitle('아래 항목과 병합')).toHaveCount(0);

    await page.getByTitle('원문 수정').click();
    const originalEditor = page.getByRole('textbox', { name: '원문 수정' });
    await expect(page.getByText('I built Padiem.')).toBeVisible();
    await originalEditor.fill('저는 직접 파디엠을 만들었습니다.');
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByText('원문이 수정됨 · 다시 번역 권장')).toBeVisible();

    await page.getByRole('button', { name: '다시 번역' }).click();
    await expect(page.getByText('I personally built Padiem.')).toBeVisible();
    await expect(page.getByText('원문이 수정됨 · 다시 번역 권장')).toHaveCount(0);

    await page.getByTitle('번역 수정').click();
    const translationEditor = page.getByRole('textbox', { name: '번역 수정' });
    await expect(page.getByText('저는 직접 파디엠을 만들었습니다.')).toBeVisible();
    await translationEditor.fill('I built Padiem myself.');
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByText('I built Padiem myself.')).toBeVisible();
  });

  test('playing translation exposes a stop icon control instead of a text action row', async ({ page }) => {
    await page.addInitScript(() => {
      const now = Date.now();
      localStorage.setItem('global_classroom_sessions', JSON.stringify([{
        id: 'compact-actions',
        createdAt: now,
        updatedAt: now,
        title: 'Compact actions',
        items: [{
          id: 'playing-row',
          original: '안녕하세요.',
          translated: 'Hello.',
          sourceKind: 'text',
          sourceLanguage: 'ko',
          translations: {
            en: { text: 'Hello.', kind: 'manual', stale: false, updatedAt: now },
          },
          activeTarget: 'en',
          translationKind: 'manual',
          translationStale: false,
          ttsStatus: 'playing',
          timestamp: now,
        }],
      }]));
    });

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    const actions = page.getByTestId('translation-row-actions').first();
    await expect(actions).toBeVisible();
    await expect(actions.getByRole('button', { name: '정지' })).toHaveAttribute('title', '정지');
    await expect(actions.getByRole('button', { name: '재생' })).toHaveCount(0);
    await expect(actions).toHaveText('');
  });

  test('falls back to Groq STT inside the same UI when Gemini Live and browser STT are unavailable', async ({ page }) => {    await page.addInitScript(() => {
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
      Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });

      const fakeTrack = { stop: () => {} } as unknown as MediaStreamTrack;
      const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => fakeStream },
      });
      class FakeMediaRecorder {
        static isTypeSupported() {
          return true;
        }

        state: RecordingState = 'inactive';
        mimeType = 'audio/webm';
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onstop: (() => void) | null = null;

        constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
          if (options?.mimeType) this.mimeType = options.mimeType;
        }

        start() {
          this.state = 'recording';
        }

        stop() {
          this.state = 'inactive';
          const blob = new Blob(['fake-audio'], { type: this.mimeType });
          this.ondataavailable?.({ data: blob } as BlobEvent);
          this.onstop?.();
        }
      }

      Object.defineProperty(window, 'MediaRecorder', {
        configurable: true,
        value: FakeMediaRecorder,
      });
    });
    const failLiveToken = async (route: any) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'test live unavailable' }),
      });
    };
    await page.route('**/api/live-token', failLiveToken);
    await page.route('**/live-token', failLiveToken);

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });

    const micButton = page.getByTitle(/마이크 켜기/);
    await expect(micButton).toHaveCount(1);
    await micButton.click();

    await expect(page.getByText(/AUTO · KO ↔ EN · GROQ STT/)).toBeVisible();
  });

  test('live translate keeps one context per utterance instead of accumulating earlier translations', async ({ page }) => {
    // A Gemini Live session keeps one conversation history for its whole life,
    // so the mock below accumulates every audio chunk it has ever received and
    // translates the whole accumulated context — exactly how the production
    // bleed happens when one translate session outlives an utterance.
    await page.addInitScript(() => {
      // Intercept the token endpoint in-page: Playwright route interception is
      // unreliable for these fetches, and the dev proxy would 500 them.
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/live-token')) {
          return new Response(JSON.stringify({ token: 'e2e-fake-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return realFetch(input, init);
      };

      const PHRASES: Record<string, string> = {
        'Apple is red.': '사과는 빨갛습니다.',
        'Kubernetes runs containers.': '쿠버네티스는 컨테이너를 실행합니다.',
      };
      const translateContext = (context: string) =>
        Object.entries(PHRASES)
          .filter(([source]) => context.includes(source))
          .map(([, target]) => target)
          .join(' ');

      const sockets: any[] = [];

      // Audio chunks are int16 PCM; encode an ASCII tag as (code + 0.5)/0x7FFF
      // so the low byte survives int16 truncation on both sides.
      const decodeTag = (base64: string) => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        let tag = '';
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          const code = bytes[i] | (bytes[i + 1] << 8);
          if (code >= 32 && code < 127) tag += String.fromCharCode(code);
        }
        return tag;
      };

      class FakeLiveSocket {
        readyState = 0;
        onopen: ((event?: unknown) => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: ((event?: unknown) => void) | null = null;
        onclose: ((event?: unknown) => void) | null = null;
        role: 'transcribe' | 'translate' = 'translate';
        target = '';
        context = '';
        turn = '';

        constructor(readonly url: string) {
          // Vite HMR also opens a WebSocket; only track the Live API endpoint.
          if (url.includes('generativelanguage.googleapis.com')) {
            sockets.push(this);
          }
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.({});
          }, 0);
        }

        emit(data: unknown) {
          this.onmessage?.({ data: JSON.stringify(data) });
        }

        emitTranslation(isFinal: boolean) {
          const text = translateContext(this.context);
          if (!text) return;
          this.emit({
            serverContent: {
              outputTranscription: { text },
              ...(isFinal ? { turnComplete: true } : {}),
            },
          });
        }

        send(raw: string) {
          const message = JSON.parse(raw);
          if (message.setup) {
            const model = String(message.setup.model || '');
            this.role = model.includes('transcribe') ? 'transcribe' : 'translate';
            this.target = message.setup?.generationConfig?.translationConfig?.targetLanguageCode || '';
            this.emit({ setupComplete: {} });
            return;
          }
          const realtime = message.realtimeInput;
          if (!realtime) return;
          const mediaChunks = realtime.mediaChunks || (realtime.media ? [realtime.media] : []);
          if (mediaChunks.length) {
            for (const chunk of mediaChunks) {
              const tag = decodeTag(chunk.data);
              this.context += tag;
              this.turn += tag;
            }
            return;
          }
          if (realtime.audioStreamEnd && this.role === 'translate') {
            // Documented server behaviour: finalise what this session holds.
            this.emitTranslation(true);
          }
        }

        close() {
          this.readyState = 3;
        }
      }

      (window as any).WebSocket = class {
        constructor(url: string) {
          return new FakeLiveSocket(url);
        }
      } as unknown as typeof WebSocket;

      const fakeTrack = { stop: () => {} } as unknown as MediaStreamTrack;
      const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => fakeStream },
      });

      let audioHandler: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null = null;

      class FakeAudioContext {
        sampleRate = 16000;
        destination = {};
        async resume() {}
        async close() {}
        createMediaStreamSource() {
          return { connect: () => {} };
        }
        createScriptProcessor() {
          const node = {
            onaudioprocess: null as typeof audioHandler,
            connect: () => {},
            disconnect: () => {},
          };
          audioHandler = (event) => node.onaudioprocess?.(event);
          return node;
        }
      }
      (window as any).AudioContext = FakeAudioContext;
      (window as any).webkitAudioContext = FakeAudioContext;

      (window as any).__liveMock = {
        speak(tag: string) {
          const samples = new Float32Array(1024);
          for (let i = 0; i < tag.length; i += 1) {
            samples[i] = (tag.charCodeAt(i) + 0.5) / 0x7fff;
          }
          audioHandler?.({ inputBuffer: { getChannelData: () => samples } });
        },
        interim() {
          for (const socket of sockets) {
            if (socket.role === 'transcribe' && socket.readyState === 1 && socket.turn.trim()) {
              socket.emit({ serverContent: { interimInputTranscription: { text: socket.turn } } });
            }
          }
        },
        preview() {
          for (const socket of sockets) {
            if (socket.role === 'translate' && socket.readyState === 1) {
              socket.emitTranslation(false);
            }
          }
        },
        finalize() {
          for (const socket of sockets) {
            if (socket.role !== 'transcribe' || socket.readyState !== 1) continue;
            const text = socket.turn.trim();
            if (!text) continue;
            socket.emit({ serverContent: { inputTranscription: { text } } });
            socket.turn = '';
          }
        },
        counts() {
          return {
            transcribe: sockets.filter((socket) => socket.role === 'transcribe').length,
            translate: sockets.filter((socket) => socket.role === 'translate').length,
          };
        },
      };
    });

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    await page.getByTitle(/마이크 켜기/).click();

    // One continuous transcribe session plus live translate sessions per target.
    await expect
      .poll(async () => {
        const counts = await page.evaluate(() => (window as any).__liveMock.counts());
        return counts.transcribe === 1 && counts.translate >= 2;
      }, { timeout: 15_000 })
      .toBe(true);

    // --- Utterance 1 ---
    await page.evaluate(() => (window as any).__liveMock.speak('Apple is red.'));
    await page.evaluate(() => (window as any).__liveMock.interim());
    await page.evaluate(() => (window as any).__liveMock.preview());
    await expect(page.getByText('Apple is red.')).toBeVisible();
    await expect(page.getByText('사과는 빨갛습니다.')).toBeVisible();

    await page.evaluate(() => (window as any).__liveMock.finalize());
    await expect(page.getByText('사과는 빨갛습니다.')).toBeVisible();

    // --- Utterance 2: a fresh translation context must start here ---
    await page.evaluate(() => (window as any).__liveMock.speak('Kubernetes runs containers.'));
    await page.evaluate(() => (window as any).__liveMock.interim());
    await page.evaluate(() => (window as any).__liveMock.preview());

    // The live preview of utterance 2 must not repeat utterance 1.
    await expect(page.getByText('Kubernetes runs containers.')).toBeVisible();
    await expect(page.getByText('쿠버네티스는 컨테이너를 실행합니다.')).toBeVisible();

    await page.evaluate(() => (window as any).__liveMock.finalize());
    await expect(page.getByText('쿠버네티스는 컨테이너를 실행합니다.')).toBeVisible();

    // SOURCE 1 -> TRANSLATION 1 ONLY, SOURCE 2 -> TRANSLATION 2 ONLY. With the
    // bleed defect the second row repeats the first translation, so this fails.
    const firstRow = page.locator('div.grid.grid-cols-2', { hasText: 'Apple is red.' });
    const secondRow = page.locator('div.grid.grid-cols-2', { hasText: 'Kubernetes runs containers.' });
    await expect(firstRow).toContainText('사과는 빨갛습니다.');
    await expect(firstRow).not.toContainText('쿠버네티스');
    await expect(secondRow).toContainText('쿠버네티스는 컨테이너를 실행합니다.');
    await expect(secondRow).not.toContainText('사과는');
    await expect(secondRow).not.toContainText('Apple');

    // The authoritative transcript is never rewritten by the translation side.
    await expect(firstRow).toContainText('Apple is red.');
    await expect(secondRow).toContainText('Kubernetes runs containers.');
  });

  test('text input routes to the selected targets with the detected source excluded', async ({ page }) => {
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      (window as any).__translateBodies = [];
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('detect-language')) {
          return new Response(JSON.stringify({ code: 'ko' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('translate')) {
          const body = JSON.parse(String(init?.body || '{}'));
          (window as any).__translateBodies.push(body);
          return new Response(JSON.stringify({ translated: 'Apple is red.', provider: 'groq' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return realFetch(input, init);
      };
    });

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });

    // Default target set is {ko, en}; the detected Korean source is excluded,
    // so the row translates into English only.
    await expect(page.getByText(/AUTO · KO ↔ EN/)).toHaveCount(1);

    const textarea = page.getByRole('textbox', { name: '인터뷰 텍스트 입력' });
    await textarea.fill('사과는 빨갛습니다.');
    await textarea.press('Enter');

    await expect(page.getByText('Apple is red.')).toBeVisible();
    const translateBodies = await page.evaluate(() => (window as any).__translateBodies);
    expect(translateBodies).toHaveLength(1);
    expect(translateBodies[0].to).toBe('English');

    // No per-row direction label is rendered by default.
    await expect(page.getByText('KO → EN')).toHaveCount(0);
    await expect(page.getByText('EN → KO')).toHaveCount(0);
  });

  test('three or more selected targets render one card with compact language tabs', async ({ page }) => {
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      (window as any).__translateBodies = [];
      const translations: Record<string, string> = {
        'English': 'Apple is red.',
        'Tiếng Việt': 'Quả táo màu đỏ.',
      };
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('detect-language')) {
          return new Response(JSON.stringify({ code: 'ko' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('translate')) {
          const body = JSON.parse(String(init?.body || '{}'));
          (window as any).__translateBodies.push(body);
          return new Response(JSON.stringify({ translated: translations[body.to] || '' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return realFetch(input, init);
      };
    });

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });

    // Select Vietnamese on top of the default {ko, en} target set.
    await page.getByRole('button', { name: '인터뷰 설정' }).click();
    await page.getByRole('button', { name: /Tiếng Việt/ }).click();
    // The header badge reflects the new three-target set immediately (hidden on
    // narrow viewports, so assert on the element rather than its visibility).
    await expect(page.getByText(/AUTO · KO · EN · VI/)).toHaveCount(1);
    await page.locator('div.fixed.inset-0').getByRole('button').first().click();

    const textarea = page.getByRole('textbox', { name: '인터뷰 텍스트 입력' });
    await textarea.fill('사과는 빨갛습니다.');
    await textarea.press('Enter');

    // One translation card, two routed targets (Korean source excluded).
    await expect(page.getByText('Apple is red.')).toBeVisible();
    const translateBodies = await page.evaluate(() => (window as any).__translateBodies);
    expect(translateBodies.map((body: any) => body.to).sort()).toEqual(['English', 'Tiếng Việt']);

    // Compact language tabs switch the displayed translation inside the card.
    await page.getByRole('button', { name: 'vi', exact: true }).click();
    await expect(page.getByText('Quả táo màu đỏ.')).toBeVisible();

    // #24: row actions apply to the currently selected target tab. Retranslating
    // VI must not silently re-run the EN variant.
    await page.evaluate(() => { (window as any).__translateBodies = []; });
    await page.getByRole('button', { name: '다시 번역' }).click();
    await expect.poll(async () => page.evaluate(() => (window as any).__translateBodies.length)).toBe(1);
    const retranslateBodies = await page.evaluate(() => (window as any).__translateBodies);
    expect(retranslateBodies[0].to).toBe('Tiếng Việt');
  });

  test('browser STT fallback detects the source language before routing and never auto-translates', async ({ page }) => {
    await page.addInitScript(() => {
      // Preselect {ko, en, vi} so the detected Vietnamese source must be excluded.
      localStorage.setItem('global_class_settings', JSON.stringify({
        driveBackupMode: 'manual',
        audioCacheEnabled: true,
        recordOriginalEnabled: true,
        interviewTargets: ['ko', 'en', 'vi'],
      }));

      const realFetch = window.fetch.bind(window);
      (window as any).__translateBodies = [];
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('detect-language')) {
          // The detector reports a full BCP-47 tag, like production does.
          return new Response(JSON.stringify({ code: 'vi-VN' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('translate')) {
          const body = JSON.parse(String(init?.body || '{}'));
          (window as any).__translateBodies.push(body);
          return new Response(JSON.stringify({ translated: `translated:${body.to}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return realFetch(input, init);
      };

      class FakeSpeechRecognition {
        continuous = false;
        interimResults = false;
        lang = '';
        onstart: (() => void) | null = null;
        onresult: ((event: any) => void) | null = null;
        onerror: ((event: any) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          (window as any).__recognition = this;
          window.setTimeout(() => this.onstart?.(), 0);
        }
        stop() {}
      }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeSpeechRecognition });
      Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeSpeechRecognition });
    });
    const failLiveToken = async (route: any) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'test live unavailable' }),
      });
    };
    await page.route('**/api/live-token', failLiveToken);
    await page.route('**/live-token', failLiveToken);

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    await page.getByTitle(/마이크 켜기/).click();
    await expect(page.getByText(/BROWSER STT/)).toHaveCount(1);

    // Deliver one finalized Vietnamese utterance through the fake recognizer.
    await page.evaluate(() => {
      const recognition = (window as any).__recognition;
      const alternative = [{ transcript: 'Tôi đã xây dựng Padiem.' }];
      const result = Object.assign(alternative, { isFinal: true });
      recognition.onresult({ resultIndex: 0, results: [result] });
    });

    await expect(page.getByText('Tôi đã xây dựng Padiem.')).toBeVisible();
    // The fallback row waits for the user: no automatic translation request.
    expect(await page.evaluate(() => (window as any).__translateBodies.length)).toBe(0);

    // Manual retranslation routes with the authoritative source (vi-VN -> vi):
    // Vietnamese is excluded from the selected set, so ko + en are translated.
    await page.getByRole('button', { name: '다시 번역' }).click();
    // Both routed targets land as variants of the same row; the first routed
    // target (ko) is displayed and the compact tabs switch between them.
    await expect(page.getByText('translated:한국어 (Korean)')).toBeVisible();
    await page.getByRole('button', { name: 'en', exact: true }).click();
    await expect(page.getByText('translated:English')).toBeVisible();
    const bodies = await page.evaluate(() => (window as any).__translateBodies);
    expect(bodies.map((body: any) => body.to).sort()).toEqual(['English', '한국어 (Korean)'].sort());
    expect(bodies.every((body: any) => body.from === 'Tiếng Việt')).toBe(true);
  });

  test('Groq STT fallback applies pair rules to the authoritative source and never auto-translates', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('global_class_settings', JSON.stringify({
        driveBackupMode: 'manual',
        audioCacheEnabled: true,
        recordOriginalEnabled: true,
        interviewTargets: ['ko', 'en', 'ja'],
      }));
      localStorage.setItem('global-classroom-interview-pair-rules-v1', 'JA -> EN');

      const realFetch = window.fetch.bind(window);
      (window as any).__translateBodies = [];
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('detect-language')) {
          return new Response(JSON.stringify({ code: 'ja-JP' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('transcribe')) {
          return new Response(JSON.stringify({ text: '私はパディエムを作りました。' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('translate')) {
          const body = JSON.parse(String(init?.body || '{}'));
          (window as any).__translateBodies.push(body);
          return new Response(JSON.stringify({ translated: `translated:${body.to}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return realFetch(input, init);
      };

      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
      Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });

      const fakeTrack = { stop: () => {} } as unknown as MediaStreamTrack;
      const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => fakeStream },
      });

      let recorderStarts = 0;
      class FakeMediaRecorder {
        static isTypeSupported() {
          return true;
        }

        state: RecordingState = 'inactive';
        mimeType = 'audio/webm';
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onstop: (() => void) | null = null;

        constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
          if (options?.mimeType) this.mimeType = options.mimeType;
        }

        start() {
          this.state = 'recording';
          // Stop exactly once so a single finalized utterance is produced.
          recorderStarts += 1;
          if (recorderStarts === 1) {
            window.setTimeout(() => {
              if (this.state === 'recording') this.stop();
            }, 600);
          }
        }

        stop() {
          this.state = 'inactive';
          const blob = new Blob(['fake-audio'], { type: this.mimeType });
          this.ondataavailable?.({ data: blob } as BlobEvent);
          this.onstop?.();
        }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
    });
    const failLiveToken = async (route: any) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'test live unavailable' }),
      });
    };
    await page.route('**/api/live-token', failLiveToken);
    await page.route('**/live-token', failLiveToken);

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    await page.getByTitle(/마이크 켜기/).click();
    await expect(page.getByText(/GROQ STT/)).toHaveCount(1);

    await expect(page.getByText('私はパディエムを作りました。')).toBeVisible({ timeout: 10000 });
    // No automatic translation request for the fallback transcript.
    expect(await page.evaluate(() => (window as any).__translateBodies.length)).toBe(0);

    // The pair rule (JA -> EN) matches the canonicalized source: ja-JP -> ja,
    // so manual retranslation produces exactly one English translation.
    await page.getByRole('button', { name: '다시 번역' }).click();
    await expect(page.getByText('translated:English')).toBeVisible();
    const bodies = await page.evaluate(() => (window as any).__translateBodies);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].from).toBe('日本語 (Japanese)');
    expect(bodies[0].to).toBe('English');
  });
});
