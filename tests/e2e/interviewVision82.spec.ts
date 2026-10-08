import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('global_class_settings', JSON.stringify({
      driveBackupMode: 'manual', recordOriginalEnabled: true,
      audioCacheEnabled: true, interviewTargets: ['ko', 'en'],
    }));
    const rawFetch = window.fetch.bind(window);
    (window as any).__imageCallLog = [];
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const reply = (body: object) => new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
      if (url.includes('/api/vision')) {
        (window as any).__imageCallLog.push({ kind: 'vision', ...JSON.parse(String(init?.body || '{}')) });
        return reply({ originalText: 'What does this code do?', translatedText: '' });
      }
      if (url.includes('/api/interview-answer')) {
        (window as any).__imageCallLog.push({ kind: 'answer', ...JSON.parse(String(init?.body || '{}')) });
        return reply({ shouldAnswer: true, answer: 'It sorts the list and returns the result.', language: 'en' });
      }
      if (url.includes('/api/translate')) {
        const body = JSON.parse(String(init?.body || '{}'));
        (window as any).__imageCallLog.push({ kind: 'translate', ...body });
        return reply({ translated: 'KO:' + body.text });
      }
      return rawFetch(input, init);
    };
  });
  await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
}

async function pngImage(page: Page) {
  const base64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 90;
    c.height = 50;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 90, 50);
    ctx.fillStyle = 'black';
    ctx.fillText('QUESTION', 10, 25);
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(base64, 'base64');
}

async function expectAnswer(page: Page, count = 1) {
  const rows = page.getByTestId('interview-row');
  await expect(rows).toHaveCount(count);
  const row = rows.nth(count - 1);
  await expect(row).toHaveAttribute('data-source-kind', 'image');
  await expect(row.getByTestId('transcript-cell')).toContainText('이미지에서 읽음');
  await expect(row.getByTestId('transcript-cell')).toContainText('What does this code do?');
  await expect(row.getByTestId('question-translation-cell')).toContainText('KO:What does this code do?');
  await expect(row.getByTestId('answer-row-toggle')).toContainText('답변 보기', { timeout: 10000 });
  await row.getByTestId('answer-row-toggle').click();
  await expect(row.getByTestId('suggested-answer')).toContainText('It sorts the list');
  await expect(row.getByTestId('answer-translation')).toContainText('KO:It sorts the list');
  const logs = await page.evaluate(() => (window as any).__imageCallLog);
  expect(logs.filter((entry: any) => entry.kind === 'vision')).toHaveLength(count);
  expect(logs.filter((entry: any) => entry.kind === 'answer')).toHaveLength(count);
  expect(logs.filter((entry: any) => entry.kind === 'translate' && entry.text?.startsWith('What'))).toHaveLength(count);
  const req = logs.find((entry: any) => entry.kind === 'vision');
  expect(req.extractOnly).toBe(true);
  expect(req.model).toBe('gemini-3.5-flash-lite');
  expect(req.base64Image.startsWith('/9j/')).toBe(true);
}

test('image upload becomes exactly one transcribed question, translation and answer (#82)', async ({ page }) => {
  await setup(page);
  await page.getByTitle('이미지에서 질문 읽기').click();
  await expect(page.getByTestId('interview-image-dialog')).toBeVisible();
  await page.getByTestId('interview-image-file').setInputFiles({
    name: 'interview-question.png', mimeType: 'image/png', buffer: await pngImage(page),
  });
  await expect(page.getByTestId('interview-image-dialog')).toHaveCount(0);
  await expectAnswer(page);
});

test('Ctrl+V image paste imports the same Interview answer path (#82)', async ({ page }) => {
  await setup(page);
  await page.getByTitle('이미지에서 질문 읽기').click();
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = 60;
    const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
    const file = new File([blob], 'question.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: dt,
    }));
  });
  await expectAnswer(page);
});

test('one-shot screen capture stops all tracks and imports one question (#82)', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).__screenStopCount = 0;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 180;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, 320, 180);
        const stream = canvas.captureStream(20);
        for (const track of stream.getTracks()) {
          const originalStop = track.stop.bind(track);
          track.stop = () => { (window as any).__screenStopCount++; originalStop(); };
        }
        return stream;
      },
    });
  });
  await page.getByTitle('이미지에서 질문 읽기').click();
  await page.getByTestId('interview-screen-capture').click();
  await expectAnswer(page);
  await expect.poll(() => page.evaluate(() => (window as any).__screenStopCount)).toBeGreaterThan(0);
});

test('existing camera can capture a photo and insert a question (#82)', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 180;
        const context = canvas.getContext('2d')!;
        const paint = () => { context.fillStyle = 'white'; context.fillRect(0, 0, 320, 180); };
        paint();
        const stream = canvas.captureStream(20);
        const paintTimer = window.setInterval(paint, 40);
        for (const track of stream.getTracks()) {
          const oldStop = track.stop.bind(track);
          track.stop = () => { window.clearInterval(paintTimer); oldStop(); };
        }
        return stream;
      },
    });
  });
  await page.getByTitle('이미지에서 질문 읽기').click();
  await page.getByRole('button', { name: '카메라로 촬영' }).click();
  await expect(page.getByRole('button', { name: '촬영', exact: true })).toBeEnabled({ timeout: 10000 });
  await page.getByRole('button', { name: '촬영', exact: true }).click();
  await page.getByRole('button', { name: '원래 페이지로 돌아가기' }).click();
  await expectAnswer(page);
});

test('unsupported uploaded file shows an error without creating a conversation row (#82)', async ({ page }) => {
  await setup(page);
  await page.getByTitle('이미지에서 질문 읽기').click();
  await page.getByTestId('interview-image-file').setInputFiles({
    name: 'not-an-image.txt', mimeType: 'text/plain', buffer: Buffer.from('not image'),
  });
  await expect(page.getByRole('alert')).toContainText('JPG, PNG, WEBP');
  await expect(page.getByTestId('interview-row')).toHaveCount(0);
});
