import { test, expect } from '@playwright/test';

test.describe('AI Interview live hybrid mode', () => {
  test.beforeEach(async ({ page }) => {
    const fulfillTranslation = async (route: any) => {
      const body = route.request().postDataJSON() as { text?: string; from?: string; to?: string };
      const translated =
        body?.to === 'English'
          ? 'I build AI systems that help people communicate complex ideas clearly.'
          : '어려운 기술 문제를 어떻게 해결하는지 설명해 주세요.';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ translated, provider: 'test', model: 'test' }),
      });
    };

    await page.route('**/api/translate', fulfillTranslation);
    await page.route('**/translate', fulfillTranslation);
    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  });

  test('opens a bright interview timeline without classroom login UI', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'AI 면접 실시간 통역' })).toBeVisible();
    await expect(page.getByText('✨ 자동 언어 감지')).toBeVisible();
    await expect(page.getByText('한국어 ↔ English')).toBeVisible();
    await expect(page.getByRole('button', { name: '🎙 마이크 켜기' })).toBeVisible();
    await expect(page.getByText('마이크를 켜고 자연스럽게 말씀하세요.')).toBeVisible();
  });

  test('translates Korean manual input to English in the shared timeline', async ({ page }) => {
    const input = page.getByPlaceholder('한국어 또는 영어를 입력하면 반대 언어로 번역합니다.');
    await input.fill('저는 복잡한 AI 시스템을 실제 제품으로 만드는 일을 해왔습니다.');
    await page.getByRole('button', { name: '번역' }).click();

    await expect(
      page.getByText('I build AI systems that help people communicate complex ideas clearly.')
    ).toBeVisible();
    await expect(page.getByText('Korean → English')).toBeVisible();
  });

  test('translates English manual input back to Korean', async ({ page }) => {
    const input = page.getByPlaceholder('한국어 또는 영어를 입력하면 반대 언어로 번역합니다.');
    await input.fill('Tell me how you solve a difficult technical problem.');
    await page.getByRole('button', { name: '번역' }).click();

    await expect(
      page.getByText('어려운 기술 문제를 어떻게 해결하는지 설명해 주세요.')
    ).toBeVisible();
    await expect(page.getByText('English → Korean')).toBeVisible();
  });

  test('shows the interview disclosure in both languages', async ({ page }) => {
    await page.getByRole('button', { name: '시작 안내문' }).click();
    await expect(page.getByText(/저는 영어로 기본적인 소통은 가능하지만/)).toBeVisible();
    await expect(
      page.getByText(/I can communicate in English, but for complex technical topics/)
    ).toBeVisible();
  });

  test('falls back to Groq Whisper when Gemini Live and browser STT are unavailable', async ({ page }) => {
    await page.addInitScript(() => {
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

    const fulfillTranscribe = async (route: any) => {
      const body = route.request().postDataJSON() as { language?: string; audioDataUrl?: string };
      expect(body.language).toBe('auto');
      expect(body.audioDataUrl?.startsWith('data:audio/')).toBeTruthy();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          text: '저는 빠른 AI 통역기를 만들었습니다.',
          provider: 'groq',
          model: 'whisper-large-v3-turbo',
        }),
      });
    };
    await page.route('**/api/transcribe', fulfillTranscribe);
    await page.route('**/transcribe', fulfillTranscribe);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '🎙 마이크 켜기' }).click();

    await expect(page.getByText('Groq Whisper fallback')).toBeVisible();

    await page.getByRole('button', { name: '■ 마이크 끄기' }).click();

    await expect(page.getByText('저는 빠른 AI 통역기를 만들었습니다.')).toBeVisible();
  });
});
