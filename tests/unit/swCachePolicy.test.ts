import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The policy module is a dependency-free classic script: the service worker
// loads it via importScripts(), the tests load the very same file via require()
// so the assertions cover the exact policy the worker runs in production.
const require = createRequire(import.meta.url);
const loaded: any = require('../../public/swCachePolicy.js');
const policy: any =
  loaded && typeof loaded.resolveRequestStrategy === 'function'
    ? loaded
    : (globalThis as any).SWCachePolicy;

if (!policy || typeof policy.resolveRequestStrategy !== 'function') {
  throw new Error('swCachePolicy.js did not expose its policy API');
}

const ORIGIN = 'https://classroom.example';
const LOCATION = { origin: ORIGIN };

type RequestLike = Parameters<typeof policy.resolveRequestStrategy>[0];

const plainGet = (url: string, extra: Record<string, unknown> = {}): RequestLike => ({
  method: 'GET',
  url,
  headers: new Headers(),
  ...extra,
});

describe('service worker cache policy (#31)', () => {
  test('same-origin reviewed static assets are cache eligible', () => {
    expect(policy.resolveRequestStrategy(plainGet(`${ORIGIN}/assets/index-9f2c1a.js`), LOCATION)).toBe('cache-first-static');
    expect(policy.resolveRequestStrategy(plainGet(`${ORIGIN}/assets/index-9f2c1a.css`), LOCATION)).toBe('cache-first-static');
    expect(policy.resolveRequestStrategy(plainGet(`${ORIGIN}/manifest.json`), LOCATION)).toBe('cache-first-static');
    expect(policy.resolveRequestStrategy(plainGet(`${ORIGIN}/logo192.png`), LOCATION)).toBe('cache-first-static');
    expect(policy.resolveRequestStrategy(plainGet(`${ORIGIN}/logo512.png`), LOCATION)).toBe('cache-first-static');
    // unreviewed same-origin paths stay out of the cache
    expect(policy.resolveRequestStrategy(plainGet(`${ORIGIN}/mobile-usage-tutorial/script.js`), LOCATION)).toBe('network-only');
    expect(policy.resolveRequestStrategy(plainGet(`${ORIGIN}/sw.js`), LOCATION)).toBe('network-only');
    expect(policy.resolveRequestStrategy(plainGet(`${ORIGIN}/`), LOCATION)).toBe('network-only');
  });

  test('/api/* GET requests are never cache eligible', () => {
    expect(policy.isCacheEligibleRequest(plainGet(`${ORIGIN}/api/translate`), LOCATION)).toBe(false);
    expect(policy.isCacheEligibleRequest(plainGet(`${ORIGIN}/api/detect-language`), LOCATION)).toBe(false);
    expect(policy.isCacheEligibleRequest(plainGet(`${ORIGIN}/api`), LOCATION)).toBe(false);
    expect(policy.resolveRequestStrategy(plainGet(`${ORIGIN}/api/translate`), LOCATION)).toBe('network-only');
  });

  test('cross-origin Google API responses are never cache eligible', () => {
    expect(
      policy.isCacheEligibleRequest(
        plainGet('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'),
        LOCATION,
      )
    ).toBe(false);
    expect(
      policy.resolveRequestStrategy(plainGet('https://www.googleapis.com/drive/v3/files?fields=x'), LOCATION)
    ).toBe('network-only');
  });

  test('cross-origin font responses are never cache eligible', () => {
    expect(
      policy.isCacheEligibleRequest(plainGet('https://fonts.googleapis.com/css2?family=Inter'), LOCATION)
    ).toBe(false);
    expect(
      policy.isCacheEligibleRequest(plainGet('https://fonts.gstatic.com/s/inter.woff2'), LOCATION)
    ).toBe(false);
  });

  test('same-origin requests carrying an Authorization header are never cache eligible', () => {
    const authedOnAsset = {
      method: 'GET',
      url: `${ORIGIN}/assets/index-9f2c1a.js`,
      headers: new Headers({ Authorization: 'Bearer secret' }),
    };
    const authedOnManifest = {
      method: 'GET',
      url: `${ORIGIN}/manifest.json`,
      headers: new Headers({ authorization: 'Bearer secret' }),
    };
    expect(policy.isCacheEligibleRequest(authedOnAsset, LOCATION)).toBe(false);
    expect(policy.isCacheEligibleRequest(authedOnManifest, LOCATION)).toBe(false);
    expect(policy.resolveRequestStrategy(authedOnAsset, LOCATION)).toBe('network-only');
  });

  test('navigation/document requests keep network-first semantics', () => {
    const navigation = plainGet(`${ORIGIN}/interview?mode=1`, { mode: 'navigate' });
    expect(policy.resolveRequestStrategy(navigation, LOCATION)).toBe('network-first-document');

    // Even a static-looking path must stay network-first when it is a document.
    const documentRequest = plainGet(`${ORIGIN}/assets/index-9f2c1a.js`, { destination: 'document' });
    expect(policy.resolveRequestStrategy(documentRequest, LOCATION)).toBe('network-first-document');
  });

  test('security conditions are evaluated before the document/navigation branch', () => {
    // AUTH_DOCUMENT: an authenticated navigation must never reach the document
    // cache refresh, so it is network-only.
    const authedNavigation = plainGet(`${ORIGIN}/interview`, {
      mode: 'navigate',
      destination: 'document',
      headers: new Headers({ Authorization: 'Bearer fixture' }),
    });
    expect(policy.resolveRequestStrategy(authedNavigation, LOCATION)).toBe('network-only');

    // Same verdict when only destination=document marks the document.
    const authedDocument = plainGet(`${ORIGIN}/`, {
      destination: 'document',
      headers: new Headers({ Authorization: 'Bearer fixture' }),
    });
    expect(policy.resolveRequestStrategy(authedDocument, LOCATION)).toBe('network-only');

    // CROSS_ORIGIN_DOCUMENT: a document from another origin is never document-cached.
    const crossOriginDocument = plainGet('https://example-other-origin.test/page', {
      destination: 'document',
    });
    expect(policy.resolveRequestStrategy(crossOriginDocument, LOCATION)).toBe('network-only');

    // The app API boundary also outranks the document branch.
    const apiDocument = plainGet(`${ORIGIN}/api/translate`, { destination: 'document' });
    expect(policy.resolveRequestStrategy(apiDocument, LOCATION)).toBe('network-only');

    // NORMAL_SAME_ORIGIN_DOCUMENT: with every security check passed, a clean
    // same-origin document keeps the network-first offline semantics — the
    // only case allowed to.
    const normalDocument = plainGet(`${ORIGIN}/interview`, {
      mode: 'navigate',
      destination: 'document',
    });
    expect(policy.resolveRequestStrategy(normalDocument, LOCATION)).toBe('network-first-document');
  });

  test('non-GET and range requests are never cache eligible', () => {
    expect(
      policy.isCacheEligibleRequest({ method: 'POST', url: `${ORIGIN}/api/translate`, headers: new Headers() }, LOCATION)
    ).toBe(false);
    expect(
      policy.isCacheEligibleRequest(
        { method: 'GET', url: `${ORIGIN}/logo512.png`, headers: new Headers({ Range: 'bytes=0-99' }) },
        LOCATION,
      )
    ).toBe(false);
  });

  test('only successful, non-opaque responses may be written to the cache', () => {
    expect(policy.isCacheableResponse(new Response('ok', { status: 200 }))).toBe(true);
    expect(policy.isCacheableResponse(new Response('nope', { status: 404 }))).toBe(false);
    expect(policy.isCacheableResponse(new Response('boom', { status: 502 }))).toBe(false);
    expect(policy.isCacheableResponse(new Response('', { status: 302 }))).toBe(false);
    expect(policy.isCacheableResponse(Response.error())).toBe(false);
    expect(policy.isCacheableResponse(undefined)).toBe(false);
  });

  test('sw.js actually wires the policy module in (drift guard)', () => {
    const swSource = readFileSync(resolve(import.meta.dirname, '../../public/sw.js'), 'utf8');
    expect(swSource).toContain("importScripts('./swCachePolicy.js')");
    expect(swSource).toContain('SWCachePolicy.resolveRequestStrategy(request, self.location)');
    // Both cache writes (document refresh + static asset) must sit behind the
    // response guard: two puts, two guards, no unguarded put left.
    expect(swSource.match(/cache\.put\(/g)?.length).toBe(2);
    expect(swSource.match(/isCacheableResponse\(/g)?.length).toBe(2);
  });
});
