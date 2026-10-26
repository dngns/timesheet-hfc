// Timesheet PWA — nhận diện khuôn mặt ngay trên thiết bị, gửi ảnh qua Worker tới Telegram
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/';
// Ngưỡng và các bước đăng ký nằm trong face-logic.js (dùng chung với bộ test)
const { CONFIG: FACE, ENROLL_STEPS, facePose, Verifier, Enroller, findDuplicate, checkUpload } = FaceLogic;
const MAX_SAMPLES = ENROLL_STEPS.length;
const { SORTS, DEFAULT_SORT, sortRows } = ReportSort;   // sắp xếp Bảng công (sort.js)
const { SHIFTS, suggestShift, shiftLabel, shiftDateFor, isMissed, isShiftOpen, opensAt } = Shifts;     // ca làm việc (shifts.js)
const { retryDelay, isRetryable, describeError } = Retry;                        // gửi lại lượt chờ (retry.js)
const { ovalFor, fitHint, HINTS } = Guide;                                       // nhắc lại gần / lùi xa (guide.js)
const shiftOf = l => SHIFTS[l?.shift] ? l.shift : 'sang'; // lượt cũ (trước khi có ca) tính là ca sáng
const dmyhm = ts => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// Vị trí lưu trong bảng công: "lat,lng,sai số" (GPS) hoặc "net:Thành phố, Quốc gia" (theo mạng)
function locParts(loc) {
  if (!loc) return null;
  if (loc.startsWith('net:')) return { net: loc.slice(4) };
  const [lat, lng, acc] = loc.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, acc } : null;
}
function locHtml(loc) {
  const p = locParts(loc);
  if (!p) return '';
  if (p.net) return `theo mạng: ${esc(p.net)}`;
  return `<a href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" rel="noopener">xem bản đồ</a>${Number.isFinite(p.acc) ? ` (±${p.acc} m)` : ''}`;
}
const locText = loc => { const p = locParts(loc); return !p ? '' : p.net ? 'theo mạng: ' + p.net : `${p.lat},${p.lng}`; };

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hms = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dmy = s => s.split('-').reverse().join('/');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// so khớp không phân biệt dấu: "bich" tìm ra "Bích", "duc" tìm ra "Đức"
const fold = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
const weekday = s => new Date(s + 'T00:00:00').toLocaleDateString('vi-VN', { weekday: 'long' });
const dur = ms => { const m = Math.floor(ms / 60000); return m < 60 ? `${m} phút` : `${Math.floor(m / 60)} giờ${m % 60 ? ' ' + (m % 60) + ' phút' : ''}`; };
const t5 = l => (l.time || hms(new Date(l.ts))).slice(0, 5);
const wrapStore = s => ({
  get(k) { try { return s().getItem(k); } catch { return null; } },
  set(k, v) { try { s().setItem(k, v); } catch {} },
  del(k) { try { s().removeItem(k); } catch {} },
});
const store = wrapStore(() => localStorage);

// ---------------- Thông báo ----------------
function toast(msg, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span></span><button class="t-x" aria-label="Đóng">×</button>`;
  el.firstChild.textContent = msg;
  const close = () => el.remove();
  el.querySelector('.t-x').onclick = close;
  $('toasts').append(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(close, ms);
}

let audioCtx;
function beep(ok) {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.12, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (ok ? 0.18 : 0.35));
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.4);
  } catch {}
  navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
}

// ---------------- Đồng hồ & mạng ----------------
function tick() {
  const d = new Date();
  $('clockTime').innerHTML = `${pad(d.getHours())}:${pad(d.getMinutes())}<span class="sec">:${pad(d.getSeconds())}</span>`;
  const date = d.toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if ($('clockDate').textContent !== date) $('clockDate').textContent = date[0].toUpperCase() + date.slice(1);
}
setInterval(tick, 1000); tick();
function updateNet() {
  const on = navigator.onLine;
  $('netChip').classList.toggle('off', !on);
  $('netChip').lastChild.textContent = on ? 'Trực tuyến' : 'Mất mạng';
}
addEventListener('online', () => { updateNet(); flushQueue(true); });   // có mạng lại: thử ngay, không chờ giờ hẹn
addEventListener('offline', updateNet);
updateNet();

// ---------------- API ----------------
// Lỗi từ server: { error, code, status, requestId } (xem errorResponse trong src/worker.js)
class HttpError extends Error { constructor(status, msg, code, requestId) { super(msg); Object.assign(this, { status, code, requestId }); } }
const statusOf = e => e instanceof HttpError ? e.status : 0;   // 0 = không tới được server (mất mạng)
class QueuedBehind extends Error {}   // còn lượt cũ chưa gửi được: lượt mới phải xếp hàng sau để giữ thứ tự vào/ra
// Khoá nút trong lúc gửi để bấm nhiều lần không gửi nhiều lần
async function busy(btn, fn, label = 'Đang gửi…') {
  if (btn.disabled) return;
  const html = btn.innerHTML;
  btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
}
// opts.as: ký bằng máy của người khác trên cùng máy (lượt chờ gửi của người đã đăng xuất); opts.unsigned: không ký
async function api(path, opts = {}, retried = false) {
  const dev = opts.unsigned ? null : await getDevice(opts.as || store.get('ts.account'));
  const headers = { ...(dev ? await signHeaders(dev, opts.method || 'GET', path) : {}), ...(opts.headers || {}) };
  const r = await fetch(path, { ...opts, headers });
  if (!r.ok) {
    let body = {};
    try { body = await r.json(); } catch {}
    // đồng hồ máy lệch quá 5 phút: lấy giờ server, ký lại và gửi lại một lần
    if (body.code === 'SIGNATURE_EXPIRED' && body.serverTime && !retried) { clockSkew = body.serverTime - Date.now(); return api(path, opts, true); }
    const msg = body.error || r.statusText, requestId = body.requestId || r.headers.get('X-Request-Id');
    if (r.status === 401 && dev && !opts.keepSession) signOut(msg);   // máy bị thu hồi, mã bị đổi hoặc tài khoản bị xoá
    // lỗi máy chủ: kèm mã tra cứu vào câu báo để người dùng gửi cho quản trị viên
    throw new HttpError(r.status, r.status >= 500 && requestId ? `${msg} (mã tra cứu: ${requestId})` : msg, body.code, requestId);
  }
  return r.headers.get('Content-Type')?.includes('json') ? r.json() : r;
}

// ---------------- Hàng đợi offline (IndexedDB) ----------------
let qdb;
function openQueue() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('timesheet-queue', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'ts' });
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'code' });   // khoá đăng nhập của máy
    };
    r.onsuccess = () => res(qdb = r.result);
    r.onerror = () => rej(r.error);
  });
}
function qtx(mode, fn, storeName = 'queue') {
  return new Promise((res, rej) => {
    const t = qdb.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}
const queueAll = () => qtx('readonly', s => s.getAll());

// ---------------- Đăng nhập theo máy ----------------
// Mã kích hoạt chỉ gửi một lần lúc kích hoạt, không lưu trên máy (trước đây nằm trong localStorage và header mọi request,
// mở F12 là thấy). Máy tạo cặp khoá ECDSA; khoá bí mật lưu trong IndexedDB ở dạng không xuất ra được, chỉ dùng để ký
// từng request (X-Device, X-Timestamp, X-Signature; xem verifyDevice trong src/worker.js). Chép từ F12 sang máy khác
// không dùng được. Một máy giữ được khoá của nhiều người (lượt chờ gửi của người đã đăng xuất vẫn gửi đúng tên).
const ROOT_ACCOUNT = '#root';   // tài khoản quản trị gốc (ADMIN_KEY)
let clockSkew = 0;              // giờ server − giờ máy (ms), chỉnh khi server báo SIGNATURE_EXPIRED
const getDevice = code => qdb && code ? qtx('readonly', s => s.get(code), 'keys') : null;
const delDevice = code => qdb ? qtx('readwrite', s => s.delete(code), 'keys') : null;
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function signHeaders(dev, method, path) {
  const u = new URL(path, location.origin), ts = Date.now() + clockSkew;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.key, new TextEncoder().encode(`${ts}.${method}.${u.pathname}${u.search}`));
  return { 'X-Device': dev.id, 'X-Timestamp': String(ts), 'X-Signature': b64(sig) };
}
// Kích hoạt máy bằng mã: trả về tài khoản (mã NV hoặc ROOT_ACCOUNT) và thông tin người dùng
async function activateDevice(accessCode, borrowed = false) {
  if (!window.crypto?.subtle || !qdb) throw new Error('Trình duyệt này không hỗ trợ đăng nhập an toàn. Mở app qua https bằng Chrome, Safari hoặc Brave bản mới.');
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pub = b64(await crypto.subtle.exportKey('raw', kp.publicKey));
  const data = await api('/api/devices', { method: 'POST', unsigned: true, keepSession: true,
    headers: { 'X-Access-Code': accessCode, 'Content-Type': 'application/json' }, body: JSON.stringify({ pub, borrowed }) });
  const account = data.me.root ? ROOT_ACCOUNT : data.me.code;
  await qtx('readwrite', s => s.put({ code: account, id: data.deviceId, key: kp.privateKey, borrowed }), 'keys');
  return { me: data.me, account };
}
// Bỏ khoá của một người trên máy; revoke: báo server thu hồi máy này (đăng xuất chủ động)
async function forgetDevice(account, revoke) {
  if (revoke) { try { await api('/api/devices', { method: 'DELETE', as: account, keepSession: true }); } catch {} }
  await delDevice(account);
}

// Mỗi lượt ký bằng khoá của chính người chấm (item.account, lưu kèm khi chụp),
// để đổi người đăng nhập trên máy không làm lượt chờ gửi bị ghi công cho người khác.
async function sendPunch(item) {
  const fd = new FormData();
  fd.append('code', item.code);
  fd.append('type', item.type);
  fd.append('ts', item.ts);
  if (item.shift) fd.append('shift', item.shift);
  if (item.geo) { fd.append('lat', item.geo.lat); fd.append('lng', item.geo.lng); fd.append('acc', item.geo.acc); }
  fd.append('photo', item.blob, 'photo.jpg');
  const account = item.account || item.code;
  if (!(await getDevice(account))) throw new HttpError(401, 'người này đã đăng xuất khỏi máy');
  // lượt của người khác (đã đăng xuất) bị từ chối thì không được đăng xuất người đang dùng máy
  const res = await api('/api/punch', { method: 'POST', body: fd, as: account, keepSession: account !== store.get('ts.account') });
  // máy mượn: server đã đăng xuất máy sau lượt chấm này
  if (res.signedOut) {
    await delDevice(account);
    if (account === store.get('ts.account')) setTimeout(() => signOut('Máy mượn: đã tự đăng xuất sau khi chấm công.'), 4000);
  }
  return res;
}

let flushing = false;
async function flushQueue(force) {
  if (flushing || !qdb) return;
  flushing = true;
  let sent = 0;
  try {
    for (const item of (await queueAll()).sort((a, b) => a.ts - b.ts)) {
      // giữ đúng thứ tự vào/ra: lượt trước chưa tới giờ thử lại thì các lượt sau cũng chờ
      if (!force && item.nextAt > Date.now()) break;
      try {
        await sendPunch(item); sent++;
      } catch (e) {
        if (isRetryable(statusOf(e))) {
          // mất mạng, server lỗi, bị giới hạn: giữ lượt, thử lại giãn dần (30 giây, 1, 2, 4… tối đa 15 phút)
          const tries = (item.tries || 0) + 1;
          await qtx('readwrite', s => s.put({ ...item, tries, nextAt: Date.now() + retryDelay(tries), lastError: describeError(statusOf(e), e.message) }));
          break;
        }
        toast(`Bỏ lượt chấm công chờ gửi của ${item.name}: ${e.message}`, 'warn', 6000);
      }
      await qtx('readwrite', s => s.delete(item.ts));
      // người đã đăng xuất mà máy giữ khoá chỉ để gửi nốt lượt chờ: gửi xong lượt cuối thì thu hồi máy và xoá khoá
      const account = item.account || item.code;
      if (account !== store.get('ts.account') && !(await queueAll()).some(q => (q.account || q.code) === account)) await forgetDevice(account, true);
    }
  } finally {
    flushing = false;
    // chỉ làm mới khi đã gửi được: vòng 30 giây này chạy cả khi hàng đợi trống và tab bị ẩn (mỗi lần tải bảng công tốn lệnh list KV)
    if (sent) { toast(`Đã gửi ${sent} lượt chấm công lên Telegram`, 'ok'); await loadToday({ force: true }); }
    else await renderQueue();
  }
}
setInterval(flushQueue, 30000);

// ---------------- Người đăng nhập & bộ so khớp khuôn mặt ----------------
// role: 1 = quản trị, 2 = nhân viên. Máy chỉ xác minh khuôn mặt của chính người đã kích hoạt.
const ROLE_ADMIN = 1;
let me = JSON.parse(store.get('ts.me') || 'null');
let employees = [];   // chỉ quản trị mới tải
let verifier = new Verifier([]);   // chỉ so với mẫu của người đã kích hoạt máy
const isAdmin = () => me?.role === ROLE_ADMIN;
const canPunch = () => !!me && !me.root && !!me.descriptors?.length;

function buildMatcher() {
  if (!window.faceapi) return;
  verifier = new Verifier(canPunch() ? me.descriptors.map(d => new Float32Array(d)) : []);
}
async function loadMe() {
  try {
    me = await api('/api/me');
    store.set('ts.me', JSON.stringify(me));
  } catch (e) {
    if (e.status === 401) return;
  }
  applyRole();
}
function applyRole() {
  document.body.classList.toggle('solo', !isAdmin());   // nhân viên chỉ có màn chấm công: điện thoại ẩn thanh điều hướng
  document.querySelectorAll('[data-admin]').forEach(el => el.hidden = !isAdmin());
  $('whoChip').hidden = $('btnLogout').hidden = !me;
  $('whoChip').textContent = me ? me.name + (isAdmin() ? ' (quản trị)' : '') : '';
  if (isAdmin() && pendingView) { const v = pendingView; pendingView = null; showView(v); }
  if (!isAdmin() && view !== 'kiosk') showView('kiosk');
  // đổi người đăng nhập thì phải xác minh khuôn mặt lại từ đầu
  if (current && current.code !== me?.code) {
    current = null; verifier.reset(); faceState = 'search'; cooldown = null;
    if (cameraReady && !enroll.open) setPill('search', 'Đang tìm khuôn mặt');
  }
  buildMatcher();
  if (me && !me.root) startGeo(); else stopGeo();
  renderShift(); renderPerson(); updatePunch();
  if (isAdmin()) loadEmployees();
}
async function loadEmployees() {
  if (!isAdmin()) return;
  try { employees = await api('/api/employees'); } catch (e) { toast(e.message, 'err'); }
  renderEmployees();
  renderToday();
}
// revoke: đăng xuất chủ động (báo server thu hồi máy). Còn lượt chờ gửi của người này thì giữ khoá để gửi nốt.
async function signOut(msg, { revoke = false } = {}) {
  const account = store.get('ts.account');
  store.del('ts.account'); store.del('ts.me'); store.del('ts.accessCode');
  if (account && !(qdb && (await queueAll()).some(q => (q.account || q.code) === account))) forgetDevice(account, revoke);
  me = null; employees = []; todayLogs = []; todayAt = 0; historyCache.clear(); historyKey = ''; verifier = new Verifier([]); openShift = null; lastShift = null; localPunch = null; chosenByUser = false;
  stopGeo();
  applyRole();
  openOnboarding(msg);
}
$('btnLogout').onclick = () => {
  if (confirm('Đăng xuất khỏi máy này? Lần sau cần nhập lại mã kích hoạt.')) signOut(undefined, { revoke: true });
};

function initials(name) {
  // chỉ lấy các từ bắt đầu bằng chữ cái, bỏ "(QA)", "-", số…
  const w = String(name).trim().split(/\s+/).filter(x => /^\p{L}/u.test(x));
  if (!w.length) return '?';
  return (w.length > 1 ? w[w.length - 2][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
}
// Ảnh đại diện lưu trên server (đã thu nhỏ ~8KB); chưa có thì hiện chữ viết tắt
const avatarUrls = new Map();   // mã NV -> URL ảnh | 'loading' | 'none'
async function loadAvatar(code) {
  avatarUrls.set(code, 'loading');
  try {
    const r = await api('/api/avatar?code=' + encodeURIComponent(code), { keepSession: true });
    avatarUrls.set(code, URL.createObjectURL(await r.blob()));
    renderPerson();
    if (isAdmin()) { renderEmployees(); renderToday(); }
  } catch { avatarUrls.set(code, 'none'); }
}
function forgetAvatar(code) {
  const u = avatarUrls.get(code);
  if (u?.startsWith('blob:')) URL.revokeObjectURL(u);
  avatarUrls.delete(code);
}
function avatar(emp, sm) {
  if (emp.hasAvatar) {
    if (!avatarUrls.has(emp.code)) loadAvatar(emp.code);
    const u = avatarUrls.get(emp.code);
    if (u?.startsWith('blob:')) return `<div class="avatar${sm ? ' sm' : ''}" aria-hidden="true"><img src="${u}" alt=""></div>`;
  }
  let h = 0;
  for (const c of String(emp.code)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = Math.round((h * 137.508) % 360);   // góc vàng: mã gần nhau vẫn ra màu khác hẳn
  return `<div class="avatar${sm ? ' sm' : ''}" style="background:hsl(${hue} 34% 40%)" aria-hidden="true">${esc(initials(emp.name || emp.code))}</div>`;
}
const emptyAvatar = '<div class="avatar blank" aria-hidden="true"><svg><use href="#i-user"/></svg></div>';

// ---------------- Camera & nhận diện ----------------
const video = $('video'), overlay = $('overlay'), stage = $('stage');
let modelsReady = false, cameraReady = false;
let current = null, currentDist = 1;   // nhân viên đang đứng trước camera
let lastDetection = null;              // kết quả gần nhất (dùng khi đăng ký mẫu)
let lastSeen = 0;
let faceState = 'search';              // search | unknown | ok

function stageMsg({ spin = false, icon = false, title, text, retry } = {}) {
  const m = $('stageMsg');
  if (!title) { m.hidden = true; return; }
  m.hidden = false;
  $('stageSpin').hidden = !spin;
  $('stageIcon').hidden = !icon;
  $('stageMsgTitle').textContent = title;
  $('stageMsgText').textContent = text || '';
  $('btnRetryCam').hidden = !retry;
  $('btnRetryCam').textContent = retry?.label || '';
  $('btnRetryCam').onclick = retry?.run || null;
}
const pill = { state: 'loading', text: '' };
let fit = null;   // lời nhắc vị trí mặt: 'near' | 'far' | 'center' (updateFit)
function setPill(state, text) {
  Object.assign(pill, { state, text });
  stage.dataset.state = state;
  // chưa xác minh xong mà mặt chưa vừa oval: lời nhắc vị trí quan trọng hơn
  $('pillText').textContent = fit && state !== 'ok' && !enroll.open ? HINTS[fit] : text;
}

async function openStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (e) {
    // một số webcam không nhận yêu cầu cụ thể: thử lại với yêu cầu tối thiểu
    if (e.name === 'OverconstrainedError' || e.name === 'NotReadableError' || e.name === 'AbortError') {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    throw e;
  }
}

// Giải thích lỗi camera theo nguyên nhân thật, kèm mã lỗi gốc để báo lại khi cần
async function cameraErrorText(e) {
  let perm = '';
  try { perm = (await navigator.permissions.query({ name: 'camera' })).state; } catch {}
  const mac = /Mac/.test(navigator.platform);
  const systemBlocked = e.name === 'NotAllowedError' && (/system/i.test(e.message) || perm === 'granted');
  const text = systemBlocked
    ? (mac ? 'Trang đã được cho phép nhưng macOS đang chặn camera của trình duyệt. Mở Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Camera, bật trình duyệt này, khởi động lại trình duyệt rồi bấm Mở lại camera.'
           : 'Trang đã được cho phép nhưng hệ điều hành đang chặn camera của trình duyệt. Bật quyền camera cho trình duyệt trong cài đặt máy, rồi bấm Mở lại camera.')
    : {
      NotAllowedError: 'Trình duyệt đang chặn camera cho trang này. Bấm biểu tượng ổ khoá hoặc camera ở thanh địa chỉ, chọn Cho phép, rồi bấm Mở lại camera.',
      NotFoundError: 'Không tìm thấy camera. Kiểm tra camera đã cắm hoặc đã bật chưa.',
      NotReadableError: 'Camera đang bị ứng dụng hoặc tab khác dùng (Zoom, Meet, FaceTime…). Đóng ứng dụng đó rồi bấm Mở lại camera.',
      OverconstrainedError: 'Camera không hỗ trợ chế độ yêu cầu. Bấm Mở lại camera để thử lại.',
      SecurityError: 'Trình duyệt không cho dùng camera ở trang này. Mở trang qua https.',
      Insecure: 'Camera chỉ hoạt động khi mở trang qua https hoặc localhost.',
    }[e.name] || 'Lỗi không xác định khi mở camera.';
  return `${text}\nMã lỗi: ${e.name}${e.message ? ' (' + e.message + ')' : ''}${perm ? ', quyền trang: ' + perm : ''}`;
}

async function startCamera() {
  stageMsg({ spin: true, title: 'Đang mở camera', text: 'Nếu trình duyệt hỏi, hãy bấm Cho phép.' });
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'Insecure' });
    video.srcObject = await openStream();
    await new Promise(r => video.readyState >= 1 ? r() : (video.onloadedmetadata = r));
    await video.play().catch(() => {});
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    cameraReady = true;
    stageMsg();
    setPill('search', 'Đang tìm khuôn mặt');
  } catch (e) {
    cameraReady = false;
    console.error('Camera:', e);
    stageMsg({ icon: true, title: 'Không mở được camera', text: await cameraErrorText(e), retry: { label: 'Mở lại camera', run: startCamera } });
    setPill('loading', 'Camera chưa sẵn sàng');
  }
  updatePunch();
}

async function loadModels() {
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsReady = true;
  buildMatcher();
}

const detectorOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });

// Quản trị viên thấy độ lệch thực tế để chỉnh MATCH_THRESHOLD (face-logic.js) theo khuôn mặt thật
function showDebug(text) {
  const el = $('dbg');
  el.hidden = !isAdmin() || !text;
  el.textContent = text || '';
}

function verifyFrame(det) {
  const now = Date.now(), pose = facePose(det.landmarks.positions);
  const r = verifier.frame({ descriptor: det.descriptor, pose }, now);
  if (r.state === 'no-samples') return;
  showDebug(`Độ lệch ${r.dist.toFixed(2)}, ngưỡng ${FACE.MATCH_THRESHOLD}, góc quay ${pose.yaw.toFixed(2)}`);
  if (r.state === 'turned') { setCurrent(null, 1, false); setPill('search', 'Nhìn thẳng vào camera'); return; }
  if (r.state === 'unknown') return setCurrent(null, r.dist, true);
  if (r.state === 'live-check') return setLiveCheck();
  if (verifier.isFresh(now)) return setCurrent(me, r.dist, true);
  setCurrent(null, 1, false);
  setPill('search', 'Đang xác minh, giữ yên');
}

async function detectLoop() {
  try {
    if (modelsReady && cameraReady && video.readyState >= 2 && !document.hidden) {
      const det = await faceapi.detectSingleFace(video, detectorOpts()).withFaceLandmarks().withFaceDescriptor();
      lastDetection = det || null;
      updateFit(det);
      const g = overlay.getContext('2d');
      g.clearRect(0, 0, overlay.width, overlay.height);
      if (enroll.open) {
        const count = enroller.active ? (await faceapi.detectAllFaces(video, detectorOpts())).length : 1;
        enrollStep(det, count);
      } else if (det) {
        lastSeen = Date.now();
        verifyFrame(det);
      } else {
        // 1 khung mất mặt có thể là nhiễu; mất liền 2 khung thì khoá chấm công ngay
        verifier.miss();
        if (!verifier.isFresh(Date.now())) { showDebug(); setCurrent(null, 1, false); }
      }
    }
  } catch (e) { console.error(e); }
  setTimeout(detectLoop, 220);
}

// Mặt to / nhỏ / lệch so với oval hướng dẫn: nhắc ngay trên khung camera. Đã xác minh hoặc đang đăng ký thì không nhắc.
function updateFit(det) {
  let next = null;
  if (det && !enroll.open) {
    const r = stage.getBoundingClientRect(), o = stage.querySelector('.guide .oval').getBoundingClientRect();
    const head = ovalFor(det.detection.box, { w: video.videoWidth, h: video.videoHeight }, { w: r.width, h: r.height });
    next = fitHint(head, { cx: o.left - r.left + o.width / 2, cy: o.top - r.top + o.height / 2, w: o.width });
  }
  if (next === fit) return;
  fit = next;
  setPill(pill.state, pill.text);
}

// Đã nhận ra mặt nhưng chưa thấy cử động: nhắc quay nhẹ đầu (chặn ảnh/màn hình giơ trước camera)
function setLiveCheck() {
  setPill('ok', 'Quay nhẹ đầu sang một bên');
  if (faceState === 'live' && !current) return;
  current = null; faceState = 'live';
  renderPerson(); updatePunch();
}

function setCurrent(emp, dist, seen) {
  const state = emp ? 'ok' : seen ? 'unknown' : 'search';
  if (emp === current && state === faceState) { currentDist = dist ?? currentDist; return; }
  current = emp || null; currentDist = dist ?? 1; faceState = state;
  setPill(state, emp ? `Đã xác minh ${emp.name}` : seen ? 'Khuôn mặt không khớp' : 'Đang tìm khuôn mặt');
  renderPerson();
  updatePunch();
}

function renderPerson() {
  const p = $('person');
  if (!me) { p.innerHTML = ''; return; }
  const head = (av, title, meta) => { p.innerHTML = `${av}<div><div class="p-name">${title}</div><div class="p-meta">${meta}</div></div>`; };
  if (me.root) return head(emptyAvatar, 'Tài khoản quản trị gốc', 'Tài khoản này chỉ dùng để quản lý, không chấm công. Muốn chấm công, đăng nhập bằng mã của nhân viên.');
  if (!me.descriptors?.length) return head(avatar(me), esc(me.name), 'Tài khoản chưa có khuôn mặt. Nhờ quản trị viên đăng ký khuôn mặt cho bạn.');
  if (current) return head(avatar(me), esc(me.name), `Đã xác minh khuôn mặt`);
  // lời nhắc quay đầu đã hiện ngay trên khung camera (nơi người dùng đang nhìn), ở đây không lặp lại
  if (faceState === 'live') return head(avatar(me), esc(me.name), 'Đã nhận ra bạn, còn bước xác nhận người thật.');
  if (faceState === 'unknown') return head(avatar(me), esc(me.name), `Khuôn mặt trước camera không khớp với ${esc(me.name)}. Nhìn thẳng vào camera, đủ ánh sáng.`);
  head(avatar(me), esc(me.name), 'Nhìn vào camera để xác minh khuôn mặt.');
}

// Chụp khung hình (không lật) và in thông tin lên ảnh
function captureBlob(label, when) {
  const w = video.videoWidth, h = video.videoHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.translate(w, 0); g.scale(-1, 1); g.drawImage(video, 0, 0, w, h);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, h - 56, w, 56);
  g.fillStyle = '#fff'; g.font = 'bold 18px system-ui, sans-serif';
  g.fillText(label, 12, h - 31);
  g.font = '15px system-ui, sans-serif';
  g.fillText(`${dmyhm(when)}${geoFresh() ? `   ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}` : ''}`, 12, h - 11);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
}

// ---------------- Ca làm việc và vị trí ----------------
let openShift = null;       // ca đang mở theo server: { shift, shiftDate, ts, time, outs, lastOut }
let lastShift = null;       // ca đã check-in gần nhất (kể cả đã đóng): { shift, shiftDate }
let chosenShift = null;     // ca chọn cho lần check-in tới
let chosenByUser = false;   // người dùng tự chọn thì không gợi ý đè lên
const OUTS_MAX = 3;          // mỗi ca: check-in 1 lần, check-out tối đa 3 lần (giống server)
let localPunch = null;      // lượt vừa chấm trên máy này: { ts, at, open }, dùng khi server chưa kịp cập nhật
const serverAt = o => o ? Math.max(o.ts, o.lastOut || 0) : 0;
let switchShift = false;    // đã check-out rồi, người dùng chọn "Vào ca khác" thay vì check-out tăng ca
// Việc tiếp theo: chưa vào ca thì Check-in; đã vào chưa ra thì Check-out; đã ra thì Check-out tăng ca (hoặc vào ca khác)
const nextAction = open => !open ? 'in' : open.outs && switchShift ? 'in' : 'out';
// Ca đang mở: theo server; nếu vừa chấm trên máy (trong 2 phút) mà server chưa thấy thì theo máy;
// cộng các lượt đang chờ gửi khi mất mạng. Đang mở thì nút luôn là Check-out.
function currentOpen() {
  let open = openShift;
  if (localPunch && Date.now() - localPunch.at < 120000 && localPunch.ts > serverAt(openShift)) open = localPunch.open;
  for (const p of pending.filter(p => p.code === me?.code).sort((a, b) => a.ts - b.ts)) {
    if (p.type === 'in') open = { shift: p.shift, ts: p.ts, time: p.time, outs: 0, lastOut: null, queued: true };
    else if (open) {
      const outs = (open.outs || 0) + 1;
      open = outs >= OUTS_MAX ? null : { ...open, outs, lastOut: p.ts };
    }
  }
  return open;
}
function renderShift() {
  const show = !!me && !me.root;
  const open = show && currentOpen();
  if (!open?.outs) switchShift = false;
  const act = nextAction(open);
  $('shiftPick').hidden = !show || act !== 'in';
  $('shiftNow').hidden = !open;
  if (!show) return;
  if (open) {
    const s = SHIFTS[shiftOf(open)];
    $('shiftNow').innerHTML = !open.outs
      ? esc(`Đang trong ${s.name} ${s.start}–${s.end}, vào lúc ${dmyhm(open.ts)}.`)
      : esc(`Đã check-out ${s.name} lúc ${dmyhm(open.lastOut).slice(11)}${open.outs > 1 ? ` (lần ${open.outs}/${OUTS_MAX})` : ''}. Nếu còn làm tăng ca, check-out lại khi về. `)
        + `<button type="button" class="link" id="btnSwitchShift">${switchShift ? 'Quay lại check-out tăng ca' : 'Vào ca khác'}</button>`;
    if (act === 'out') return;
  }
  // ca đã check-in trong ngày công tương ứng thì không check-in lại (mỗi ca chỉ 1 lần)
  const now = new Date(), used = k => lastShift?.shift === k && lastShift.shiftDate === shiftDateFor(k, ymd(now), now.getHours());
  // ca chỉ mở check-in từ 2 giờ trước giờ vào tới hết ca (shifts.js); ngoài khung thì khoá, ghi giờ mở
  const closed = k => !isShiftOpen(k, now.getHours() * 60 + now.getMinutes());
  const off = k => used(k) || closed(k);
  if (off(chosenShift)) chosenByUser = false;
  if (!chosenByUser || !SHIFTS[chosenShift]) {
    const sug = suggestShift(now.getHours(), me.shift);
    chosenShift = !off(sug) ? sug : Object.keys(SHIFTS).find(k => !off(k)) || null;
  }
  $('shiftOpts').innerHTML = Object.entries(SHIFTS).map(([k, s]) =>
    `<button type="button" role="radio" aria-checked="${k === chosenShift}" data-shift="${k}" ${off(k) ? 'disabled' : ''}><b>${s.name}</b><span>${used(k) ? 'Đã chấm ca này' : closed(k) ? `Mở lúc ${opensAt(k)}` : `${s.start}–${s.end}`}</span></button>`).join('');
}
$('shiftNow').onclick = e => {
  if (e.target.id !== 'btnSwitchShift') return;
  switchShift = !switchShift;
  renderShift(); updatePunch();
};
$('shiftOpts').onclick = e => {
  const b = e.target.closest('[data-shift]'); if (!b) return;
  chosenShift = b.dataset.shift; chosenByUser = true;
  renderShift(); updatePunch();
};

// Vị trí GPS: theo dõi liên tục khi app mở, chấm công dùng vị trí mới nhất (không bắt chờ GPS lúc bấm)
let geo = null, geoState = 'idle', geoWatch = null;
const geoFresh = () => !!geo && Date.now() - geo.at < 2 * 60000;
function startGeo() {
  if (geoWatch !== null || !me || me.root) return renderGeo();
  if (!navigator.geolocation) { geoState = 'unavailable'; return renderGeo(); }
  geoState = 'waiting';
  geoWatch = navigator.geolocation.watchPosition(
    p => { geo = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now() }; geoState = 'ok'; renderGeo(); },
    e => { geoState = e.code === 1 ? 'denied' : 'unavailable'; renderGeo(); },
    { enableHighAccuracy: true, maximumAge: 60000, timeout: 30000 });
  renderGeo();
}
function stopGeo() {
  if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch);
  geoWatch = null; geo = null; geoState = 'idle';
}
function renderGeo() {
  const el = $('geoInfo');
  el.hidden = !me || me.root;
  if (el.hidden) return;
  const ok = geoState === 'ok' && geoFresh();
  el.classList.toggle('warn', geoState === 'denied' || geoState === 'unavailable');
  el.lastChild.textContent = ok ? `Đã xác định vị trí, sai số khoảng ${geo.acc} m`
    : geoState === 'denied' ? 'Chưa cho phép lấy vị trí. Lượt chấm công sẽ dùng vị trí ước lượng theo mạng; bật quyền vị trí cho trang để chính xác hơn.'
    : geoState === 'unavailable' ? 'Máy không lấy được vị trí GPS. Lượt chấm công sẽ dùng vị trí ước lượng theo mạng.'
    : 'Đang lấy vị trí…';
}

// ---------------- Check-in / out ----------------
let todayLogs = [];
let pending = [];
// Bảng công hôm nay vừa tải trong 60 giây thì chuyển tab qua lại không tải lại (mỗi lần tốn 1–2 lệnh list KV)
const TODAY_FRESH_MS = 60 * 1000;
let todayAt = 0;
async function loadToday(opts) {
  const force = opts?.force === true;   // sau khi chấm công / gửi được lượt chờ / bấm Thử lại
  // quản trị: bảng công hôm nay và hôm qua (ca tối đang làm qua nửa đêm); nhân viên: chỉ cần ca đang mở
  const errs = [];
  // Bảng công "Hôm nay" chỉ tải khi đang mở (mỗi lần tốn 1–2 lệnh list KV).
  // Ngày hôm qua chỉ cần trước 12:00, lúc ca tối hôm qua còn mở.
  if (isAdmin() && todayOpen()) {
    if (force || Date.now() - todayAt > TODAY_FRESH_MS) {
      const now = new Date(), from = now.getHours() < 12 ? ymd(addDays(now, -1)) : ymd(now);
      try { todayLogs = await api(`/api/logs?from=${from}&to=${ymd(now)}`); todayAt = Date.now(); }
      catch (e) { errs.push('bảng công hôm nay: ' + describeError(statusOf(e), e.message)); }
    }
  }
  if (me && !me.root) {
    try { ({ open: openShift, last: lastShift } = await api('/api/status')); }
    catch (e) { errs.push('trạng thái ca: ' + describeError(statusOf(e), e.message)); }
  }
  showSyncWarn(errs);
  await renderQueue();
  renderShift();
  renderToday(); updatePunch();
}
const todayOpen = () => view === 'report' && !$('r-today').hidden;
// Không tải được dữ liệu từ server thì nói rõ, vì nút Check-in/Check-out có thể chưa đúng
function showSyncWarn(errs) {
  $('syncWarn').hidden = !errs.length;
  $('syncWarn').firstChild.textContent = errs.length ? `Chưa cập nhật được ${errs.join('; ')}. Nút chấm công có thể chưa đúng. ` : '';
}
$('btnSyncRetry').onclick = () => busy($('btnSyncRetry'), () => loadToday({ force: true }), 'Đang tải…');
// Ô "lượt chờ gửi": số lượt, lý do lần gửi trước lỗi và giờ thử lại
async function renderQueue() {
  pending = qdb ? await queueAll() : [];
  const chip = $('queueChip'), first = [...pending].sort((a, b) => a.ts - b.ts)[0];
  chip.hidden = !pending.length;
  chip.textContent = `${pending.length} lượt chờ gửi` + (first?.lastError ? ` · ${first.lastError}, thử lại lúc ${hms(new Date(first.nextAt)).slice(0, 5)}` : '');
  chip.title = chip.textContent;
}
// tự làm mới 5 phút/lần khi app đang mở trên màn hình, và ngay khi quay lại app (đỡ tốn lượt đọc của gói miễn phí)
setInterval(() => { if (document.visibilityState === 'visible') loadToday(); }, 5 * 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && me) loadToday(); });

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayAll = () => [...todayLogs, ...pending.map(p => ({ ...p, queued: true }))].sort((a, b) => a.ts - b.ts);

let cooldown = null;   // { code, until } — chặn bấm lặp ngay sau khi chấm
function updatePunch() {
  const btn = $('btnPunch'), label = $('punchLabel'), sub = $('punchSub');
  btn.classList.remove('out');
  if (current && cooldown?.code === current.code && Date.now() < cooldown.until) {
    btn.disabled = true; label.textContent = 'Đã chấm công'; sub.textContent = 'Hẹn gặp lại';
    return;
  }
  const open = currentOpen(), act = nextAction(open);
  const outLabel = open?.outs ? `Check-out tăng ca (lần ${open.outs + 1}/${OUTS_MAX})` : 'Check-out';
  if (!current) {
    btn.disabled = true; label.textContent = act === 'out' ? outLabel : 'Check-in';
    sub.textContent = !me ? 'Cần kích hoạt app' : me.root ? 'Tài khoản quản trị gốc không chấm công'
      : !canPunch() ? 'Chưa đăng ký khuôn mặt' : !modelsReady || !cameraReady ? 'Camera chưa sẵn sàng'
      : faceState === 'live' ? 'Quay nhẹ đầu sang một bên' : faceState === 'unknown' ? 'Khuôn mặt không khớp' : 'Nhìn vào camera để xác minh';
    return;
  }
  btn.disabled = punching;
  if (act === 'out') {
    btn.classList.add('out');
    label.textContent = outLabel;
    sub.textContent = open.outs
      ? `${SHIFTS[shiftOf(open)].name}, đã check-out lúc ${dmyhm(open.lastOut).slice(11)}`
      : `${SHIFTS[shiftOf(open)].name}, vào lúc ${t5(open)}, đã làm ${dur(Date.now() - open.ts)}`;
  } else {
    label.textContent = 'Check-in';
    if (!SHIFTS[chosenShift]) {
      // chưa tới giờ check-in ca nào: nói rõ ca nào mở lúc mấy giờ
      const next = Object.keys(SHIFTS).filter(k => !isShiftOpen(k, new Date().getHours() * 60 + new Date().getMinutes()));
      btn.disabled = true;
      sub.textContent = next.length === Object.keys(SHIFTS).length ? `Chưa tới giờ check-in. ${next.map(k => `${SHIFTS[k].name} mở lúc ${opensAt(k)}`).join(', ')}` : 'Chọn ca ở bước 1';
    }
    else sub.textContent = `Bắt đầu ${shiftLabel(chosenShift)}`;
  }
}
setInterval(() => { if (me && !me.root) renderShift(); updatePunch(); }, 15000);   // ca tự mở khi tới giờ

function showStamp(kind, emp, when, note, msg) {
  const r = $('result');
  const title = { in: 'Đã vào', out: 'Đã ra', queued: 'Đã lưu', error: 'Chưa chấm được' }[kind];
  r.innerHTML = `<div class="stamp ${kind}">
    <div class="s-kind">${title}</div>
    ${kind === 'error' ? `<div class="s-msg">${esc(msg)}</div>` : `<div class="s-time">${pad(when.getHours())}:${pad(when.getMinutes())}</div>`}
    <div class="s-name">${esc(emp.name)}</div>
    ${note ? `<div class="s-note">${esc(note)}</div>` : ''}</div>`;
  r.hidden = false;
  clearTimeout(r._h);
  r._h = setTimeout(() => r.hidden = true, kind === 'error' ? 3500 : 2600);
  r.onclick = () => r.hidden = true;
}

let punching = false;
async function punch() {
  if (!current || punching || $('btnPunch').disabled) return;
  if (!verifier.isFresh(Date.now())) { toast('Giữ yên, nhìn thẳng vào camera để xác minh lại', 'warn'); return; }
  const emp = current, when = new Date();
  const open = currentOpen();
  const type = nextAction(open);
  if (type === 'in' && !SHIFTS[chosenShift]) { toast('Chọn ca trước khi check-in', 'warn'); return; }
  const shift = type === 'in' ? chosenShift : shiftOf(open);
  punching = true; updatePunch();
  const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  try {
    const blob = await captureBlob(`${emp.code} – ${emp.name} · ${type === 'in' ? 'CHECK-IN' : 'CHECK-OUT'} · ${SHIFTS[shift].name}`, when);
    const item = {
      code: emp.code, name: emp.name, type, ts: when.getTime(), time: hms(when), blob, account: store.get('ts.account'),
      shift: type === 'in' ? shift : undefined, geo: geoFresh() ? { lat: geo.lat, lng: geo.lng, acc: geo.acc } : undefined,
    };
    try {
      // còn lượt chờ gửi trên máy: gửi chúng trước để server nhận đúng thứ tự vào/ra
      if (qdb && (await queueAll()).length) {
        await flushQueue(true);
        const left = await queueAll();
        if (left.length) throw new QueuedBehind(left[0].lastError || 'Lượt trước trên máy này chưa gửi được');
      }
      await sendPunch(item);
      beep(true);
      const outNo = type === 'out' ? (open.outs || 0) + 1 : 0;
      showStamp(type, emp, when, `${SHIFTS[shift].name}${outNo > 1 ? `, tăng ca lần ${outNo}/${OUTS_MAX}` : ''}, ảnh đã gửi vào group Telegram`);
      openShift = type === 'in' ? { shift, ts: item.ts, time: item.time, outs: 0, lastOut: null }
        : outNo >= OUTS_MAX ? null : { ...open, outs: outNo, lastOut: item.ts };
      localPunch = { ts: item.ts, at: Date.now(), open: openShift };
      switchShift = false;
      if (type === 'in') lastShift = { shift, shiftDate: shiftDateFor(shift, ymd(when), when.getHours()) };
      chosenByUser = false;
    } catch (e) {
      const behind = e instanceof QueuedBehind, status = statusOf(e);
      // bị từ chối (vd đã check-in) hoặc bấm quá nhanh (429): báo ngay, không lưu để gửi lại
      if (!behind && status && status < 500) { beep(false); showStamp('error', emp, when, '', e.message); return; }
      await qtx('readwrite', s => s.put({ ...item, tries: behind ? 0 : 1, nextAt: behind ? 0 : Date.now() + retryDelay(1), lastError: behind ? e.message : describeError(status, e.message) }));
      beep(true);
      const what = type === 'in' ? 'Check-in' : 'Check-out';
      showStamp('queued', emp, when, behind
        ? `Lượt trước trên máy này chưa gửi được (${e.message}). ${what} đã lưu, sẽ tự gửi ngay sau lượt đó; không cần bấm lại.`
        : status
        ? `Server đang lỗi. ${what} đã lưu trên máy, sẽ tự gửi lại; không cần bấm lại.`
        : `${what} sẽ tự gửi lên Telegram khi có mạng; không cần bấm lại.`);
    }
    cooldown = { code: emp.code, until: Date.now() + 6000 };
    setTimeout(updatePunch, 6100);
    await loadToday({ force: true });
  } finally {
    punching = false;
    updatePunch();
  }
}
$('btnPunch').onclick = punch;
addEventListener('keydown', e => {
  if (e.code !== 'Space' && e.key !== 'Enter') return;
  if (view !== 'kiosk' || document.querySelector('dialog[open]')) return;
  if (e.target.closest('input,select,textarea,button')) return;
  e.preventDefault();
  punch();
});

// ---------------- Tổng hợp trong ngày ----------------
// Một dòng cho mỗi (ngày công, nhân viên, ca). Ngày công của ca tối là ngày bắt đầu ca.
function dayRows(logs) {
  const m = new Map();
  for (const l of [...logs].sort((a, b) => a.ts - b.ts)) {
    const date = l.date || ymd(new Date(l.ts)), shift = shiftOf(l);
    const k = date + '|' + l.code + '|' + shift;
    if (!m.has(k)) m.set(k, { date, shift, code: l.code, name: l.name, first: null, last: null, open: null, ms: 0 });
    const s = m.get(k);
    // giờ làm: từ lúc vào tới lần check-out cuối (mỗi ca check-out tối đa 3 lần)
    if (l.type === 'in') s.first ||= l;
    else if (s.first) { s.last = l; s.ms = l.ts - s.first.ts; }
  }
  return [...m.values()];
}
// Hôm nay: các ca của ngày công hôm nay, cộng ca tối hôm qua còn đang làm (qua nửa đêm)
function todayStatus() {
  const today = ymd(new Date()), yest = ymd(addDays(new Date(), -1));
  const rows = dayRows(todayAll());
  return employees.flatMap(e => {
    const mine = rows.filter(r => r.code === e.code && (r.date === today || (r.date === yest && r.first && !r.last)));
    if (!mine.length) return [{ emp: e, shift: e.shift || 'sang', status: 'absent' }];
    return mine.map(r => ({ emp: e, ...r, status: r.last ? 'done' : 'working' }));
  });
}
// Thiếu công: đã check-in mà tới hết ngày công của ca vẫn chưa check-out (isMissed trong shifts.js)
const isForgot = r => isMissed(r);
// giờ ra sau nửa đêm của ca tối có thêm dấu +1
const tShift = (l, date) => l ? t5(l) + (l.day && l.day !== date ? '<sup>+1</sup>' : '') : '--:--';
function attendBlock(list) {
  const n = list.length || 1;
  const c = { working: 0, done: 0, absent: 0 };
  list.forEach(s => c[s.status]++);
  const late = list.filter(s => s.first?.late).length;
  return `<div class="bar" role="img" aria-label="${c.working} đang làm, ${c.done} đã ra, ${c.absent} chưa vào">
      <i class="b-work" style="width:${c.working / n * 100}%"></i><i class="b-done" style="width:${c.done / n * 100}%"></i></div>
    <div class="legend"><span class="l-work"><b>${c.working}</b> đang làm</span><span class="l-done"><b>${c.done}</b> đã ra</span>
      <span><b>${c.absent}</b> chưa vào</span>${late ? `<span class="tag late">${late} đi muộn</span>` : ''}</div>`;
}

let todayFilter = '';
function renderToday() {
  if (!isAdmin()) return;   // bảng công chỉ dành cho quản trị
  const list = todayStatus();
  $('todayAttend').innerHTML = list.length ? attendBlock(list) : '';

  const q = fold($('todaySearch').value);
  const shown = sortRows(list.filter(s => (!todayFilter || s.status === todayFilter)
    && (!q || fold(s.emp.name).includes(q) || fold(s.emp.code).includes(q))), $('todaySort').value);
  const tag = { working: '<span class="tag in">Đang làm</span>', done: '<span class="tag out">Đã ra</span>', absent: '<span class="tag none">Chưa vào</span>' };
  const head = '<li class="cols-h"><span class="l-main"></span><div class="l-right"><div class="slot-times"><span>Vào</span><span>Ra</span></div><span class="state"></span></div></li>';
  $('todayList').innerHTML = shown.length ? head + shown.map(s => `<li>${avatar(s.emp, true)}
      <div class="l-main"><div class="l-title">${esc(s.emp.name)}</div>
      <div class="l-sub">Mã ${esc(s.emp.code)}, ${SHIFTS[shiftOf(s)].name}${s.first?.late ? ', đi muộn' : ''}${s.ms ? ', đã làm ' + dur(s.ms) : ''}</div></div>
      <div class="l-right"><div class="slot-times">
        <span class="${s.first ? 't-in' : 't-none'}">${tShift(s.first, s.date)}</span>
        <span class="${s.last ? 't-out' : 't-none'}">${tShift(s.last, s.date)}</span></div><span class="state">${tag[s.status]}</span></div></li>`).join('')
    : `<li class="empty" style="display:block;border:0">${list.length ? 'Không có ai khớp bộ lọc này.' : 'Chưa có nhân viên nào.'}</li>`;
}
// Ô chọn sắp xếp: mặc định Mã NV giảm dần, nhớ lựa chọn cho lần mở sau
for (const [id, key] of [['todaySort', 'ts.sortToday'], ['histSort', 'ts.sortHist']]) {
  const el = $(id);
  el.innerHTML = Object.entries(SORTS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  el.value = SORTS[store.get(key)] ? store.get(key) : DEFAULT_SORT;
  el.onchange = () => { store.set(key, el.value); id === 'todaySort' ? renderToday() : renderHistory(); };
}
$('todaySearch').oninput = renderToday;
$('todayFilter').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  todayFilter = b.dataset.f;
  $('todayFilter').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
  renderToday();
};

// ---------------- Lịch sử ----------------
let historyLogs = [], historyKey = '';
// Kết quả từng khoảng ngày nhớ trong 60 giây: chọn lại khoảng vừa xem thì không tải lại
const historyCache = new Map();
function setPreset(p) {
  const d = new Date(), today = ymd(d);
  let from = today, to = today;
  if (p === '7d') { const s = new Date(d); s.setDate(s.getDate() - 6); from = ymd(s); }
  if (p === 'month') from = today.slice(0, 8) + '01';
  if (p === 'lastmonth') {
    const s = new Date(d.getFullYear(), d.getMonth() - 1, 1), e = new Date(d.getFullYear(), d.getMonth(), 0);
    from = ymd(s); to = ymd(e);
  }
  $('fFrom').value = from; $('fTo').value = to;
  markPreset(p);
  loadHistory();
}
function markPreset(p) { $('presets').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.p === p)); }
$('presets').onclick = e => { const b = e.target.closest('button'); if (b) setPreset(b.dataset.p); };
$('fFrom').onchange = $('fTo').onchange = () => { markPreset(null); loadHistory(); };
$('fEmp').onchange = renderHistory;

async function loadHistory(force) {
  const from = $('fFrom').value, to = $('fTo').value;
  if (!from || !to) return;
  if (from > to) { $('histSummary').textContent = 'Ngày bắt đầu đang sau ngày kết thúc. Chọn lại khoảng ngày.'; return; }
  const key = from + to;
  if (key === historyKey && !force) return renderHistory();
  const hit = historyCache.get(key);
  if (hit && !force && Date.now() - hit.at < TODAY_FRESH_MS) { historyLogs = hit.logs; historyKey = key; return renderHistory(); }
  $('histSummary').textContent = 'Đang tải bảng công…';
  try {
    historyLogs = await api(`/api/logs?from=${from}&to=${to}`);
    historyCache.set(key, { at: Date.now(), logs: historyLogs });
    historyKey = key;
    renderHistory();
  } catch (e) { $('histSummary').textContent = 'Không tải được bảng công: ' + e.message; }
}
const historyFiltered = () => historyLogs.filter(l => !$('fEmp').value || l.code === $('fEmp').value);

function renderHistory() {
  const list = historyFiltered();
  // trong mỗi ngày theo cách sắp đã chọn; ngày mới nhất ở trên (sort ổn định nên giữ thứ tự trong ngày)
  const rows = sortRows(dayRows(list), $('histSort').value).sort((a, b) => b.date.localeCompare(a.date));
  const today = ymd(new Date());
  const forgot = rows.filter(isForgot).length;
  const late = rows.filter(r => r.first?.late).length;
  const hours = Math.round(rows.reduce((s, r) => s + r.ms, 0) / 3600000);
  const range = $('fFrom').value === $('fTo').value ? `Ngày ${dmy($('fFrom').value)}` : `Từ ${dmy($('fFrom').value)} đến ${dmy($('fTo').value)}`;
  $('histSummary').innerHTML = rows.length
    ? `${range}: <b>${rows.filter(r => r.last).length}</b> ngày công, <b>${hours}</b> giờ làm, <b>${late}</b> lượt đi muộn, <b>${forgot}</b> ngày thiếu công vì quên check-out.`
    : `${range}: chưa có lượt chấm công nào.`;

  const byDay = (items, render) => {
    const out = []; let day = '';
    for (const it of items) {
      if (it.date !== day) { day = it.date; out.push(`<div class="day-h">${esc(weekday(day))}, ${dmy(day)}</div><ul class="ledger">`); }
      out.push(render(it));
      const next = items[items.indexOf(it) + 1];
      if (!next || next.date !== day) out.push('</ul>');
    }
    return out.join('');
  };
  $('sumList').innerHTML = rows.length ? byDay(rows, r => `<li><div class="l-main"><div class="l-title">${esc(r.name)}</div>
      <div class="l-sub">${SHIFTS[r.shift].name}, ${r.last ? 'làm ' + dur(r.ms) : isForgot(r) ? '<span class="tag late">thiếu công: quên check-out</span>' : 'đang làm'}${r.first?.late ? ', đi muộn' : ''}${r.first?.delayed || r.last?.delayed ? ', <span class="tag late">có lượt gửi trễ</span>' : ''}</div></div>
      <div class="l-right"><div class="slot-times"><span class="t-in">${tShift(r.first, r.date)}</span>
      <span class="${r.last ? 't-out' : 't-none'}">${tShift(r.last, r.date)}</span></div></div></li>`)
    : '<div class="empty">Không có dữ liệu trong khoảng ngày này.</div>';

  const logs = [...list].sort((a, b) => b.ts - a.ts);
  $('logCount').textContent = logs.length ? `${logs.length} lượt` : '';
  $('logList').innerHTML = logs.length ? byDay(logs, l => `<li>
      <button class="thumb" aria-label="Xem ảnh ${l.type === 'in' ? 'check-in' : 'check-out'} của ${esc(l.name)}" data-photo="${esc(l.photo)}" data-cap="${esc(l.name)}, ${l.type === 'in' ? 'check-in' : 'check-out'} ${esc(SHIFTS[shiftOf(l)].name)} lúc ${esc(dmyhm(l.ts))}"></button>
      <div class="l-main"><div class="l-title">${esc(l.name)}</div><div class="l-sub">${l.type === 'in' ? 'Check-in' : `Check-out${l.outNo ? ` lần ${l.outNo}/${OUTS_MAX}` : ''}`} ${SHIFTS[shiftOf(l)].name}${l.late ? ', đi muộn' : ''}${l.delayed ? `, <span class="tag late">gửi trễ, nhận lúc ${esc(l.received)}</span>` : ''}${l.loc ? `<br>Vị trí: ${locHtml(l.loc)}` : ''}</div></div>
      <span class="${l.type === 'in' ? 't-in' : 't-out'}">${tShift(l, l.date)}</span></li>`)
    : '<div class="empty">Không có ảnh nào.</div>';
  $('logList').querySelectorAll('[data-photo]').forEach(el => thumbObserver.observe(el));
}

// Ảnh thu nhỏ: chỉ tải khi cuộn tới, tối đa 3 ảnh cùng lúc
const photoCache = new Map();
const photoQueue = [];
let photoActive = 0;
function getPhoto(id) {
  if (!photoCache.has(id)) photoCache.set(id, new Promise((res, rej) => { photoQueue.push({ id, res, rej }); pumpPhotos(); }));
  return photoCache.get(id);
}
function pumpPhotos() {
  while (photoActive < 3 && photoQueue.length) {
    const job = photoQueue.shift();
    photoActive++;
    api('/api/photo?id=' + encodeURIComponent(job.id)).then(r => r.blob()).then(b => job.res(URL.createObjectURL(b)))
      .catch(e => { photoCache.delete(job.id); job.rej(e); })
      .finally(() => { photoActive--; pumpPhotos(); });
  }
}
const thumbObserver = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    thumbObserver.unobserve(en.target);
    getPhoto(en.target.dataset.photo).then(u => en.target.style.backgroundImage = `url("${u}")`).catch(() => {});
  }
}, { rootMargin: '200px' });

function openViewer(src) {
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<button class="icon-btn" aria-label="Đóng"><svg><use href="#i-x"/></svg></button><img alt=""><div class="cap"></div>`;
  v.querySelector('.cap').textContent = src.dataset.cap || '';
  const close = () => { v.remove(); removeEventListener('keydown', onKey); src.focus(); };
  const onKey = e => e.key === 'Escape' && close();
  v.onclick = e => { if (e.target === v || e.target.closest('.icon-btn')) close(); };
  addEventListener('keydown', onKey);
  document.body.append(v);
  v.querySelector('.icon-btn').focus();
  getPhoto(src.dataset.photo).then(u => v.querySelector('img').src = u)
    .catch(e => { v.querySelector('.cap').textContent = 'Không tải được ảnh: ' + e.message; });
}
$('logList').onclick = e => { const el = e.target.closest('[data-photo]'); if (el) openViewer(el); };

$('btnCsv').onclick = () => {
  const rows = [['Ngày công', 'Ca', 'Mã NV', 'Họ tên', 'Giờ vào', 'Giờ ra', 'Số giờ', 'Tính công', 'Đi muộn', 'Vị trí vào', 'Vị trí ra', 'Gửi trễ']];
  for (const s of sortRows(dayRows(historyFiltered()), $('histSort').value).sort((a, b) => a.date.localeCompare(b.date)))
    rows.push([dmy(s.date), SHIFTS[s.shift].name, s.code, s.name, s.first ? dmyhm(s.first.ts) : '', s.last ? dmyhm(s.last.ts) : '',
      (s.ms / 3600000).toFixed(2), s.last ? 'Có' : isForgot(s) ? 'Không (quên check-out)' : 'Đang làm', s.first?.late ? 'x' : '', locText(s.first?.loc), locText(s.last?.loc),
      [s.first, s.last].filter(l => l?.delayed).map(l => `${l.type === 'in' ? 'vào' : 'ra'} nhận lúc ${l.received}`).join('; ')]);
  if (rows.length === 1) return toast('Không có dữ liệu để xuất trong khoảng ngày này', 'warn');
  // ô bắt đầu bằng = + - @ được thêm dấu ' để Excel không chạy như công thức
  const cell = v => { const t = String(v); return `"${(/^[=+\-@\t\r]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`; };
  const csv = '\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `bang-cong_${$('fFrom').value}_${$('fTo').value}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Đã xuất file Excel', 'ok');
};

// ---------------- Quản trị ----------------
function renderEmployees() {
  const opts = employees.map(e => `<option value="${esc(e.code)}">${esc(e.name)} (${esc(e.code)})</option>`).join('');
  const cur = $('fEmp').value;
  $('fEmp').innerHTML = '<option value="">Tất cả nhân viên</option>' + opts;
  $('fEmp').value = cur;
  $('empCount').textContent = employees.length || '';
  const q = fold($('empSearch').value);
  const shown = employees.filter(e => !q || fold(e.name).includes(q) || fold(e.code).includes(q));
  $('empList').innerHTML = shown.length ? shown.map(e => {
    const n = e.descriptors?.length || 0;
    return `<li>${avatar(e, true)}<div class="l-main"><div class="l-title">${esc(e.name)}</div>
      <div class="l-sub">Mã ${esc(e.code)}, ${SHIFTS[e.shift]?.name || SHIFTS.sang.name}${e.tg ? ', @' + esc(e.tg) : ''}</div></div>
      <div class="l-right">${e.role === ROLE_ADMIN ? '<span class="tag out">Quản trị</span>' : ''}${e.hasKey ? '' : '<span class="tag late">Chưa có mã kích hoạt</span>'}${e.devices ? `<span class="tag">${e.devices} máy</span>` : ''}${n >= 3 ? `<span class="tag in">${n} mẫu khuôn mặt</span>` : n ? '<span class="tag late">Nên chụp lại khuôn mặt</span>' : '<span class="tag late">Chưa có khuôn mặt</span>'}
      <button class="btn sm" data-edit="${esc(e.code)}">Sửa</button></div></li>`;
  }).join('') : `<li class="empty" style="display:block;border:0">${employees.length ? 'Không tìm thấy nhân viên.' : 'Chưa có nhân viên nào. Bấm Thêm nhân viên để đăng ký người đầu tiên.'}</li>`;
}
$('empSearch').oninput = renderEmployees;
$('empList').onclick = e => { const b = e.target.closest('[data-edit]'); if (b) openEnroll(employees.find(x => x.code === b.dataset.edit)); };
$('btnAddEmp').onclick = () => openEnroll(null);

// ---------------- Nhập danh sách nhân viên ----------------
function downloadText(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = v => { const t = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`; };
let importRows = [];
$('btnImport').onclick = () => {
  importRows = [];
  $('importText').value = ''; $('importUpdate').checked = false;
  $('importStep1').hidden = false; $('importStep2').hidden = true; $('importStep2').innerHTML = '';
  $('btnDoImport').hidden = false;
  previewImport();
  $('importDlg').showModal();
};
$('importDlg').querySelectorAll('[data-close]').forEach(b => b.onclick = () => $('importDlg').close());
$('btnTemplate').onclick = () => downloadText('mau-danh-sach-nhan-vien.csv', '\uFEFF' + ImportList.TEMPLATE);
$('btnImportFile').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  $('importText').value = await f.text();
  previewImport();
};
let importTimer;
$('importText').oninput = () => { clearTimeout(importTimer); importTimer = setTimeout(previewImport, 250); };
$('importUpdate').onchange = previewImport;

// Xem trước: kiểm tra ngay trên máy những lỗi dễ thấy; server kiểm tra lại khi nhập
function previewImport() {
  const text = $('importText').value.trim();
  const { rows, errors } = text ? ImportList.parseEmployees(text) : { rows: [], errors: [] };
  importRows = rows;
  const have = new Set(employees.map(e => e.code)), seen = new Set();
  let ok = 0;
  const notes = rows.map(r => {
    let n = '';
    if (!r.code || !r.name) n = 'Thiếu mã NV hoặc họ tên';
    else if (r.shift && !SHIFTS[r.shift]) n = `Ca "${r.shift}" không hợp lệ (Sáng / Tối)`;
    else if (seen.has(r.code)) n = 'Trùng mã trong danh sách';
    else if (have.has(r.code)) n = $('importUpdate').checked ? 'Sẽ cập nhật' : 'Đã có, bỏ qua';
    seen.add(r.code);
    if (!n || n === 'Sẽ cập nhật') ok++;
    return n;
  });
  $('importPreview').innerHTML = errors.length ? `<div class="note err">${esc(errors[0])}</div>`
    : rows.length ? `<div class="imp-scroll"><table class="imp"><tr><th>#</th><th>Mã NV</th><th>Họ tên</th><th>Quyền</th><th>Ca</th><th>Telegram</th><th>Ghi chú</th></tr>${rows.map((r, i) =>
      `<tr class="${notes[i] && notes[i] !== 'Sẽ cập nhật' ? 'err' : ''}"><td>${i + 1}</td><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${r.role === ROLE_ADMIN ? 'Quản trị' : 'Nhân viên'}</td>
       <td>${esc(SHIFTS[r.shift || 'sang']?.name || r.shift)}</td><td>${esc(r.tg)}</td><td>${esc(notes[i])}</td></tr>`).join('')}</table></div>` : '';
  $('importCount').textContent = rows.length ? `${ok}/${rows.length} dòng sẽ được nhập` : '';
  $('btnDoImport').disabled = !ok;
  $('btnDoImport').textContent = ok ? `Nhập ${ok} người` : 'Nhập';
}

$('btnDoImport').onclick = async () => {
  $('btnDoImport').disabled = true;
  try {
    const r = await api('/api/employees/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: importRows, update: $('importUpdate').checked }),
    });
    const parts = [`<div class="note ok">Đã thêm ${r.created.length} người${r.updated.length ? `, cập nhật ${r.updated.length} người` : ''}${r.skipped.length ? `, bỏ qua ${r.skipped.length} người đã có` : ''}.</div>`];
    if (r.errors.length) parts.push(`<div class="note err" style="margin-top:8px">${r.errors.map(e => `Dòng ${e.row}: ${esc(e.error)}`).join('<br>')}</div>`);
    if (r.created.length) {
      parts.push(`<h3 class="sec" style="margin:16px 0 8px">Mã kích hoạt của người mới</h3>
        <p class="help">Mã chỉ hiện lần này. Tải danh sách về rồi gửi riêng cho từng người.</p>
        <div class="actions" style="margin:10px 0"><button class="btn ink" id="btnCodesCsv"><svg><use href="#i-download"/></svg>Tải danh sách mã</button></div>
        <div class="imp-scroll"><table class="imp"><tr><th>Mã NV</th><th>Họ tên</th><th>Mã kích hoạt</th></tr>${r.created.map(c =>
          `<tr><td>${esc(c.code)}</td><td>${esc(c.name)}</td><td class="stampnum" style="font-size:18px">${esc(c.accessCode)}</td></tr>`).join('')}</table></div>`);
    }
    $('importStep1').hidden = true; $('importStep2').hidden = false; $('importStep2').innerHTML = parts.join('');
    $('btnDoImport').hidden = true; $('importCount').textContent = '';
    $('btnCodesCsv')?.addEventListener('click', () => downloadText('ma-kich-hoat.csv',
      '\uFEFF' + [['Mã NV', 'Họ tên', 'Mã kích hoạt'], ...r.created.map(c => [c.code, c.name, c.accessCode])].map(x => x.map(csvCell).join(',')).join('\r\n')));
    toast(`Đã nhập ${r.created.length + r.updated.length} người`, 'ok');
    await loadEmployees();
  } catch (e) { toast(e.message, 'err', 6000); $('btnDoImport').disabled = false; }
};

// Đăng ký khuôn mặt: tự chụp lần lượt các góc khi khuôn mặt đủ rõ
const enroll = { open: false, existing: null, editing: null, avatar: null };
const upload = { samples: [], items: [] };   // mẫu khuôn mặt lấy từ ảnh tải lên
const newSamples = () => [...enroller.samples, ...upload.samples].slice(0, 10);
const enroller = new Enroller();
function openEnroll(emp) {
  Object.assign(enroll, { open: true, existing: emp?.descriptors || null, editing: emp?.code || null });
  enroller.stop(); enroller.samples = [];
  $('enrollTitle').textContent = emp ? 'Sửa nhân viên' : 'Thêm nhân viên';
  $('eCode').value = emp?.code || ''; $('eCode').readOnly = !!emp;
  $('eName').value = emp?.name || '';
  $('eTg').value = emp?.tg ? '@' + emp.tg : '';
  $('eRole').value = String(emp?.role || 2);
  $('eShift').value = emp?.shift || 'sang';
  upload.samples = []; upload.items = []; enroll.avatar = null; renderUploads();
  $('eRole').disabled = emp?.code === me?.code;   // không tự bỏ quyền quản trị của mình
  $('btnDeleteEmp').hidden = !emp || emp.code === me?.code;
  $('btnNewCode').hidden = !emp || emp.code === me?.code;
  $('btnRevokeDevices').hidden = !emp?.devices || emp.code === me?.code;
  $('btnRevokeDevices').textContent = `Đăng xuất mọi máy (${emp?.devices || 0})`;
  $('btnNewCode').textContent = emp?.hasKey ? 'Tạo mã kích hoạt mới' : 'Tạo mã kích hoạt';
  $('dupWarn').hidden = true;
  $('enrollSlot').append(stage);
  video.play().catch(() => {});
  current = null; faceState = 'search';
  $('enrollHud').hidden = false;
  renderEnroll();
  $('enrollDlg').showModal();
  (emp ? $('eName') : $('eCode')).focus();
}
function closeEnroll() {
  enroll.open = false; enroller.stop();
  $('enrollHud').hidden = true;
  showDebug();
  $('stageHome').append(stage);
  video.play().catch(() => {});
  setPill(cameraReady ? 'search' : 'loading', cameraReady ? 'Đang tìm khuôn mặt' : 'Camera chưa sẵn sàng');
  renderPerson(); updatePunch();
}
$('enrollDlg').addEventListener('close', closeEnroll);
$('enrollDlg').querySelectorAll('[data-close]').forEach(b => b.onclick = () => $('enrollDlg').close());

function renderEnroll() {
  const n = enroller.samples.length, up = upload.samples.length;
  $('enrollTicks').innerHTML = ENROLL_STEPS.map((_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  const info = $('sampleInfo');
  if (n >= MAX_SAMPLES) { info.className = 'note ok'; info.textContent = `Đã chụp đủ ${MAX_SAMPLES} góc. Bấm Lưu nhân viên để hoàn tất.`; }
  else if (enroller.active) { info.className = 'note warn'; info.textContent = `Đang chụp góc ${n + 1}/${MAX_SAMPLES}. Làm theo hướng dẫn trên camera.`; }
  else if (up) { info.className = up >= 3 ? 'note ok' : 'note warn'; info.textContent = `${up} ảnh dùng được${n ? ` và ${n} góc đã chụp` : ''}.${up < 3 && !n ? ' Nên có ít nhất 3 ảnh.' : ' Bấm Lưu nhân viên để hoàn tất.'}`; }
  else if (enroll.existing?.length) { info.className = 'note ok'; info.textContent = `Đang dùng ${enroll.existing.length} mẫu khuôn mặt đã lưu. Bấm Chụp khuôn mặt nếu muốn thay.`; }
  else { info.className = 'note warn'; info.textContent = `Chưa có khuôn mặt. Bấm Chụp khuôn mặt, máy sẽ tự chụp ${MAX_SAMPLES} góc.`; }
  $('btnStartEnroll').disabled = enroller.active || !cameraReady;
  $('enrollTip').textContent = !cameraReady ? 'Camera chưa sẵn sàng'
    : n >= MAX_SAMPLES ? 'Xong. Bấm Lưu nhân viên.'
    : enroller.active ? enroller.tip : 'Bấm Chụp khuôn mặt để bắt đầu';
  if (!enroller.active) setPill('enroll', n >= MAX_SAMPLES ? 'Đã chụp đủ' : 'Đăng ký khuôn mặt');
}
$('btnStartEnroll').onclick = () => { startCapture(); };
function startCapture() {
  enroller.start(Date.now());
  $('dupWarn').hidden = true;
  renderEnroll();
}
$('btnResetSample').onclick = () => {
  enroller.stop(); enroller.samples = []; upload.samples = []; upload.items = []; enroll.avatar = null;
  $('dupWarn').hidden = true; renderUploads(); renderEnroll();
};

// Ảnh đại diện 160×160 cắt quanh khuôn mặt, nén WebP/JPEG còn vài KB (KV gói miễn phí)
function faceThumb(src, box) {
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
  const size = Math.min(Math.max(box.width, box.height) * 1.7, sw, sh);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const sx = Math.max(0, Math.min(sw - size, cx - size / 2)), sy = Math.max(0, Math.min(sh - size, cy - size / 2));
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  c.getContext('2d').drawImage(src, sx, sy, size, size, 0, 0, 160, 160);
  for (const [type, q] of [['image/webp', 0.75], ['image/jpeg', 0.78], ['image/jpeg', 0.6]]) {
    const url = c.toDataURL(type, q);
    if (url.startsWith('data:' + type) && url.length < 40 * 1024 * 1.3) return url;   // Safari không nén được WebP thì dùng JPEG
  }
  return null;
}

// Đăng ký khuôn mặt bằng ảnh tải lên: ảnh chỉ được đọc trên máy, thu nhỏ còn tối đa 800px trước khi nhận diện
async function scaledCanvas(file, max) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}
function renderUploads() {
  $('uploadList').innerHTML = upload.items.map(it => `<li>${it.thumb ? `<img src="${it.thumb}" alt="">` : ''}
    <span>${esc(it.name)}<br><span class="${it.ok === true ? 'ok' : it.ok === false ? 'bad' : 'soft'}">${esc(it.status)}</span></span></li>`).join('');
}
async function addUpload(file) {
  if (!modelsReady) return toast('Bộ nhận diện chưa tải xong, thử lại sau vài giây', 'warn');
  if (newSamples().length >= 10) return toast('Đã đủ 10 mẫu khuôn mặt', 'warn');
  const it = { name: file.name, status: 'Đang đọc ảnh…', ok: null, thumb: null };
  upload.items.push(it); renderUploads();
  try {
    const c = await scaledCanvas(file, 800);
    const t = document.createElement('canvas');
    t.width = 80; t.height = Math.round(80 * c.height / c.width);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    it.thumb = t.toDataURL('image/jpeg', 0.7);
    const dets = await faceapi.detectAllFaces(c, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.5 })).withFaceLandmarks().withFaceDescriptors();
    const res = checkUpload(dets.map(d => ({ score: d.detection.score, boxWidth: d.detection.box.width, descriptor: d.descriptor })), c.width, upload.samples.length ? upload.samples : enroller.samples);
    it.ok = res.ok; it.status = res.ok ? 'Dùng được' : res.reason;
    if (res.ok) {
      upload.samples.push(Array.from(dets[0].descriptor));
      if (!enroll.avatar) enroll.avatar = faceThumb(c, dets[0].detection.box);
    }
  } catch (e) {
    console.error(e);
    it.ok = false; it.status = 'Không đọc được ảnh. Dùng ảnh JPG hoặc PNG.';
  }
  renderUploads(); renderEnroll();
  if (newSamples().length) checkDuplicate();
}
$('btnUploadFace').onclick = () => $('faceFiles').click();
$('faceFiles').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) await addUpload(f);
};

function enrollStep(det, count) {
  if (!enroller.active) return;
  const pose = det ? facePose(det.landmarks.positions) : null;
  const r = enroller.frame({
    descriptor: det?.descriptor, pose, faceCount: count,
    boxRatio: det ? det.detection.box.width / video.videoWidth : 0, score: det?.detection.score ?? 0,
  }, Date.now());
  if (pose) showDebug(`So với lúc nhìn thẳng: quay ${(pose.yaw - (enroller.st.yaw0 ?? pose.yaw)).toFixed(2)}, cúi ${(pose.pitch - (enroller.st.pitch0 ?? pose.pitch)).toFixed(2)}`);
  if (r.event === 'hint') { setPill('enroll', r.tip); $('enrollTip').textContent = r.tip; return; }
  if (r.event === 'hold') { setPill('ok', 'Giữ yên'); return; }
  if (r.event === 'restart') toast(r.tip, 'warn', 5000);
  if (r.event === 'captured' || r.event === 'done') navigator.vibrate?.(30);
  if (r.event === 'captured' && enroller.samples.length === 1 && det) enroll.avatar = faceThumb(video, det.detection.box);
  if (r.event === 'done') { showDebug(); checkDuplicate(); }
  renderEnroll();
}

function checkDuplicate() {
  const first = newSamples()[0];
  if (!first) return null;
  const best = findDuplicate(first, employees, $('eCode').value.trim() || enroll.editing);
  $('dupWarn').hidden = !best;
  if (best) $('dupWarn').textContent = `Khuôn mặt này rất giống ${best.emp.name} (mã ${best.emp.code}). Kiểm tra lại người đang đăng ký trước khi lưu.`;
  return best;
}

$('btnSaveEmp').onclick = async () => {
  const code = $('eCode').value.trim(), name = $('eName').value.trim();
  if (!code || !name) { toast('Nhập mã NV và họ tên', 'warn'); (code ? $('eName') : $('eCode')).focus(); return; }
  if (!enroll.editing && employees.some(e => e.code === code)) { toast(`Mã ${code} đã có người dùng. Chọn mã khác.`, 'warn'); $('eCode').focus(); return; }
  if (enroller.active) { toast('Chờ chụp xong đủ các góc', 'warn'); return; }
  const fresh = newSamples();
  const descriptors = fresh.length ? fresh : enroll.existing;
  if (!descriptors?.length) { toast('Chụp khuôn mặt hoặc tải ảnh lên trước khi lưu', 'warn'); return; }
  if (fresh.length && checkDuplicate() && !confirm('Khuôn mặt giống một nhân viên khác. Vẫn lưu?')) return;
  $('btnSaveEmp').disabled = true;
  try {
    const r = await api('/api/employees', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, role: Number($('eRole').value), shift: $('eShift').value, tg: $('eTg').value.trim(), descriptors,
        ...(fresh.length && enroll.avatar ? { avatar: enroll.avatar } : {}) }),
    });
    forgetAvatar(code);
    toast(`Đã lưu nhân viên ${name}`, 'ok');
    $('enrollDlg').close();
    if (r.accessCode) showCode(name, r.accessCode);
    if (code === me?.code) await loadMe(); else await loadEmployees();
  } catch (e) { toast(e.message, 'err', 6000); }
  finally { $('btnSaveEmp').disabled = false; }
};
$('btnDeleteEmp').onclick = async () => {
  const code = enroll.editing, emp = employees.find(e => e.code === code);
  if (!confirm(`Xoá nhân viên ${emp.name}? Lịch sử chấm công vẫn được giữ.`)) return;
  await busy($('btnDeleteEmp'), async () => { try {
    await api('/api/employees?code=' + encodeURIComponent(code), { method: 'DELETE' });
    toast(`Đã xoá nhân viên ${emp.name}`, 'ok');
    $('enrollDlg').close();
    await loadEmployees();
  } catch (e) { toast(e.message, 'err', 6000); } }, 'Đang xoá…');
};
$('btnNewCode').onclick = async () => {
  const emp = employees.find(e => e.code === enroll.editing);
  if (emp.hasKey && !confirm(`Tạo mã mới cho ${emp.name}? Mã cũ sẽ hết hiệu lực, máy đang dùng mã cũ phải nhập lại mã mới.`)) return;
  await busy($('btnNewCode'), async () => { try {
    const r = await api('/api/employees/code?code=' + encodeURIComponent(emp.code), { method: 'POST' });
    $('enrollDlg').close();
    showCode(emp.name, r.accessCode);
    await loadEmployees();
  } catch (e) { toast(e.message, 'err', 6000); } }, 'Đang tạo…');
};
// Đăng xuất mọi máy của một người (vd mất điện thoại) mà không đổi mã kích hoạt
$('btnRevokeDevices').onclick = async () => {
  const emp = employees.find(e => e.code === enroll.editing);
  if (!confirm(`Đăng xuất ${emp.name} khỏi mọi máy (${emp.devices})? Lần sau họ nhập lại mã kích hoạt cũ là dùng tiếp được.`)) return;
  await busy($('btnRevokeDevices'), async () => { try {
    await api('/api/devices?code=' + encodeURIComponent(emp.code), { method: 'DELETE' });
    toast(`Đã đăng xuất ${emp.name} khỏi mọi máy`, 'ok');
    $('enrollDlg').close();
    await loadEmployees();
  } catch (e) { toast(e.message, 'err', 6000); } }, 'Đang đăng xuất…');
};
function showCode(name, code) {
  $('codeFor').textContent = `Mã kích hoạt của ${name}`;
  $('codeValue').textContent = code;
  $('codeDlg').showModal();
}
$('btnCopyCode').onclick = async () => {
  try { await navigator.clipboard.writeText($('codeValue').textContent); toast('Đã sao chép mã', 'ok'); }
  catch { getSelection().selectAllChildren($('codeValue')); toast('Bấm giữ để sao chép mã', 'info'); }
};
$('btnSetup').onclick = () => busy($('btnSetup'), async () => {
  try {
    const r = await api('/api/setup', { method: 'POST' });
    toast(`Đã kết nối bot @${r.bot}` + (r.chat ? '' : '. Còn thiếu id group: gõ /chatid trong group để lấy.'), r.chat ? 'ok' : 'warn', 7000);
  } catch (e) { toast(e.message, 'err', 6000); }
}, 'Đang kết nối…');
$('btnReport').onclick = () => busy($('btnReport'), async () => {
  try { await api('/api/report-now', { method: 'POST' }); toast('Đã gửi tổng hợp vào group Telegram', 'ok'); }
  catch (e) { toast(e.message, 'err', 6000); }
});

// ---------------- Kích hoạt bằng mã riêng ----------------
function openOnboarding(err) {
  $('onboardErr').hidden = !err;
  $('onboardErr').textContent = err || '';
  $('onboardKey').value = '';
  if (!$('onboardDlg').open) $('onboardDlg').showModal();
  $('onboardKey').focus();
}
$('onboardDlg').addEventListener('cancel', e => { if (!store.get('ts.account')) e.preventDefault(); });
$('onboardForm').onsubmit = async e => {
  e.preventDefault();
  const key = $('onboardKey').value.trim();
  const ok = await busy($('btnActivate'), async () => {
    try {
      const r = await activateDevice(key, $('onboardBorrowed').checked);
      me = r.me; store.set('ts.account', r.account);
      return true;
    } catch (e) {
      // 429: nhập sai quá nhiều lần, server báo phải chờ bao lâu
      if (e instanceof HttpError) return openOnboarding(e.status === 401 ? 'Mã kích hoạt không đúng. Kiểm tra lại với quản trị viên.' : describeError(e.status, e.message));
      return openOnboarding(e instanceof TypeError ? 'Không có mạng. Kết nối mạng rồi thử lại.' : e.message);
    }
  }, 'Đang kiểm tra…');
  if (!ok) return;
  $('onboardBorrowed').checked = false;
  store.set('ts.me', JSON.stringify(me));
  $('onboardDlg').close();
  toast(`Xin chào ${me.name}`, 'ok');
  applyRole();
  await loadToday(); flushQueue();
};

// Bản cũ lưu mã kích hoạt trong localStorage và trong từng lượt chờ gửi: đổi sang đăng nhập theo máy một lần rồi xoá mã.
// Mất mạng thì giữ mã để thử lại lần mở app sau; mã sai (401) thì bỏ.
async function migrateLegacyCodes() {
  if (!qdb) return;
  const codes = new Map();
  const legacy = store.get('ts.accessCode');
  if (legacy) codes.set(legacy, null);
  const items = await queueAll();
  for (const it of items) if (it.accessCode) codes.set(it.accessCode, null);
  for (const code of codes.keys()) {
    try { codes.set(code, (await activateDevice(code)).account); }
    catch (e) { if (e instanceof HttpError && e.status === 401) codes.set(code, false); }
  }
  for (const it of items) {
    const account = codes.get(it.accessCode);
    if (account === undefined || account === null) continue;
    const { accessCode, ...rest } = it;
    await qtx('readwrite', s => s.put(account ? { ...rest, account } : rest));
  }
  if (legacy && codes.get(legacy) !== null) {
    store.del('ts.accessCode');
    if (codes.get(legacy)) store.set('ts.account', codes.get(legacy));
  }
}

// ---------------- Điều hướng ----------------
let view = 'kiosk';
let pendingView = null;   // trang mở bằng link (#report, #admin), chờ biết quyền mới chuyển
function showView(v) {
  if (!['kiosk', 'report', 'admin'].includes(v) || (v !== 'kiosk' && !isAdmin())) v = 'kiosk';
  view = v;
  document.querySelectorAll('.nav button').forEach(b => b.dataset.view === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  for (const id of ['kiosk', 'report', 'admin']) $('view-' + id).hidden = id !== v;
  if (v === 'report' && !$('r-history').hidden) loadHistory();
  if (v === 'report' && !$('r-today').hidden) loadToday();   // Bảng công hôm nay chỉ tải khi mở
  if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  scrollTo(0, 0);
}
document.querySelector('.nav').onclick = e => { const b = e.target.closest('[data-view]'); if (b) showView(b.dataset.view); };
addEventListener('hashchange', () => showView(location.hash.slice(1)));
document.querySelector('.toggle').onclick = e => {
  const b = e.target.closest('[data-rtab]'); if (!b) return;
  document.querySelectorAll('.toggle button').forEach(x => x.setAttribute('aria-pressed', x === b));
  $('r-today').hidden = b.dataset.rtab !== 'today';
  $('r-history').hidden = b.dataset.rtab !== 'history';
  if (b.dataset.rtab === 'history') loadHistory();
  else loadToday();
};

// ---------------- PWA ----------------
let installEvt;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
addEventListener('appinstalled', () => { $('installBtn').hidden = true; toast('Đã cài app Timesheet', 'ok'); });
$('installBtn').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null; $('installBtn').hidden = true;
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------------- Khởi động ----------------
(async () => {
  const today = ymd(new Date());
  $('fFrom').value = today.slice(0, 8) + '01'; $('fTo').value = today;
  applyRole();
  pendingView = location.hash.slice(1);
  showView(pendingView);
  await openQueue().catch(() => {});
  await migrateLegacyCodes();
  if (!store.get('ts.account')) openOnboarding();
  else loadMe().then(loadToday).then(flushQueue);
  if (!window.faceapi) {
    stageMsg({ icon: true, title: 'Không tải được bộ nhận diện', text: 'Kiểm tra kết nối mạng rồi tải lại trang.', retry: { label: 'Tải lại trang', run: () => location.reload() } });
    return;
  }
  try {
    await loadModels();
  } catch (e) {
    console.error(e);
    stageMsg({ icon: true, title: 'Không tải được bộ nhận diện', text: 'Kiểm tra kết nối mạng rồi tải lại trang.', retry: { label: 'Tải lại trang', run: () => location.reload() } });
    return;
  }
  await startCamera();
  detectLoop();
})();
