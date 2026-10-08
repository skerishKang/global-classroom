import { expect, test } from '@playwright/test';

test('automatically indexes every saved local session and persists cached metadata (#76)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('global_class_settings', JSON.stringify({
      driveBackupMode: 'manual', audioCacheEnabled: true, recordOriginalEnabled: true,
      interviewTargets: ['ko', 'en'],
    }));
    if (localStorage.getItem('global_classroom_sessions')) return;
    const sessions = Array.from({ length: 23 }, (_, index) => ({
      id: `saved-${index}`,
      title: '새 대화',
      createdAt: 1000 + index,
      updatedAt: 1000 + index,
      items: index === 22 ? [] : [
        { id: `u-${index}`, original: `Archived conversation ${index} about interview preparation`,
          translated: 'translation', isTranslating: false, timestamp: index },
      ],
    }));
    localStorage.setItem('global_classroom_sessions', JSON.stringify(sessions));
  });

  let requests = 0;
  await page.route('**/api/session-metadata', async (route) => {
    requests += 1;
    const payload = JSON.parse(route.request().postData() || '{}');
    const match = String(payload.history).match(/Archived conversation (\d+)/);
    const index = match?.[1] || 'unknown';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      title: `Archived interview topic ${index}`,
      summary: `Session ${index} discussed interviews and preparation.`,
    }) });
  });

  await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => {
    const sessions = await page.evaluate(() => JSON.parse(localStorage.getItem('global_classroom_sessions') || '[]'));
    return sessions.filter((session: { summary?: string }) => session.summary).length;
  }, { timeout: 20000 }).toBe(22);
  expect(requests).toBe(22);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('global_classroom_sessions') || '[]'));
  expect(stored).toHaveLength(23);
  expect(stored[0].items[0].original).toBe('Archived conversation 0 about interview preparation');
  expect(stored[0].title).toBe('Archived interview topic 0');
  expect(stored[0].summary).toContain('discussed interviews');
  expect(stored[22].items).toHaveLength(0);

  await page.getByRole('button', { name: '대화 기록' }).click();
  await expect(page.getByRole('heading', { name: '이전 히스토리' })).toBeVisible();
  await expect(page.getByTestId('history-session-summary')).toHaveCount(22);
  await expect(page.getByTestId('history-metadata-progress')).toContainText('22/22');
  await expect(page.getByText('Archived interview topic 0')).toBeVisible();

  // Already-cached sessions must not be re-sent to the model on reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: '대화 기록' })).toBeVisible();
  await page.waitForTimeout(1000);
  expect(requests).toBe(22);
});
