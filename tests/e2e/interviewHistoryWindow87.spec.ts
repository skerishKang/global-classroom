import { expect, test } from '@playwright/test';

// #87: realistic local-session sizes without paid Live API calls. The
// persisted history must remain complete while the Interview DOM stays bounded.
for (const total of [0, 50, 100, 200]) {
  test(`Interview renders a bounded window for ${total} stored turns (#87)`, async ({ page }) => {
    await page.addInitScript((count) => {
      const now = Date.now();
      const items = Array.from({ length: count }, (_, i) => ({
        id: `fixture_${i}`,
        original: `Reference interview turn ${i + 1}`,
        translated: `Reference translation ${i + 1}`,
        sourceLanguage: 'en',
        sourceKind: 'voice',
        timestamp: now + i,
        isTranslating: false,
      }));
      localStorage.setItem('global_classroom_settings', JSON.stringify({ driveBackupMode: 'manual' }));
      localStorage.setItem('global_classroom_sessions', JSON.stringify([{
        id: 'fixture-long-interview', createdAt: now, updatedAt: now,
        title: 'Fixture interview', items,
      }]));
    }, total);

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
    const rows = page.getByTestId('interview-row');
    await expect(rows).toHaveCount(Math.min(total, 60));
    if (total === 0) {
      await expect(page.getByTestId('interview-show-earlier')).toHaveCount(0);
      return;
    }
    await expect(rows.last()).toContainText(`Reference interview turn ${total}`);
    if (total <= 60) {
      await expect(page.getByTestId('interview-show-earlier')).toHaveCount(0);
      await expect(rows.first()).toContainText('Reference interview turn 1');
      return;
    }

    await expect(rows.first()).toContainText(`Reference interview turn ${total - 59}`);
    const pane = page.getByTestId('conversation-scroll');
    const earlier = page.getByTestId('interview-show-earlier');
    await earlier.click();
    await expect(rows).toHaveCount(Math.min(total, 120));
    await expect(rows.first()).toContainText(`Reference interview turn ${Math.max(1, total - 119)}`);
    await expect(pane).toHaveAttribute('data-following-latest', 'false');
    if (total === 200) {
      await earlier.click();
      await expect(rows).toHaveCount(180);
      await earlier.click();
      await expect(rows).toHaveCount(200);
      await expect(rows.first()).toContainText('Reference interview turn 1');
    }
    // All stored records are still persisted, regardless of rendered window.
    const stored = await page.evaluate(() => {
      const value = JSON.parse(localStorage.getItem('global_classroom_sessions') || '[]');
      return value[0]?.items?.length;
    });
    expect(stored).toBe(total);
  });
}

test('paused 200-turn interview retains its viewport when a new final arrives (#87/#88)', async ({ page }) => {
  await page.addInitScript(() => {
    const now = Date.now();
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `fixture_${i}`,
      original: `Reference interview turn ${i + 1}`,
      translated: `Reference translation ${i + 1}`,
      sourceLanguage: 'en',
      sourceKind: 'voice',
      timestamp: now + i,
      isTranslating: false,
    }));
    localStorage.setItem('global_class_settings', JSON.stringify({
      driveBackupMode: 'manual', recordOriginalEnabled: true,
      interviewTargets: ['ko', 'en'],
    }));
    localStorage.setItem('global_classroom_sessions', JSON.stringify([{
      id: 'fixture-paused-interview', createdAt: now, updatedAt: now,
      title: 'Paused interview fixture', items,
    }]));
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (data: unknown) => new Response(JSON.stringify(data), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
      if (url.includes('/api/detect-language')) return json({ code: 'en' });
      if (url.includes('/api/interview-answer')) return json({ shouldAnswer: false });
      if (url.includes('/api/translate')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return json({ translated: 'KO:' + body.text });
      }
      return realFetch(input, init);
    };
  });

  await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  const pane = page.getByTestId('conversation-scroll');
  const rows = page.getByTestId('interview-row');
  await expect(rows).toHaveCount(60);
  const bounds = await pane.boundingBox();
  expect(bounds).toBeTruthy();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.wheel(0, -500);
  await expect(pane).toHaveAttribute('data-following-latest', 'false');
  const pausedTop = await pane.evaluate((element) => element.scrollTop);
  await expect(rows.first()).toContainText('Reference interview turn 141');
  await expect(rows.last()).toContainText('Reference interview turn 200');

  const input = page.getByRole('textbox', { name: '인터뷰 텍스트 입력' });
  await input.fill('New final utterance after 200 stored turns.');
  await input.press('Enter');
  await expect(page.getByTestId('interview-latest-button')).toBeVisible();
  await expect(rows).toHaveCount(60);
  await expect(rows.first()).toContainText('Reference interview turn 141');
  await expect(rows.last()).toContainText('Reference interview turn 200');
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(pausedTop);

  await page.getByTestId('interview-latest-button').click();
  await expect(pane).toHaveAttribute('data-following-latest', 'true');
  await expect(rows).toHaveCount(60);
  await expect(rows.first()).toContainText('Reference interview turn 142');
  await expect(rows.last()).toContainText('New final utterance after 200 stored turns.');
  await expect.poll(() => pane.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(64);
});
