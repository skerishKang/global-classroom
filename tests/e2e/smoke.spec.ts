import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
});

test('헤더는 현재 모드별 액션을 노출하고 새창 액션은 제거된 상태다', async ({ page }) => {
  const header = page.locator('header');

  await expect(header.getByRole('button', { name: /새 대화/ }).first()).toBeVisible();
  await expect(header.getByRole('button', { name: /내보내기/ })).toBeVisible();
  await expect(header.getByRole('button', { name: /로그인|Login|Google로 로그인/ })).toBeVisible({ timeout: 10000 });
  await expect(header.getByRole('button', { name: '대화 기록' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: '새창' })).toHaveCount(0);

  await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  const interviewHeader = page.locator('header');
  await expect(interviewHeader.getByRole('button', { name: '대화 기록' })).toBeVisible();
  await expect(interviewHeader.getByRole('button', { name: '인터뷰 설정' })).toBeVisible();
  await expect(interviewHeader.getByRole('button', { name: /로그인|Login|Google로 로그인/ })).toHaveCount(0);
});

test('새 대화 생성 시 로컬 세션이 증가하고, 대화 기록에서 선택한 세션을 불러온다', async ({ page }) => {
  await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  const header = page.locator('header');

  const newChatButton = header.getByRole('button', { name: /새 대화/ }).first();
  await expect(newChatButton).toBeVisible();
  await newChatButton.click();

  const sessions = await page.evaluate(() => JSON.parse(localStorage.getItem('global_classroom_sessions') || '[]'));
  expect(sessions.length).toBeGreaterThanOrEqual(2);

  await header.getByRole('button', { name: '대화 기록' }).click();
  await expect(page.getByRole('heading', { name: '이전 히스토리' })).toBeVisible();

  const localCount = page.getByText(/이 브라우저에 자동 저장된 대화:/).first();
  const countText = (await localCount.innerText()).replace(/\s+/g, ' ');
  const match = countText.match(/자동 저장된 대화:\s*(\d+)/);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThanOrEqual(2);

  const targetTitle = String(sessions[0]?.title || '대화');
  const historyModal = page.getByRole('heading', { name: '이전 히스토리' }).locator('..').locator('..');
  await historyModal.getByRole('button').filter({ hasText: targetTitle }).first().click();

  const loadButton = historyModal.getByRole('button', { name: '불러오기' });
  await expect(loadButton).toBeEnabled();
  await loadButton.click();

  await expect(page.getByRole('heading', { name: '이전 히스토리' })).toHaveCount(0);
});

test('게스트 로그인 선택 후 로그인 버튼이 유지되고 모달이 닫힌다', async ({ page }) => {
  const header = page.locator('header');

  const openLogin = header
    .getByRole('button', { name: /로그인|Login/ })
    .or(header.getByRole('button', { name: /Google로 로그인/ }));

  await expect(openLogin.first()).toBeVisible({ timeout: 10000 });
  await openLogin.first().click();

  await expect(page.getByRole('heading', { name: /로그인 방법 선택/ })).toBeVisible();

  const guestButton = page.getByRole('button', { name: /게스트로 계속하기/ });
  await expect(guestButton).toBeVisible();
  await guestButton.click();

  await expect(page.getByRole('heading', { name: /로그인 방법 선택/ })).toHaveCount(0);
  await expect(header.getByRole('button', { name: /로그인|Login|Google로 로그인/ })).toBeVisible({ timeout: 10000 });
});

test('페이지에 Loading... 텍스트가 노출되지 않는다', async ({ page }) => {
  await expect(page.getByText('Loading...')).toHaveCount(0);
});

test('카메라 촬영 후 즉시 닫히고 텍스트 없음도 토스트 표시', async ({ page }) => {
  page.on('dialog', async (dialog) => {
    await dialog.dismiss();
  });

  await page.addInitScript(() => {
    const track = { stop: () => {} } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const mediaDevices = (navigator as any).mediaDevices || {};
    (navigator as any).mediaDevices = mediaDevices;
    mediaDevices.getUserMedia = async () => stream;

    try {
      const originalDrawImage = (CanvasRenderingContext2D.prototype as any).drawImage;
      (CanvasRenderingContext2D.prototype as any).drawImage = function (...args: any[]) {
        try {
          return originalDrawImage.apply(this, args);
        } catch {
          return;
        }
      };
    } catch {
    }

    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type?: string, quality?: any) {
      try {
        const blob = new Blob(['test'], { type: type || 'image/jpeg' });
        callback(blob);
      } catch (e) {
        originalToBlob.call(this, callback, type, quality);
      }
    };

    try {
      Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1280 });
      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 720 });
    } catch {
    }
  });

  await page.route('**/api/vision', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ originalText: '', translatedText: '' }),
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: '칠판 촬영' }).click();

  const cameraClose = page.getByRole('button', { name: '카메라 닫기' });
  await expect(cameraClose).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: '촬영', exact: true }).click();

  await expect(page.getByText('촬영 완료')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: '원래 페이지로 돌아가기' })).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: '원래 페이지로 돌아가기' }).click();
  await expect(cameraClose).toHaveCount(0);

  await expect(page.getByText('텍스트 없음')).toBeVisible({ timeout: 10000 });
});
