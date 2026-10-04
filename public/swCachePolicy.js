/*
 * Service Worker cache policy for Global Classroom (#31).
 *
 * Contract: the service worker may only cache same-origin reviewed static
 * assets. Everything else — app API calls, cross-origin Google API / font
 * responses, authenticated requests, dynamic data — must pass straight
 * through to the network and must never reach Cache Storage.
 *
 * This stays a tiny dependency-free classic script so the service worker can
 * load it with importScripts() and the unit tests can load it with require().
 */
(function (global) {
  'use strict';

  // Reviewed same-origin static scope. netlify.toml serves only /assets/* as
  // immutable; the other files are the PWA shell assets referenced by
  // index.html/manifest.json. Deliberately NOT cacheable: /api/*, /sw.js,
  // /mobile-usage-tutorial/* (standalone page, unused by the app shell) and
  // every unlisted path.
  var CACHEABLE_STATIC_PREFIXES = ['/assets/'];
  var CACHEABLE_STATIC_FILES = ['/manifest.json', '/logo192.png', '/logo512.png'];

  function requestHeaders(request) {
    return request && request.headers && typeof request.headers.get === 'function'
      ? request.headers
      : null;
  }

  function isAppApiPath(pathname) {
    return pathname === '/api' || pathname.indexOf('/api/') === 0;
  }

  function isReviewedStaticPath(pathname) {
    for (var i = 0; i < CACHEABLE_STATIC_PREFIXES.length; i += 1) {
      if (pathname.indexOf(CACHEABLE_STATIC_PREFIXES[i]) === 0) return true;
    }
    return CACHEABLE_STATIC_FILES.indexOf(pathname) !== -1;
  }

  /**
   * Decide how the fetch handler must treat a request.
   *
   * Accepts a real Request or any request-like object (method/url/mode/
   * destination/headers) so the policy can be tested without a worker.
   *
   * Precedence contract (#31): security conditions are evaluated BEFORE the
   * document/navigation branch, so an authenticated or cross-origin document
   * can never reach the document cache refresh. Offline convenience for
   * documents only applies after every security check passes.
   *
   * @returns {'network-first-document'|'cache-first-static'|'network-only'}
   */
  function resolveRequestStrategy(request, location) {
    if (!request) return 'network-only';
    var method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
    if (method !== 'GET') return 'network-only';

    var headers = requestHeaders(request);
    // Authenticated and range (partial) requests are never cacheable.
    if (headers && headers.get('Authorization')) return 'network-only';
    if (headers && headers.get('Range')) return 'network-only';

    var origin = location && typeof location.origin === 'string' ? location.origin : '';
    var url;
    try {
      url = new URL(request.url);
    } catch (error) {
      return 'network-only';
    }
    // Cross-origin responses are never cached (Google APIs, fonts, ...).
    if (!origin || url.origin !== origin) return 'network-only';

    // Defense in depth: the static allowlist already excludes the API, but the
    // app API boundary is called out explicitly.
    if (isAppApiPath(url.pathname)) return 'network-only';

    // Only after every security check passed may a document/navigation request
    // keep its network-first (offline fallback) semantics.
    if (request.mode === 'navigate' || request.destination === 'document') {
      return 'network-first-document';
    }

    if (isReviewedStaticPath(url.pathname)) return 'cache-first-static';

    return 'network-only';
  }

  function isCacheEligibleRequest(request, location) {
    return resolveRequestStrategy(request, location) === 'cache-first-static';
  }

  /**
   * Only complete, successful responses may ever be written to a cache.
   * Opaque (cross-origin no-cors) and error responses are rejected even if a
   * future caller forgets the origin check.
   */
  function isCacheableResponse(response) {
    return Boolean(response)
      && response.ok === true
      && response.type !== 'opaque'
      && response.type !== 'error';
  }

  var api = {
    resolveRequestStrategy: resolveRequestStrategy,
    isCacheEligibleRequest: isCacheEligibleRequest,
    isCacheableResponse: isCacheableResponse,
    isReviewedStaticPath: isReviewedStaticPath,
  };

  // Classic script (service worker / browser): attach to the global object.
  // CJS (unit tests via require): export through module.exports. Some bundler
  // interop layers provide neither, so fall back to globalThis for both.
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = api;
    if (typeof globalThis !== 'undefined') globalThis.SWCachePolicy = api;
  } else if (global) {
    global.SWCachePolicy = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.SWCachePolicy = api;
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
