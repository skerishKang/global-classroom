import { expect, test } from '@playwright/test';

test('AudioWorklet really captures PCM in a browser render thread (#87)', async ({ page }) => {
  await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    (window as any).__audio87 = { chunks: 0, bytes: 0, mode: '', error: '' };
    const button = document.createElement('button');
    button.id = 'test-audio-worklet-87';
    button.textContent = 'Test audio capture';
    button.style.cssText = 'position:fixed;top:40%;left:40%;z-index:99999;padding:20px;background:white;color:black';
    button.onclick = async () => {
      let context: AudioContext | undefined;
      let source: OscillatorNode | undefined;
      try {
        const modulePath = '/utils/interviewAudioCapture.ts';
        const lib = await import(/* @vite-ignore */ modulePath);
        context = new AudioContext({ sampleRate: 16_000 });
        const media = context.createMediaStreamDestination();
        source = context.createOscillator();
        source.frequency.value = 330;
        source.connect(media);
        source.start();
        await context.resume();
        const capture = await lib.startInterviewAudioCapture(context, media.stream, (pcm: ArrayBuffer) => {
          (window as any).__audio87.chunks++;
          (window as any).__audio87.bytes += pcm.byteLength;
        });
        (window as any).__audio87.mode = capture.mode;
        (window as any).__audio87.close = async () => {
          capture.stop();
          source!.stop();
          await context!.close();
        };
      } catch (error) {
        (window as any).__audio87.error = String(error);
        if (source) source.stop();
        if (context) await context.close();
      }
    };
    document.body.append(button);
  });
  await page.locator('#test-audio-worklet-87').click();
  await expect.poll(() => page.evaluate(() => (window as any).__audio87.error)).toBe('');
  await expect.poll(() => page.evaluate(() => (window as any).__audio87.mode), { timeout: 12000 }).toBe('worklet');
  await expect.poll(() => page.evaluate(() => (window as any).__audio87.chunks), { timeout: 12000 }).toBeGreaterThanOrEqual(3);
  const sample = await page.evaluate(() => ({
    chunks: (window as any).__audio87.chunks,
    bytes: (window as any).__audio87.bytes,
  }));
  expect(sample.bytes).toBeGreaterThanOrEqual(3 * 4096);
  await page.evaluate(async () => { await (window as any).__audio87.close(); });
  const frozen = await page.evaluate(() => (window as any).__audio87.chunks);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as any).__audio87.chunks)).toBe(frozen);
});

test('many Interview rows coalesce localStorage writes and flush before leaving (#87)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('global_class_settings', JSON.stringify({
      driveBackupMode: 'manual', recordOriginalEnabled: true, interviewTargets: ['ko', 'en'],
    }));
    (window as any).__save87 = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key === 'global_classroom_sessions') (window as any).__save87++;
      return original.call(this, key, value);
    };
    const rawFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (o: object) => new Response(JSON.stringify(o), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
      if (url.includes('/api/interview-answer')) return json({
        shouldAnswer: false, answer: '', language: 'en',
      });
      if (url.includes('/api/translate')) return json({
        translated: '테스트 번역',
      });
      return rawFetch(input, init);
    };
  });
  await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  const input = page.getByRole('textbox', { name: '인터뷰 텍스트 입력' });
  const total = 24;
  const prior = await page.evaluate(() => (window as any).__save87);
  for (let index = 0; index < total; index++) {
    await input.fill(`Question ${index}: explain your skills and experience clearly.`);
    await input.press('Enter');
  }
  await expect(page.getByTestId('interview-row')).toHaveCount(total, { timeout: 12000 });
  await page.waitForTimeout(1100);
  const writes = await page.evaluate(() => (window as any).__save87);
  // Twenty-four turns also receive translation results; writing every history
  // update would require >=48 serializations. The debounce must avoid that.
  expect(writes - prior).toBeLessThanOrEqual(10);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('global_classroom_sessions') || '[]'));
  expect(saved[0].items).toHaveLength(total);
  expect(saved[0].items[0].original).toContain('Question 0');
  expect(saved[0].items.at(-1).original).toContain('Question 23');
});
