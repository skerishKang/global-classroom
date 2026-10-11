import { expect, test } from '@playwright/test';

test('three service tabs navigate to the transcription page', async ({ page }) => {
  await page.goto('/transcribe');
  await expect(page.getByRole('navigation', { name: '서비스 메뉴' })).toBeVisible();
  await expect(page.getByRole('link', { name: '글로벌 클래스룸' })).toHaveAttribute('href', '/classroom');
  await expect(page.getByRole('link', { name: '인터뷰' })).toHaveAttribute('href', '/interview');
  await expect(page.getByRole('link', { name: '전사', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('정밀 음성 전사')).toBeVisible();
  await expect(page.getByText('오늘 파일 전사 시도')).toBeVisible();
});

test('uploaded file uses the transcription API and shows editable speaker/times', async ({ page }) => {
  await page.route('**/api/transcribe-file', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      text: '안녕하세요',
      words: [{ speaker: 'spk_1', text: '안녕하세요', start: 0.4, end: 1.2 }],
      model: 'gemini-3.5-transcribe',
    }),
  }));
  await page.goto('/transcribe');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'sample.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from([0x49, 0x44, 0x33]),
  });
  await page.getByRole('button', { name: '정밀 전사 시작' }).click();
  await expect(page.getByRole('textbox', { name: '전사 구간 1' })).toHaveValue('안녕하세요');
  await expect(page.getByRole('textbox', { name: '화자 1' })).toHaveValue('spk_1');
  await page.getByRole('textbox', { name: '전사 구간 1' }).fill('수정했습니다');
  await expect(page.getByRole('textbox', { name: '전사 구간 1' })).toHaveValue('수정했습니다');
});

test('top navigation and action buttons provide hover feedback without changing disabled controls', async ({ page }) => {
  await page.route('**/api/transcribe-file', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      text: '안녕하세요',
      words: [{ speaker: 'spk_1', text: '안녕하세요', start: 0.4, end: 1.2 }],
    }),
  }));
  await page.goto('/transcribe');
  const background = (locator: import('@playwright/test').Locator) =>
    locator.evaluate((element) => getComputedStyle(element).backgroundColor);

  const nav = page.getByRole('link', { name: '인터뷰' });
  const navIdle = await background(nav);
  await nav.hover();
  await expect.poll(() => background(nav)).not.toBe(navIdle);

  const activeNav = page.getByRole('link', { name: '전사', exact: true });
  await page.getByRole('heading', { name: '정밀 음성 전사' }).hover();
  const activeIdle = await background(activeNav);
  await activeNav.hover();
  await expect.poll(() => background(activeNav)).not.toBe(activeIdle);

  const liveTab = page.getByRole('tab', { name: '실시간 전사' });
  await page.getByRole('heading', { name: '정밀 음성 전사' }).hover();
  const tabIdle = await background(liveTab);
  await liveTab.hover();
  await expect.poll(() => background(liveTab)).not.toBe(tabIdle);

  const submit = page.getByRole('button', { name: '정밀 전사 시작' });
  await expect(submit).toBeDisabled();
  const disabledBg = await background(submit);
  await submit.hover({ force: true });
  await expect.poll(() => background(submit)).toBe(disabledBg);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'sample.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from([0x49, 0x44, 0x33]),
  });
  await page.getByRole('heading', { name: '정밀 음성 전사' }).hover();
  const enabledBg = await background(submit);
  await submit.hover();
  await expect.poll(() => background(submit)).not.toBe(enabledBg);
  await submit.click();

  const exportButton = page.getByRole('button', { name: 'JSON' });
  await expect(exportButton).toBeEnabled();
  await page.getByRole('heading', { name: '정밀 음성 전사' }).hover();
  const exportIdle = await background(exportButton);
  await exportButton.hover();
  await expect.poll(() => background(exportButton)).not.toBe(exportIdle);
});

test('three top-level service pages retain their navigation', async ({ page }) => {
  for (const target of ['/classroom', '/interview', '/transcribe']) {
    await page.goto(target);
    const nav = page.getByRole('navigation', { name: '서비스 메뉴' });
    await expect(nav).toBeVisible();
    const active = target.slice(1) === 'classroom' ? '글로벌 클래스룸'
      : target.slice(1) === 'interview' ? '인터뷰' : '전사';
    await expect(nav.getByRole('link', { name: active, exact: true }))
      .toHaveAttribute('aria-current', 'page');
  }
});
