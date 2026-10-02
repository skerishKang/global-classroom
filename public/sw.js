const CACHE_NAME = 'global-classroom-v4'; // 캐시 버전 업데이트로 기존 오래된 리소스 무효화
const ASSETS = ['/', '/manifest.json']; // HTML은 네트워크 우선으로 처리

// 정적 자산 사전 캐싱
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

// HTML은 네트워크 우선, 정적 자산은 캐시 우선
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // GET 이외 메서드는 캐시하지 않고 바로 네트워크로 보냄 (POST put 오류 방지)
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }

  // 내비게이션 요청 또는 HTML 요청은 네트워크 우선
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // 최신 HTML을 캐시에 갱신
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // 기타 정적 파일은 캐시 우선
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
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
