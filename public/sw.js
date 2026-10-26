// Service worker: chạy offline (giao diện + thư viện + mô hình nhận diện)
const VERSION = 'v15';
const SHELL = ['./', 'index.html', 'app.js', 'face-logic.js', 'sort.js', 'shifts.js', 'import.js', 'retry.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
const CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/';

// Thư viện + mô hình nhận diện: lưu sẵn ngay khi cài, để lần mở đầu tiên đã chạy được khi mất mạng
const CDN_FILES = ['dist/face-api.js', ...['tiny_face_detector_model', 'face_landmark_68_model', 'face_recognition_model']
  .flatMap(m => [`model/${m}-weights_manifest.json`, `model/${m}.bin`])].map(f => CDN + f);

self.addEventListener('install', e => {
  e.waitUntil(Promise.all([
    caches.open('shell-' + VERSION).then(c => c.addAll(SHELL)),
    // lỗi tải CDN không chặn việc cài: các file còn thiếu sẽ được lưu ở lần dùng sau
    caches.open('cdn').then(c => Promise.allSettled(CDN_FILES.map(u => c.match(u).then(hit => hit || c.add(u))))),
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== 'shell-' + VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API luôn đi mạng (dữ liệu mới nhất, có khoá thiết bị)
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  // Thư viện + mô hình (~8MB, phiên bản cố định): cache-first
  if (req.url.startsWith(CDN)) {
    e.respondWith(caches.open('cdn').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Giao diện: lấy bản mới khi có mạng, mất mạng thì dùng bản đã lưu
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open('shell-' + VERSION).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  }
});
