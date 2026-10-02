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
    await expect(page.getByText('인터뷰 모드 · 자동 언어 감지')).toBeVisible();
    await expect(page.getByText('AI 인터뷰 통역')).toBeVisible();
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

  test('text paste preserves source, applies glossary, and retranslates only on request', async ({ page }) => {
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
    await page.getByRole('button', { name: '용어집' }).click();
    await page.getByPlaceholder('파디엠 = Padiem\n컨트롤 플레인 = Control Plane').fill('파디엠 = Padiem');

    await page.getByRole('button', { name: '텍스트 입력' }).click();
    const textarea = page.getByPlaceholder('여기에 입력하거나 붙여넣으세요. 원문은 그대로 보존됩니다.');
    await textarea.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', '저는 파디엠을 만들었습니다.');
      element.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }));
    });

    await expect(page.getByText('저는 파디엠을 만들었습니다.')).toBeVisible();
    await expect(page.getByText('I built Padiem.')).toBeVisible();
    const translateBodies = await page.evaluate(() => (window as any).__translateBodies);
    expect(translateBodies[0]?.glossary).toEqual([{ source: '파디엠', target: 'Padiem' }]);

    await page.getByTitle('수정').click();
    const originalEditor = page.getByText('원본 텍스트').locator('..').locator('textarea');
    await originalEditor.fill('저는 직접 파디엠을 만들었습니다.');
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByText('원문이 수정됨 · 다시 번역 권장')).toBeVisible();

    await page.getByRole('button', { name: '다시 번역' }).click();
    await expect(page.getByText('I personally built Padiem.')).toBeVisible();
    await expect(page.getByText('원문이 수정됨 · 다시 번역 권장')).toHaveCount(0);
  });

  test('falls back to Groq STT inside the same UI when Gemini Live and browser STT are unavailable', async ({ page }) => {
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

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });

    const micButtons = page.getByTitle('마이크 켜기');
    await micButtons.last().click();

    await expect(page.getByText(/AUTO · KO ↔ EN · GROQ STT/)).toBeVisible();
  });
});
