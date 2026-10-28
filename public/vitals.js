// Đo Core Web Vitals của người dùng thật (thư viện web-vitals của Google, bản attribution: kèm nguyên nhân)
// và gửi về server một lần khi rời trang. Server chỉ ghi log (Cloudflare Observability), không ghi KV.
// Xem số liệu: Workers → timesheet → Observability, lọc theo "web-vitals".
import { onCLS, onFCP, onINP, onLCP, onTTFB } from './vendor/web-vitals.attribution.js';

// fetchLater(): trình duyệt tự gửi khi rời trang (Chrome 135+). Trình duyệt khác dùng bản thay thế bên dưới
// (theo hướng dẫn của web.dev): gửi bằng fetch keepalive / sendBeacon khi trang bị ẩn.
globalThis.fetchLater ??= function fetchLater(url, init = {}) {
  let timeoutHandle;
  let activated = false;
  function sendNow() {
    if (!(init.signal && init.signal.aborted)) {
      if ('keepalive' in Request.prototype || init.method !== 'POST' || init.headers) {
        fetch(url, Object.assign({}, init, { keepalive: true }));
        activated = true;
      } else {
        activated = navigator.sendBeacon(url, init.body);
      }
    }
    destroy();
  }
  function destroy() {
    document.removeEventListener('visibilitychange', sendNow);
    clearTimeout(timeoutHandle);
  }
  if (document.visibilityState === 'hidden') {
    queueMicrotask(sendNow);
  } else {
    document.addEventListener('visibilitychange', sendNow);
    if (typeof init.activateAfter === 'number' && init.activateAfter >= 0) timeoutHandle = setTimeout(sendNow, init.activateAfter);
  }
  if (init.signal) init.signal.addEventListener('abort', destroy);
  return { get activated() { return activated; } };
};

const round = v => Math.round(v * 10) / 10;
const report = {
  id: crypto.randomUUID?.() || String(Math.random()).slice(2),
  device: matchMedia('(max-width:760px)').matches ? 'phone' : 'desktop',
  view: () => location.hash.slice(1) || 'kiosk',
  net: navigator.connection?.effectiveType,
  metrics: {},
};

// chỉ giữ phần nguyên nhân cần để sửa: phần tử, các giai đoạn, đoạn script lâu nhất
function attribution(m) {
  const a = m.attribution || {};
  if (m.name === 'LCP') return { target: a.target, url: a.url?.slice(0, 200), ttfb: round(a.timeToFirstByte), loadDelay: round(a.resourceLoadDelay), loadTime: round(a.resourceLoadDuration), renderDelay: round(a.elementRenderDelay) };
  if (m.name === 'CLS') return { target: a.largestShiftTarget, largest: a.largestShiftValue, at: round(a.largestShiftTime || 0) };
  if (m.name === 'INP') {
    const s = a.longestScript;
    return {
      target: a.interactionTarget, type: a.interactionType, inputDelay: round(a.inputDelay), processing: round(a.processingDuration), presentation: round(a.presentationDelay),
      script: s ? { url: s.entry?.sourceURL?.slice(0, 200), fn: s.entry?.sourceFunctionName, invoker: s.entry?.invokerType, subpart: s.subpart, ms: round(s.intersectingDuration) } : undefined,
      styleLayout: round(a.totalStyleAndLayoutDuration || 0),
    };
  }
  return undefined;
}

// mỗi lần có số đo mới: huỷ gói cũ, hẹn gửi gói mới có đủ mọi số đo (chỉ gửi một lần khi rời trang)
let pending = null;
function queue() {
  pending?.abort();
  pending = new AbortController();
  const body = JSON.stringify({ ...report, view: report.view(), metrics: report.metrics });
  try {
    fetchLater('/api/vitals', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: pending.signal });
  } catch {}   // hết hạn mức fetchLater (~64KB) hoặc trình duyệt chặn: bỏ qua, không ảnh hưởng app
}
function add(m) {
  report.metrics[m.name] = { value: m.name === 'CLS' ? Math.round(m.value * 1000) / 1000 : Math.round(m.value), rating: m.rating, nav: m.navigationType, ...attribution(m) };
  queue();
}
onTTFB(add); onFCP(add); onLCP(add); onCLS(add); onINP(add);
