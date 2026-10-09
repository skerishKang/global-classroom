import { expect, test } from '@playwright/test';

test('real wheel pauses Interview follow while new transcript and translations arrive (#88)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('global_class_settings', JSON.stringify({
      driveBackupMode: 'manual', audioCacheEnabled: true,
      recordOriginalEnabled: true, interviewTargets: ['ko', 'en'],
    }));
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (payload: unknown) => new Response(JSON.stringify(payload), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
      if (url.includes('/api/detect-language')) return json({ code: 'en' });
      if (url.includes('/api/interview-answer')) return json({
        shouldAnswer: true, answer: 'I would keep my answer short and clear.', language: 'en',
      });
      if (url.includes('/api/translate')) {
        const body = JSON.parse(String(init?.body || '{}'));
        // Vary translation completion timing to simulate real provider response.
        await new Promise((resolve) => setTimeout(resolve, 50 + (String(body.text || '').length % 5) * 30));
        return json({ translated: 'KO:' + body.text });
      }
      return realFetch(input, init);
    };
  });

  await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  const pane = page.getByTestId('conversation-scroll');
  const input = page.getByRole('textbox', { name: '인터뷰 텍스트 입력' });
  const send = async (value: string) => {
    await input.fill(value);
    await input.press('Enter');
  };
  const bottom = () => pane.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  for (let i = 0; i < 12; i++) {
    await send(`English question ${i}: explain clearly how you would approach this situation while keeping your answer relevant to the interviewer.`);
  }
  await expect(page.getByTestId('interview-row')).toHaveCount(12);
  await expect.poll(bottom).toBeLessThanOrEqual(64);
  await expect(pane).toHaveAttribute('data-following-latest', 'true');

  // Unlike #74's synthetic onScroll, wheel is the user's actual mouse action.
  const bounds = await pane.boundingBox();
  expect(bounds).toBeTruthy();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.wheel(0, -610);
  await expect(pane).toHaveAttribute('data-following-latest', 'false');
  const paused = await pane.evaluate((el) => el.scrollTop);

  await send('A newly recognized English interview statement with delayed translation.');
  await expect(page.getByTestId('interview-row')).toHaveCount(13);
  await expect(page.getByTestId('interview-latest-button')).toBeVisible();
  await expect.poll(async () => pane.evaluate((el) => el.scrollTop)).toBe(paused);
  await expect(page.getByTestId('interview-row').last().getByTestId('question-translation-cell')).toContainText('KO:');
  await expect.poll(async () => pane.evaluate((el) => el.scrollTop)).toBe(paused);

  await page.getByTestId('interview-latest-button').click();
  await expect(pane).toHaveAttribute('data-following-latest', 'true');
  await expect.poll(bottom).toBeLessThanOrEqual(64);
  await expect(page.getByTestId('interview-latest-button')).toHaveCount(0);

  // Move back into the scroll region: clicking Latest leaves the mouse over
  // the floating control, which is NOT necessarily within the scroll pane.
  const nextBounds = await pane.boundingBox();
  await page.mouse.move(nextBounds!.x + nextBounds!.width / 2, nextBounds!.y + nextBounds!.height / 2);
  // Scrolling up again and back to bottom by wheel restores auto-follow.
  await page.mouse.wheel(0, -430);
  await expect(pane).toHaveAttribute('data-following-latest', 'false');
  await page.mouse.wheel(0, 2000);
  await expect.poll(bottom).toBeLessThanOrEqual(64);
  await expect(pane).toHaveAttribute('data-following-latest', 'true');
  await send('An additional final question when follow mode is enabled again.');
  await expect(page.getByTestId('interview-row')).toHaveCount(14);
  await expect.poll(bottom).toBeLessThanOrEqual(64);
});
