import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The worker is a classic script with no module syntax, so it can be executed
// with injected globals. The real cache policy is loaded exactly as the worker
// loads it (importScripts -> SWCachePolicy), so the assertions cover production
// behaviour rather than a copy.
const require = createRequire(import.meta.url);
// The policy script attaches itself to globalThis when module.exports interop is
// unavailable, exactly as the worker's importScripts() load requires.
const loaded: any = require('../../public/swCachePolicy.js');
const policy: any =
  loaded && typeof loaded.resolveRequestStrategy === 'function'
    ? loaded
    : (globalThis as any).SWCachePolicy;

if (!policy || typeof policy.resolveRequestStrategy !== 'function') {
  throw new Error('swCachePolicy.js did not expose its policy API');
}
const SW_SOURCE = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');

const ORIGIN = 'https://classroom.example';
const SHELL_URL = 'https://classroom.example/';
const INTERVIEW_URL = 'https://classroom.example/?mode=interview';

const shellResponse = () =>
  new Response('<!doctype html><div id="root">shell</div>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

type FetchHandler = (event: any) => void;

function requestUrl(request: any): string {
  return typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
}

/** Cache lookups keyed by URL, mirroring CacheStorage.match semantics. */
function cacheStub(map: Record<string, () => Response>) {
  return async (request: any) => {
    const resolver = map[requestUrl(request)];
    return resolver ? resolver() : undefined;
  };
}

function buildWorker(options: {
  fetchImpl: (request: any) => Promise<any>;
  cacheMatch?: (request: any, init?: any) => Promise<any>;
}) {
  const handlers = new Map<string, FetchHandler>();
  const cacheWrites: string[] = [];
  const selfStub: any = {
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
    SWCachePolicy: policy,
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    addEventListener: (type: string, handler: FetchHandler) => {
      handlers.set(type, handler);
    },
  };
  const cachesStub: any = {
    open: async () => ({
      put: async (request: any) => {
        cacheWrites.push(requestUrl(request));
      },
    }),
    match: options.cacheMatch || (async () => undefined),
    keys: async () => [],
    delete: async () => true,
  };

  const importScripts = () => {
    selfStub.SWCachePolicy = policy;
  };
  const run = new Function('self', 'caches', 'fetch', 'Response', 'importScripts', SW_SOURCE);
  run(selfStub, cachesStub, options.fetchImpl, Response, importScripts);

  return { handlers, cacheWrites };
}

/** Dispatch one navigation, exactly as the browser would. */
function navigate(handlers: Map<string, FetchHandler>, url: string) {
  const handler = handlers.get('fetch');
  if (!handler) throw new Error('service worker registered no fetch handler');

  let captured: any;
  const event = {
    request: {
      method: 'GET',
      url,
      mode: 'navigate',
      destination: 'document',
      headers: new Headers(),
    },
    respondWith: (value: any) => {
      captured = value;
    },
  };
  handler(event);
  return captured;
}

const offline = () => Promise.reject(new TypeError('Failed to fetch'));

describe('#87 service worker navigation fallback', () => {
  test('a failed navigation to ?mode=interview still returns a Response', async () => {
    const { handlers } = buildWorker({ fetchImpl: offline });

    const response = await navigate(handlers, INTERVIEW_URL);

    // The pre-fix code resolved to `undefined` here, which the browser surfaced
    // as "Uncaught (in promise) TypeError: Failed to fetch" at sw.js:21 and the
    // Interview screen never loaded.
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('연결할 수 없습니다');
  });

  test('a parameterized navigation is served from the cached app shell', async () => {
    const { handlers } = buildWorker({
      fetchImpl: offline,
      cacheMatch: cacheStub({ [SHELL_URL]: shellResponse }),
    });

    const response = await navigate(handlers, INTERVIEW_URL);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('shell');
  });

  test('a query-insensitive cache hit serves the shell without a second lookup', async () => {
    const { handlers } = buildWorker({
      fetchImpl: offline,
      cacheMatch: cacheStub({ [INTERVIEW_URL]: shellResponse }),
    });

    const response = await navigate(handlers, INTERVIEW_URL);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('shell');
  });

  test('a successful navigation is still network-first and refreshes the cache', async () => {
    const { handlers, cacheWrites } = buildWorker({
      fetchImpl: async () => shellResponse(),
    });

    const response = await navigate(handlers, INTERVIEW_URL);

    expect(response.status).toBe(200);
    expect(cacheWrites).toEqual([INTERVIEW_URL]);
  });

  test('API requests stay network-only and never fall back to a cached document', async () => {
    const { handlers } = buildWorker({
      fetchImpl: offline,
      cacheMatch: cacheStub({ [SHELL_URL]: shellResponse }),
    });

    const response = navigate(handlers, `${ORIGIN}/api/translate`);

    await expect(response).rejects.toThrow();
  });
});
