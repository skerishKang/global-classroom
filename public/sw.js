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
        .catch(() => caches.match(request))
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
