import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

test.describe('application Service Worker isolation', () => {
  test('registers explicitly and keeps API requests out of CacheStorage', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const registration = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) {
        return { supported: false, scriptURL: '' };
      }
      const ready = await navigator.serviceWorker.ready;
      return {
        supported: true,
        scriptURL: ready.active?.scriptURL || ready.installing?.scriptURL || ready.waiting?.scriptURL || '',
      };
    });

    expect(registration.supported).toBe(true);
    expect(registration.scriptURL).toMatch(/\/sw\.js$/);

    // A newly installed worker takes control on the next navigation.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

    const cacheState = await page.evaluate(async () => {
      const cacheNames = await caches.keys();
      const cachedUrls: string[] = [];
      for (const cacheName of cacheNames) {
        const cache = await caches.open(cacheName);
        const keys = await cache.keys();
        cachedUrls.push(...keys.map((request) => request.url));
      }
      return {
        controlled: Boolean(navigator.serviceWorker.controller),
        cacheNames,
        cachedUrls,
      };
    });

    expect(cacheState.controlled).toBe(true);
    expect(cacheState.cacheNames).toContain('global-classroom-v5');
    expect(cacheState.cachedUrls.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);
  });
});
