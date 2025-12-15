import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
});

test('헤더 아이콘 순서(새 대화/이전 히스토리/내보내기/로그인) 및 새창 제거', async ({ page }) => {
  const topRow = page.locator('header > div').first();

  const newChatButton = topRow.getByRole('button', { name: '새 대화' });
  const historyButton = topRow.getByRole('button', { name: '이전 히스토리' });
  const exportButton = topRow.getByRole('button', { name: '내보내기' });
  const loginButton = topRow.getByRole('button', { name: /Login|Google로 로그인/ });

  await expect(newChatButton).toBeVisible();
  await expect(historyButton).toBeVisible();
  await expect(exportButton).toBeVisible();
  await expect(loginButton).toBeVisible({ timeout: 10000 });

  await expect(topRow.getByRole('button', { name: '새창' })).toHaveCount(0);

  const newBox = await newChatButton.boundingBox();
  const historyBox = await historyButton.boundingBox();
  const exportBox = await exportButton.boundingBox();
  const loginBox = await loginButton.boundingBox();

  expect(newBox).not.toBeNull();
  expect(historyBox).not.toBeNull();
  expect(exportBox).not.toBeNull();
  expect(loginBox).not.toBeNull();

  expect(newBox!.x).toBeLessThan(historyBox!.x);
  expect(historyBox!.x).toBeLessThan(exportBox!.x);
  expect(exportBox!.x).toBeLessThan(loginBox!.x);
});

test('새 대화 생성 시 로컬 세션이 증가하고, 히스토리 모달에서 불러오기 동작', async ({ page }) => {
  const topRow = page.locator('header > div').first();

  await expect(topRow.getByRole('button', { name: '새 대화' })).toBeVisible();

  await topRow.getByRole('button', { name: '새 대화' }).click();

  await topRow.getByRole('button', { name: '이전 히스토리' }).click();
  await expect(page.getByRole('heading', { name: '이전 히스토리' })).toBeVisible();

  const localHeader = page.locator('div', { hasText: '로컬 세션:' }).first();
  const headerText = (await localHeader.innerText()).replace(/\s+/g, ' ');
  const match = headerText.match(/로컬 세션:\s*(\d+)/);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThanOrEqual(2);

  const loadButton = page.getByRole('button', { name: '불러오기' });
  await expect(loadButton).toBeEnabled();
  await loadButton.click();

  await expect(page.getByRole('heading', { name: '이전 히스토리' })).toHaveCount(0);
});

test('게스트 로그인 선택 시 헤더에 Guest 표시', async ({ page }) => {
  const header = page.locator('header');

  const openLogin = header
    .getByRole('button', { name: 'Login' })
    .or(header.getByRole('button', { name: /Google로 로그인/ }));

  await expect(openLogin.first()).toBeVisible({ timeout: 10000 });
  await openLogin.first().click();

  await expect(page.getByRole('heading', { name: /로그인 방법 선택/ })).toBeVisible();

  const guestButton = page.getByRole('button', { name: /게스트로 계속하기/ });
  await expect(guestButton).toBeVisible();
  await guestButton.click();

  await expect(page.getByRole('heading', { name: /로그인 방법 선택/ })).toHaveCount(0);
  await expect(header.getByText('Guest')).toBeVisible({ timeout: 10000 });
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

  await page.getByRole('button', { name: '촬영' }).click();
  await expect(cameraClose).toHaveCount(0);

  await expect(page.getByText('텍스트 없음')).toBeVisible({ timeout: 10000 });
});
