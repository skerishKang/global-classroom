importScripts('./swCachePolicy.js');

const CACHE_NAME = 'global-classroom-v5'; // #31: 정책 위반 응답이 섞인 v4 캐시 무효화
const ASSETS = ['/', '/manifest.json']; // HTML은 네트워크 우선으로 처리

// 정적 자산 사전 캐싱
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

// 캐시 정책(#31): same-origin 검토된 정적 자산만 캐시 우선,
// 문서는 네트워크 우선, 그 외(API/외부/인증 요청)는 네트워크 전용.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const strategy = self.SWCachePolicy.resolveRequestStrategy(request, self.location);

  // GET 이외 메서드, /api/*, cross-origin, Authorization/Range 요청은
  // 캐시와 무관하게 네트워크로만 보낸다.
  if (strategy === 'network-only') {
    event.respondWith(fetch(request));
    return;
  }

  // 내비게이션 요청 또는 HTML 요청은 네트워크 우선
  if (strategy === 'network-first-document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // 성공한 문서만 캐시를 갱신 (실패/opaque 응답은 캐시 금지)
          if (self.SWCachePolicy.isCacheableResponse(response)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          // #87: 네비게이션 실패 시 반드시 Response를 돌려준다.
          // (?mode=interview 처럼 쿼리가 붙은 URL은 미리 캐시한 '/'와 다른
          // 요청이라, 이전에는 undefined가 respondWith로 전달되어
          // "TypeError: Failed to fetch"로 화면 전체가 실패했다.)
          const cached = await caches.match(request, { ignoreSearch: true });
          if (cached) return cached;
          const shell = await caches.match('/');
          if (shell) return shell;
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>오프라인</title><p>네트워크에 연결할 수 없습니다. 연결 후 다시 시도해 주세요.</p>',
            {
              status: 503,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }
          );
        })
    );
    return;
  }

  // 검토된 same-origin 정적 자산만 캐시 우선
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (self.SWCachePolicy.isCacheableResponse(response)) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

// 이전 캐시 정리
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ).then(() => self.clients.claim())
    )
  );
});
