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
