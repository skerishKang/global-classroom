import { expect, test } from '@playwright/test';

test('typed questions and substantive statements generate cached answer/reaction with automatic translation (#78)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('global_class_settings', JSON.stringify({
      driveBackupMode: 'manual',
      recordOriginalEnabled: true,
      audioCacheEnabled: true,
      interviewTargets: ['ko', 'en'],
    }));

    const log = { answers: [] as any[], translations: [] as any[] };
    (window as any).__typedAnswerLog = log;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (data: unknown) => new Response(JSON.stringify(data), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
      if (url.includes('/api/interview-answer')) {
        const body = JSON.parse(String(init?.body || '{}'));
        log.answers.push(body);
        const text = String(body.text || '');
        if (text === 'Okay.') return json({ shouldAnswer: false, answer: '', language: 'en' });
        if (text.includes('Mercor Academy')) return json({
          shouldAnswer: true,
          answer: 'That sounds like a practical way to validate real skills.',
          language: 'en',
        });
        return json({
          shouldAnswer: true,
          answer: 'My main strength is solving problems carefully while communicating clearly.',
          language: 'en',
        });
      }
      if (url.includes('/api/translate')) {
        const body = JSON.parse(String(init?.body || '{}'));
        log.translations.push(body);
        return json({ translated: 'KO:' + body.text });
      }
      return realFetch(input, init);
    };
  });

  await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  const input = page.getByRole('textbox', { name: '인터뷰 텍스트 입력' });
  const send = async (value: string) => {
    await input.fill(value);
    await input.press('Enter');
  };

  await send('What are your greatest strengths, and why should we hire you?');
  const rows = page.getByTestId('interview-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).getByTestId('question-translation-cell')).toContainText('KO:What are your greatest strengths');
  await expect(rows.nth(0).getByTestId('answer-row-toggle')).toContainText('답변 보기', { timeout: 12000 });
  await expect(rows.nth(0).getByTestId('suggested-answer')).toHaveCount(0);

  await expect.poll(async () => page.evaluate(() => (window as any).__typedAnswerLog.translations
    .filter((entry: any) => String(entry.text || '').startsWith('My main strength')).length
  )).toBe(1);

  const beforeExpand = await page.evaluate(() => ({
    answers: (window as any).__typedAnswerLog.answers.length,
    translations: (window as any).__typedAnswerLog.translations.length,
  }));
  await rows.nth(0).getByTestId('answer-row-toggle').click();
  await expect(rows.nth(0).getByTestId('suggested-answer')).toContainText('My main strength');
  await expect(rows.nth(0).getByTestId('answer-translation')).toContainText('KO:My main strength');
  await expect(rows.nth(0).getByTestId('suggested-answer')).toHaveAttribute('data-answer-language', 'en');
  expect(await page.evaluate(() => ({
    answers: (window as any).__typedAnswerLog.answers.length,
    translations: (window as any).__typedAnswerLog.translations.length,
  }))).toEqual(beforeExpand);

  await send('Mercor Academy certification is earned by completing practical assignments.');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).getByTestId('answer-row-toggle')).toBeVisible();
  await rows.nth(1).getByTestId('answer-row-toggle').click();
  await expect(rows.nth(1).getByTestId('suggested-answer')).toContainText('practical way');
  await expect(rows.nth(1).getByTestId('answer-translation')).toContainText('KO:That sounds like');

  await send('Okay.');
  await expect(rows).toHaveCount(3);
  await expect.poll(async () => page.evaluate(() => (window as any).__typedAnswerLog.answers.length)).toBe(3);
  await expect(rows.nth(2).getByTestId('answer-row-toggle')).toHaveCount(0);
  const recorded = await page.evaluate(() => (window as any).__typedAnswerLog.answers);
  expect(recorded.map((entry: any) => entry.answerLanguage)).toEqual(['en', 'en', 'en']);
  expect(recorded[1].recentContext[0]).toContain('What are your greatest strengths');
});
