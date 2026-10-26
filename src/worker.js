// Timesheet backend — Cloudflare Worker (gói miễn phí)
// - Nhận ảnh check-in/out từ PWA, gửi vào group Telegram (Telegram giữ ảnh)
// - Lưu chỉ mục chấm công trong KV để bot tổng hợp
// - Ca làm việc: ca sáng 08:00–17:00, ca tối 22:00–06:00 hôm sau; công tính theo ngày bắt đầu ca
// - Cron: nhắc người chưa check-in, tổng hợp cuối ca, cảnh báo quên check-out (theo từng ca)
// - Webhook: lệnh bot /homnay, /chatid, /help

const LOG_TTL = 60 * 60 * 24 * 120; // giữ chỉ mục 120 ngày (ảnh vẫn còn trên Telegram)
const MAX_DELAY_MS = 24 * 3600e3;    // lượt chụp quá 24 giờ mới gửi thì không nhận (chống chỉnh giờ máy để chấm lùi)
const DELAYED_MS = 2 * 60e3;         // gửi chậm hơn 2 phút so với giờ chụp thì đánh dấu "gửi trễ"
// Mỗi ca: check-in 1 lần. Check-out là kết thúc ca; check-out thêm (tối đa 3 lần) là tăng ca.
// Sang ngày công mới thì quay về Check-in; đã check-in mà chưa check-out thì ngày đó thiếu công.
const OUTS_MAX = 3;
const AVATAR_MAX_BYTES = 40 * 1024;  // ảnh đại diện đã thu nhỏ ở máy (thường ~8KB); chặn ảnh lớn cho KV gói miễn phí
const IMPORT_MAX_ROWS = 500;

// Ca làm việc. Giữ giống SHIFTS trong public/app.js (có test kiểm tra).
const SHIFTS = {
  sang: { name: 'Ca sáng', start: '08:00', end: '17:00', overnight: false },
  toi: { name: 'Ca tối', start: '22:00', end: '06:00', overnight: true },
};
const DEFAULT_SHIFT = 'sang';
// Khung giờ check-in của ca: từ 2 giờ trước giờ vào tới hết ca. Giống isShiftOpen trong public/shifts.js.
const EARLY_MIN = 120;
const toMin = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const openMin = shift => (toMin(SHIFTS[shift].start) - EARLY_MIN + 1440) % 1440;
function isShiftOpen(shift, minuteOfDay) {
  const from = openMin(shift), to = toMin(SHIFTS[shift].end);
  return from < to ? minuteOfDay >= from && minuteOfDay < to : minuteOfDay >= from || minuteOfDay < to;
}
const opensAt = shift => { const t = openMin(shift); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
const shiftOf = l => SHIFTS[l?.shift] ? l.shift : DEFAULT_SHIFT;   // lượt cũ (trước khi có ca) tính là ca sáng

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/telegram/webhook') return await telegramWebhook(req, env);
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      return env.ASSETS.fetch(req);
    } catch (e) {
      return errorResponse(e, req);
    }
  },

  // 07:00 tổng hợp ca tối hôm qua · 09:00 nhắc ca sáng · 18:30 tổng hợp ca sáng · 23:00 nhắc ca tối (giờ Việt Nam)
  async scheduled(event, env, ctx) {
    const now = localNow(env), h = now.getUTCHours(), today = ymd(now);
    const job = h < 8 ? ['summary', 'toi', addDays(today, -1)]
      : h < 12 ? ['remind', 'sang', today]
      : h < 21 ? ['summary', 'sang', today]
      : ['remind', 'toi', today];
    const [kind, shift, date] = job;
    if (isHoliday(env, date)) return;   // ngày lễ: không nhắc, không tổng hợp
    ctx.waitUntil(kind === 'remind' ? shiftReminder(env, date, shift) : shiftSummary(env, date, shift));
  },
};

// ---------------- Phân quyền ----------------
// Mỗi người có mã kích hoạt riêng (admin sinh ra). Server chỉ lưu hash của mã.
// role: 1 = quản trị, 2 = nhân viên. ADMIN_KEY là tài khoản quản trị gốc (không chấm công).
const ROLE_ADMIN = 1, ROLE_EMPLOYEE = 2;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // bỏ 0/O, 1/I/L cho dễ đọc

const normCode = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function newAccessCode() {
  let out = '';
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && out.length < 8) out += CODE_ALPHABET[b % 31]; // 248 = 31*8: tránh lệch phân bố
    }
  }
  return out.slice(0, 4) + '-' + out.slice(4);
}

// ---------------- Đăng nhập theo máy ----------------
// Mã kích hoạt chỉ dùng để kích hoạt một máy (không giới hạn số máy: mượn điện thoại người khác vẫn tự chấm được).
// Lúc kích hoạt, máy tạo cặp khoá ECDSA P-256; khoá bí mật nằm trên máy ở dạng không xuất ra được (F12 không đọc được),
// server giữ khoá công khai trong bản ghi nhân viên. Mọi request sau đó gửi X-Device, X-Timestamp và chữ ký của
// `${timestamp}.${method}.${path+query}`: chép từ F12 sang máy khác không dùng được, chép chữ ký sang đường dẫn khác cũng không.
const SIG_WINDOW_MS = 5 * 60e3;       // chữ ký chỉ có hiệu lực 5 phút (chịu được đồng hồ máy lệch nhẹ)
const BORROWED_TTL_MS = 24 * 3600e3;  // máy mượn: tự hết hạn sau 24 giờ nếu chưa chấm công
const MAX_DEVICES = 10;               // giữ 10 máy kích hoạt gần nhất mỗi người (bản ghi nhân viên không phình mãi)
const ROOT_DEVICES = 'root-devices';  // máy của tài khoản quản trị gốc (ADMIN_KEY)
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function importDeviceKey(pub) {
  return crypto.subtle.importKey('raw', b64d(pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}
async function verifyDevice(req, env, deviceId) {
  const ts = Number(req.headers.get('X-Timestamp')), sig = req.headers.get('X-Signature') || '';
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIG_WINDOW_MS) {
    throw httpError(401, 'Giờ trên máy lệch so với giờ thật. Chỉnh lại giờ máy rồi thử lại.', 'SIGNATURE_EXPIRED', { serverTime: Date.now() });
  }
  const list = await getEmployees(env);
  let owner = list.find(e => e.devices?.some(d => d.id === deviceId)), root = false;
  let dev = owner?.devices.find(d => d.id === deviceId);
  if (!dev) { dev = ((await env.KV.get(ROOT_DEVICES, 'json')) || []).find(d => d.id === deviceId); root = !!dev; }
  if (!dev || (dev.borrowed && Date.now() - dev.at > BORROWED_TTL_MS)) {
    throw httpError(401, 'Máy này đã đăng xuất. Nhập mã kích hoạt để dùng tiếp.', 'DEVICE_REVOKED');
  }
  const url = new URL(req.url);
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importDeviceKey(dev.pub), b64d(sig),
      new TextEncoder().encode(`${ts}.${req.method}.${url.pathname}${url.search}`));
  } catch {}
  if (!ok) {
    await rateLimit(env, 'RL_AUTH', clientIp(req), 'Đăng nhập sai quá nhiều lần. Chờ 1 phút rồi thử lại.');
    throw httpError(401, 'Không xác thực được máy này. Nhập mã kích hoạt để dùng tiếp.', 'INVALID_SIGNATURE');
  }
  const device = { id: dev.id, borrowed: !!dev.borrowed };
  if (root) return { root: true, role: ROLE_ADMIN, name: 'Quản trị hệ thống', device };
  return { ...owner, role: owner.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_EMPLOYEE, device };
}
// Thêm / bỏ máy trong bản ghi (nhân viên hoặc quản trị gốc). 1 lần ghi KV.
async function saveDevices(env, user, fn) {
  if (user.root) {
    const devs = (await env.KV.get(ROOT_DEVICES, 'json')) || [];
    await env.KV.put(ROOT_DEVICES, JSON.stringify(fn(devs).slice(-MAX_DEVICES)));
    return;
  }
  const list = await getEmployees(env);
  const emp = list.find(e => e.code === user.code);
  if (!emp) return;
  emp.devices = fn(emp.devices || []).slice(-MAX_DEVICES);
  await env.KV.put('employees', JSON.stringify(list));
}

async function authenticate(req, env) {
  const deviceId = req.headers.get('X-Device');
  if (deviceId) return verifyDevice(req, env, deviceId);
  const raw = (req.headers.get('X-Access-Code') || '').trim();
  if (!raw) throw httpError(401, 'Chưa nhập mã kích hoạt', 'MISSING_ACCESS_CODE');
  if (env.ADMIN_KEY && raw === env.ADMIN_KEY) return { root: true, role: ROLE_ADMIN, name: 'Quản trị hệ thống' };
  const hash = await sha256(normCode(raw));
  const emp = (await getEmployees(env)).find(e => e.keyHash === hash);
  // chỉ đếm lần nhập sai: người nhập sai nhiều bị chặn, người dùng mã đúng cùng mạng (máy chung ở văn phòng) vẫn vào được
  if (!emp) await rateLimit(env, 'RL_AUTH', clientIp(req), 'Nhập sai mã kích hoạt quá nhiều lần. Chờ 1 phút rồi thử lại.');
  if (!emp) throw httpError(401, 'Mã kích hoạt không đúng hoặc đã được đổi. Liên hệ quản trị viên để lấy mã mới.', 'INVALID_ACCESS_CODE');
  return { ...emp, role: emp.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_EMPLOYEE };
}

const publicEmp = e => ({
  code: e.code, name: e.name, tg: e.tg || '', role: e.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_EMPLOYEE,
  shift: SHIFTS[e.shift] ? e.shift : DEFAULT_SHIFT, descriptors: e.descriptors || [], hasKey: !!e.keyHash, hasAvatar: !!e.hasAvatar,
  devices: (e.devices || []).length,   // số máy đang đăng nhập (không trả khoá công khai)
});

// Mẫu khuôn mặt: tối đa 10 mẫu, mỗi mẫu đúng 128 số hữu hạn (dạng face-api trả về).
// Làm tròn 4 chữ số thập phân: danh sách nhân viên trong KV nhỏ đi ~2 lần, độ lệch khuôn mặt đổi dưới 0.001.
function validDescriptors(d) {
  const ok = Array.isArray(d) && d.length <= 10 && d.every(x => Array.isArray(x) && x.length === 128 && x.every(n => typeof n === 'number' && Number.isFinite(n)));
  if (!ok) throw httpError(400, 'Dữ liệu khuôn mặt không hợp lệ. Chụp lại khuôn mặt rồi lưu.', 'INVALID_FACE_DATA');
  return d.map(x => x.map(n => Math.round(n * 1e4) / 1e4));
}

// Chuẩn hoá một nhân viên từ form hoặc file nhập. Trả lỗi bằng chữ để báo theo từng dòng.
function normEmployee(body) {
  const code = String(body.code ?? '').trim(), name = String(body.name ?? '').trim();
  if (!code || !name) return { error: 'Thiếu mã NV hoặc họ tên' };
  if (code.length > 30 || name.length > 80) return { error: 'Mã NV tối đa 30 ký tự, họ tên tối đa 80 ký tự' };
  const shift = body.shift === undefined || body.shift === '' ? DEFAULT_SHIFT : String(body.shift);
  if (!SHIFTS[shift]) return { error: `Ca "${shift}" không hợp lệ (dùng sang hoặc toi)` };
  return { emp: {
    code, name, shift,
    role: Number(body.role) === ROLE_ADMIN ? ROLE_ADMIN : ROLE_EMPLOYEE,
    tg: String(body.tg ?? '').replace(/^@/, '').trim().slice(0, 40),
  } };
}

// Ảnh đại diện gửi dạng data URL (JPEG/WebP đã thu nhỏ ở máy)
function parseAvatar(dataUrl) {
  const m = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw httpError(400, 'Ảnh đại diện phải là JPEG hoặc WebP', 'INVALID_AVATAR');
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.length > AVATAR_MAX_BYTES) throw httpError(400, `Ảnh đại diện quá lớn (${Math.round(bytes.length / 1024)}KB, tối đa ${AVATAR_MAX_BYTES / 1024}KB)`, 'AVATAR_TOO_LARGE');
  return { type: m[1], bytes };
}

// ---------------- Giới hạn tần suất ----------------
// Workers Rate Limiting (binding trong wrangler.toml, không tốn KV). Chưa có binding (chạy thử, test) thì không chặn.
const clientIp = req => req.headers.get('CF-Connecting-IP') || 'local';
async function rateLimit(env, binding, key, message) {
  if (!env[binding]) return;
  const { success } = await env[binding].limit({ key });
  if (!success) throw httpError(429, message, 'RATE_LIMITED', { retryAfter: 60 });
}

// ---------------- API ----------------
async function api(req, env, url) {
  const p = url.pathname, m = req.method;
  await rateLimit(env, 'RL_IP', clientIp(req), 'Quá nhiều yêu cầu từ mạng này. Chờ 1 phút rồi thử lại.');
  const user = await authenticate(req, env);
  const isAdmin = user.role === ROLE_ADMIN;
  const needAdmin = () => { if (!isAdmin) throw httpError(403, 'Chỉ quản trị viên được dùng chức năng này', 'ADMIN_ONLY'); };

  // Kích hoạt máy: gửi mã kích hoạt (X-Access-Code) một lần cùng khoá công khai của máy
  if (p === '/api/devices' && m === 'POST') {
    if (user.device) throw httpError(400, 'Máy này đã đăng nhập', 'ALREADY_ACTIVATED');
    const { pub, borrowed = false } = await req.json();
    try { if (typeof pub !== 'string' || b64d(pub).length !== 65) throw 0; await importDeviceKey(pub); }
    catch { throw httpError(400, 'Khoá của máy không hợp lệ. Tải lại trang rồi kích hoạt lại.', 'INVALID_DEVICE_KEY'); }
    const dev = { id: 'd_' + [...crypto.getRandomValues(new Uint8Array(10))].map(b => b.toString(16).padStart(2, '0')).join(''), pub, at: Date.now() };
    if (borrowed) dev.borrowed = true;
    await saveDevices(env, user, devs => [...devs, dev]);
    return json({ ok: true, deviceId: dev.id, me: user.root ? { root: true, role: ROLE_ADMIN, name: user.name } : publicEmp(user) });
  }
  // Đăng xuất: không có ?code thì thu hồi máy đang dùng; quản trị viên gửi ?code=NV01 để đăng xuất mọi máy của người đó
  if (p === '/api/devices' && m === 'DELETE') {
    const code = url.searchParams.get('code');
    if (code) {
      needAdmin();
      const list = await getEmployees(env);
      const emp = list.find(e => e.code === code);
      if (!emp) throw httpError(404, 'Không có nhân viên ' + code);
      emp.devices = [];
      await env.KV.put('employees', JSON.stringify(list));
      return json({ ok: true });
    }
    if (!user.device) throw httpError(400, 'Request này không đến từ máy đã đăng nhập', 'NOT_A_DEVICE');
    await saveDevices(env, user, devs => devs.filter(d => d.id !== user.device.id));
    return json({ ok: true });
  }

  if (p === '/api/me' && m === 'GET') {
    return json(user.root ? { root: true, role: ROLE_ADMIN, name: user.name } : publicEmp(user));
  }

  if (p === '/api/employees' && m === 'GET') {
    needAdmin();
    return json((await getEmployees(env)).map(publicEmp));
  }

  if (p === '/api/employees' && m === 'PUT') {
    needAdmin();
    const body = await req.json();
    const { emp: base, error } = normEmployee(body);
    if (error) throw httpError(400, error);
    const code = base.code;
    if (user.code === code && base.role !== ROLE_ADMIN) throw httpError(400, 'Không thể tự bỏ quyền quản trị của chính mình');
    const list = await getEmployees(env);
    const old = list.find(e => e.code === code);
    const avatar = body.avatar ? parseAvatar(body.avatar) : null;
    const emp = {
      ...base,
      descriptors: body.descriptors === undefined ? old?.descriptors || [] : validDescriptors(body.descriptors),
      keyHash: old?.keyHash,
      hasAvatar: avatar ? true : !!old?.hasAvatar,
      devices: old?.devices || [],
    };
    let accessCode;
    if (!emp.keyHash) { accessCode = newAccessCode(); emp.keyHash = await sha256(normCode(accessCode)); }
    if (avatar) await env.KV.put('avatar:' + code, avatar.bytes, { metadata: { type: avatar.type } });
    const next = list.filter(e => e.code !== code).concat(emp).sort((a, b) => a.code.localeCompare(b.code));
    await env.KV.put('employees', JSON.stringify(next));
    return json({ ok: true, employee: publicEmp(emp), accessCode });
  }

  // Nhập nhiều nhân viên một lần (1 lần ghi KV cho cả danh sách)
  if (p === '/api/employees/import' && m === 'POST') {
    needAdmin();
    const { rows, update = false } = await req.json();
    if (!Array.isArray(rows) || !rows.length) throw httpError(400, 'Danh sách trống');
    if (rows.length > IMPORT_MAX_ROWS) throw httpError(400, `Tối đa ${IMPORT_MAX_ROWS} người mỗi lần nhập`);
    const list = await getEmployees(env);
    const byCode = new Map(list.map(e => [e.code, e]));
    const seen = new Set(), created = [], updated = [], skipped = [], errors = [];
    for (const [i, row] of rows.entries()) {
      const { emp, error } = normEmployee(row);
      if (error) { errors.push({ row: i + 1, error }); continue; }
      if (seen.has(emp.code)) { errors.push({ row: i + 1, error: `Mã ${emp.code} bị trùng trong file` }); continue; }
      seen.add(emp.code);
      const old = byCode.get(emp.code);
      if (old) {
        if (!update) { skipped.push({ code: emp.code, reason: 'Đã có' }); continue; }
        if (user.code === emp.code && emp.role !== ROLE_ADMIN) { errors.push({ row: i + 1, error: 'Không thể tự bỏ quyền quản trị của chính mình' }); continue; }
        byCode.set(emp.code, { ...old, ...emp });
        updated.push(emp.code);
      } else {
        const accessCode = newAccessCode();
        byCode.set(emp.code, { ...emp, descriptors: [], keyHash: await sha256(normCode(accessCode)) });
        created.push({ code: emp.code, name: emp.name, accessCode });
      }
    }
    if (created.length || updated.length) {
      await env.KV.put('employees', JSON.stringify([...byCode.values()].sort((a, b) => a.code.localeCompare(b.code))));
    }
    return json({ ok: true, created, updated, skipped, errors });
  }

  if (p === '/api/avatar' && m === 'GET') {
    const code = url.searchParams.get('code');
    if (!isAdmin && code !== user.code) throw httpError(403, 'Chỉ xem được ảnh đại diện của mình');
    const { value, metadata } = await env.KV.getWithMetadata('avatar:' + code, 'arrayBuffer');
    if (!value) throw httpError(404, 'Chưa có ảnh đại diện');
    return new Response(value, { headers: { 'Content-Type': metadata?.type || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
  }

  if (p === '/api/employees/code' && m === 'POST') {
    needAdmin();
    const code = url.searchParams.get('code');
    const list = await getEmployees(env);
    const emp = list.find(e => e.code === code);
    if (!emp) throw httpError(404, 'Không có nhân viên ' + code);
    if (user.code === code) throw httpError(400, 'Không thể tự đổi mã đang đăng nhập. Nhờ quản trị viên khác đổi giúp.');
    const accessCode = newAccessCode();
    emp.keyHash = await sha256(normCode(accessCode));
    emp.devices = [];   // mã cũ hết hiệu lực thì các máy đã kích hoạt bằng mã đó cũng đăng xuất
    await env.KV.put('employees', JSON.stringify(list));
    return json({ ok: true, accessCode });
  }

  if (p === '/api/employees' && m === 'DELETE') {
    needAdmin();
    const code = url.searchParams.get('code');
    if (user.code === code) throw httpError(400, 'Không thể tự xoá tài khoản đang đăng nhập');
    const list = (await getEmployees(env)).filter(e => e.code !== code);
    await env.KV.put('employees', JSON.stringify(list));
    await env.KV.delete('avatar:' + code);
    await env.KV.delete(stateKey(code));
    return json({ ok: true });
  }

  // Ca đang mở của người đăng nhập (để app biết check-in hay check-out, kể cả ca tối qua nửa đêm)
  if (p === '/api/status' && m === 'GET') {
    if (user.root) return json({ open: null });
    const now = Date.now();
    const st = await loadState(env, user.code, now + 1);   // +1: tính cả lượt vừa chấm đúng lúc này
    const open = isActive(env, st, now + 1) ? {
      shift: st.shift, shiftDate: st.date, ts: st.inTs, time: st.inTime, outs: st.outs.length, lastOut: st.outs.at(-1) ?? null,
    } : null;
    const last = st ? { shift: st.shift, shiftDate: st.date } : null;   // ca đã check-in gần nhất: không check-in lại
    return json({ open, last, shift: publicEmp(user).shift });
  }

  if (p === '/api/punch' && m === 'POST') {
    if (user.root) throw httpError(403, 'Tài khoản quản trị gốc không chấm công. Đăng nhập bằng mã của nhân viên.', 'ROOT_CANNOT_PUNCH');
    return punch(req, env, user);
  }

  if (p === '/api/logs' && m === 'GET') {
    needAdmin();   // mỗi ngày hỏi tốn 1 lệnh list KV (free 1.000/ngày); app chỉ dùng ở Bảng công
    const today = ymd(localNow(env));
    const from = url.searchParams.get('from') || today;
    const to = url.searchParams.get('to') || from;
    const days = dateRange(from, to);
    if (days.length > 62) throw httpError(400, 'Tối đa 62 ngày');
    return json(await logsOfRange(env, days));
  }

  if (p === '/api/photo' && m === 'GET') {
    needAdmin();
    const f = await tg(env, 'getFile', { file_id: url.searchParams.get('id') });
    const r = await fetch(`${tgBase(env)}/file/bot${env.BOT_TOKEN}/${f.file_path}`);
    return new Response(r.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
  }

  if (p === '/api/setup' && m === 'POST') {
    needAdmin();
    await rateLimit(env, 'RL_ACTION', 'setup', 'Vừa kết nối bot. Chờ 1 phút rồi thử lại.');
    await tg(env, 'setWebhook', {
      url: `${url.origin}/telegram/webhook`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message'],
    });
    await tg(env, 'setMyCommands', { commands: [
      { command: 'homnay', description: 'Tổng hợp chấm công hôm nay' },
      { command: 'chatid', description: 'Xem id của group này' },
      { command: 'help', description: 'Hướng dẫn' },
    ] });
    const me = await tg(env, 'getMe', {});
    return json({ ok: true, bot: me.username, chat: env.TELEGRAM_CHAT_ID || null });
  }

  if (p === '/api/report-now' && m === 'POST') {
    needAdmin();
    await rateLimit(env, 'RL_ACTION', 'report', 'Vừa gửi tổng hợp vào group. Chờ 1 phút rồi gửi lại.');
    // gửi giữa ngày: dùng mẫu "đang làm việc", không gọi người chưa ra là "quên check-out"
    const text = await buildSummary(env, ymd(localNow(env)));
    await tg(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    return json({ ok: true });
  }

  throw httpError(404, 'Không tìm thấy');
}

// Các lượt của một người trong ngày công hôm nay và hôm qua (đủ để thấy ca tối đang mở qua nửa đêm)
async function recentLogs(env, code, ts, { fresh = false } = {}) {
  const today = ymd(new Date(ts + offsetMs(env)));
  const days = [addDays(today, -1), today];
  const logs = [];
  for (const d of days) logs.push(...await logsOfDay(env, d, { fresh }));
  return logs.filter(l => l.code === code).sort((a, b) => a.ts - b.ts);
}
// Trạng thái ca của từng người lưu trong một key riêng `state:<mã NV>`.
// Không dựa vào KV.list: list của KV có thể chậm tới ~60 giây, làm app hiện lại nút Check-in
// ngay sau khi vừa check-in và cho check-in trùng. Đọc một key thì thấy ngay giá trị vừa ghi.
const stateKey = code => 'state:' + code;
const logKey = (date, ts, code) => `log:${date}:${ts}:${code}`;
// Hết ngày công của một ca: ca sáng hết lúc 00:00 hôm sau; ca tối (qua đêm) hết lúc 12:00 trưa hôm sau,
// là mốc từ đó check-in ca tối được tính cho ngày công mới (giống shiftDateFor). Giữ giống dayEndsAt trong public/shifts.js.
function dayEndTs(env, date, shift) {
  const s = SHIFTS[shift] || SHIFTS[DEFAULT_SHIFT];
  return Date.parse(`${addDays(date, 1)}T${s.overnight ? '12:00' : '00:00'}:00Z`) - offsetMs(env);
}
// Còn check-out được (lần đầu hoặc tăng ca): đã check-in, chưa đủ 3 lần ra, chưa hết ngày công của ca
function isActive(env, st, ts) {
  return !!st?.inTs && st.outs.length < OUTS_MAX && ts < dayEndTs(env, st.date, st.shift);
}
async function loadState(env, code, ts) {
  const st = await env.KV.get(stateKey(code), 'json');
  if (st) return st.inTs ? st : null;
  // người chưa có bản ghi trạng thái (chấm công từ bản cũ): dựng lại một lần từ lịch sử rồi lưu
  let logs;
  try { logs = await recentLogs(env, code, ts, { fresh: true }); }
  catch { return null; }   // hết hạn mức list KV: coi như chưa vào ca, không chặn chấm công; lần sau thử dựng lại
  const lastIn = logs.filter(l => l.type === 'in' && l.ts < ts).at(-1);
  const derived = lastIn ? {
    shift: shiftOf(lastIn), date: lastIn.date, inTs: lastIn.ts, inTime: lastIn.time,
    outs: logs.filter(l => l.type === 'out' && l.ts > lastIn.ts && l.ts < ts).map(l => l.ts),
  } : null;
  await env.KV.put(stateKey(code), JSON.stringify(derived || { none: true }));
  return derived;
}
// Ngày công của lượt vào: ca qua đêm vào sau nửa đêm (đến muộn) vẫn tính cho ngày hôm trước
function shiftDateFor(shift, localDate, localHour) {
  return SHIFTS[shift].overnight && localHour < 12 ? addDays(localDate, -1) : localDate;
}
const shiftStartTs = (env, date, shift) => Date.parse(`${date}T${SHIFTS[shift].start}:00Z`) - offsetMs(env);

// Vị trí: GPS do máy gửi; không có thì dùng vị trí ước lượng theo mạng của Cloudflare (request.cf)
function readLocation(form, cf) {
  const lat = Number(form.get('lat')), lng = Number(form.get('lng')), acc = Number(form.get('acc'));
  if (form.get('lat') && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && Number.isFinite(lat) && Number.isFinite(lng)) {
    return { src: 'gps', lat: +lat.toFixed(5), lng: +lng.toFixed(5), acc: Number.isFinite(acc) ? Math.round(acc) : null };
  }
  const place = [cf?.city, cf?.country].filter(Boolean).join(', ');
  return place ? { src: 'net', place: place.slice(0, 60) } : null;
}
function locationText(loc) {
  if (!loc) return '📍 Vị trí: không xác định';
  if (loc.src === 'gps') return `📍 Vị trí: <a href="https://maps.google.com/?q=${loc.lat},${loc.lng}">${loc.lat}, ${loc.lng}</a>${loc.acc !== null ? ` (±${loc.acc} m)` : ''}`;
  return `📍 Vị trí (theo mạng, không có GPS): ${esc(loc.place)}`;
}
// dạng gọn để lưu trong metadata KV (giới hạn 1024 byte)
const locShort = loc => !loc ? undefined : loc.src === 'gps' ? `${loc.lat},${loc.lng}${loc.acc !== null ? ',' + loc.acc : ''}` : 'net:' + loc.place;

async function punch(req, env, emp) {
  await rateLimit(env, 'RL_PUNCH', emp.code, 'Chấm công quá nhanh. Chờ 1 phút rồi thử lại.');
  const form = await req.formData();
  const code = emp.code, type = form.get('type'), photo = form.get('photo');   // luôn chấm cho chính người đăng nhập
  if (!['in', 'out'].includes(type)) throw httpError(400, 'Loại không hợp lệ');
  if (!photo || typeof photo === 'string') throw httpError(400, 'Thiếu ảnh');

  // Thời điểm chụp do thiết bị gửi (để bản ghi gửi trễ khi mất mạng vẫn đúng giờ)
  const now = Date.now();
  let ts = Number(form.get('ts')) || now;
  if (ts > now + 5 * 60e3) ts = now;   // đồng hồ máy chạy nhanh
  if (ts < now - MAX_DELAY_MS) throw httpError(400, 'Lượt chấm công này chụp hơn 24 giờ trước nên không được ghi nhận. Báo quản lý để chấm bù.', 'PUNCH_TOO_OLD');
  const local = new Date(ts + offsetMs(env));
  const day = ymd(local), time = hms(local);

  const st = await loadState(env, code, ts);
  // Ca và ngày công: lượt vào lấy ca do nhân viên chọn; lượt ra thuộc ca đang mở
  let shift, date, outNo = 0, repair = false;
  if (st && (st.inTs === ts || st.outs.includes(ts))) {
    // App gửi lại đúng lượt đã ghi trạng thái. Có bản ghi rồi (mất phản hồi giữa chừng): trả OK, không gửi ảnh lần hai.
    // Chưa có bản ghi (lỗi sau khi ghi trạng thái): gửi ảnh và ghi bản ghi, giữ nguyên trạng thái.
    shift = st.shift; date = st.date; outNo = st.inTs === ts ? 0 : st.outs.indexOf(ts) + 1;
    if ((await env.KV.getWithMetadata(logKey(date, ts, code))).metadata) return json({ ok: true, duplicate: true });
    repair = true;
  } else if (type === 'in') {
    shift = String(form.get('shift') || '');
    if (!SHIFTS[shift]) throw httpError(400, 'Chọn ca làm việc trước khi check-in', 'SHIFT_REQUIRED');
    if (!isShiftOpen(shift, local.getUTCHours() * 60 + local.getUTCMinutes())) {
      throw httpError(400, `${SHIFTS[shift].name} chỉ check-in từ ${opensAt(shift)} đến ${SHIFTS[shift].end}.`, 'SHIFT_CLOSED');
    }
    // chưa check-out ca đang làm thì không vào ca khác; đã check-out rồi thì ca đó kết thúc, vào ca khác được
    if (isActive(env, st, ts) && !st.outs.length) throw httpError(409, `${emp.name} đang trong ${SHIFTS[st.shift].name} từ ${st.inTime.slice(0, 5)}. Bấm Check-out.`, 'SHIFT_IN_PROGRESS');
    date = shiftDateFor(shift, day, local.getUTCHours());
    if (st && st.date === date && st.shift === shift) {
      throw httpError(409, `${emp.name} đã check-in ${SHIFTS[shift].name} ngày ${dmy(date)} lúc ${st.inTime.slice(0, 5)}. Mỗi ca chỉ check-in 1 lần.`, 'ALREADY_CHECKED_IN');
    }
  } else {
    const within = st?.inTs && ts < dayEndTs(env, st.date, st.shift);
    if (within && st.outs.length >= OUTS_MAX) throw httpError(409, `${emp.name} đã check-out đủ ${OUTS_MAX} lần cho ${SHIFTS[st.shift].name} này.`, 'CHECKOUT_LIMIT');
    if (!isActive(env, st, ts)) throw httpError(409, `${emp.name} chưa check-in${st?.inTs && !st.outs.length ? ` (lượt vào ${SHIFTS[st.shift].name} ngày ${dmy(st.date)} đã quá hạn check-out, ngày đó không được tính công)` : ''}`, 'NOT_CHECKED_IN');
    if (ts <= Math.max(st.inTs, ...st.outs)) throw httpError(409, 'Giờ check-out phải sau lần chấm công trước.', 'CHECKOUT_ORDER');
    shift = st.shift; date = st.date; outNo = st.outs.length + 1;
  }

  const grace = Number(env.LATE_GRACE_MIN || 0) * 60e3;
  const late = type === 'in' && ts > shiftStartTs(env, date, shift) + grace;
  const delayed = now - ts > DELAYED_MS;
  const loc = readLocation(form, req.cf);
  const s = SHIFTS[shift];
  const caption = [
    `${type === 'in' ? '🟢 <b>CHECK-IN</b>' : `🔴 <b>CHECK-OUT</b> (lần ${outNo}/${OUTS_MAX})`} · ${s.name} ${s.start}–${s.end}${date !== day ? ` (ngày ${dmy(date)})` : ''}`,
    `🕒 Thời gian: ${dmy(day)} ${time.slice(0, 5)}`,
    `🪪 Mã NV: ${esc(code)}`,
    `👤 Họ tên: ${esc(emp.name)}${emp.tg ? ' @' + esc(emp.tg) : ''}`,
    locationText(loc),
    late ? `⚠️ Đi muộn (ca bắt đầu ${s.start})` : '',
    delayed ? '📶 Gửi trễ do mất mạng' : '',
  ].filter(Boolean).join('\n');

  const fd = new FormData();
  fd.append('chat_id', env.TELEGRAM_CHAT_ID);
  fd.append('caption', caption);
  fd.append('parse_mode', 'HTML');
  fd.append('photo', photo, `${code}_${type}_${ts}.jpg`);
  // Ghi trạng thái trước khi gửi ảnh: ghi KV lỗi thì dừng ở đây, chưa có ảnh nào lên group,
  // nên app gửi lại 30 giây/lần cũng không tạo ảnh lặp. Gửi ảnh lỗi thì trả lại trạng thái cũ.
  if (!repair) await env.KV.put(stateKey(code), JSON.stringify(type === 'in'
    ? { shift, date, inTs: ts, inTime: time, outs: [] }
    : { ...st, outs: [...st.outs, ts] }));
  let msg;
  try { msg = await tg(env, 'sendPhoto', fd); }
  catch (e) {
    if (!repair) await env.KV.put(stateKey(code), JSON.stringify(st || { none: true })).catch(() => {});
    throw e;
  }

  const meta = {
    code, name: emp.name.slice(0, 80), type, ts, time, shift, outNo: outNo || undefined,
    day: day !== date ? day : undefined,       // ngày thật của lượt (khi khác ngày công, vd ra ca tối sau nửa đêm)
    late: late || undefined,
    // gửi trễ: lưu cả giờ server nhận để quản lý đối chiếu trong Bảng công
    delayed: delayed || undefined, received: delayed ? hms(new Date(now + offsetMs(env))).slice(0, 5) : undefined,
    loc: locShort(loc),
    msg: msg.message_id, photo: msg.photo[msg.photo.length - 1].file_id,
  };
  await env.KV.put(logKey(date, ts, code), '', { metadata: meta, expirationTtl: LOG_TTL });
  await forgetDay(date);
  // máy mượn: chấm công xong thì đăng xuất máy đó
  if (emp.device?.borrowed) {
    await saveDevices(env, emp, devs => devs.filter(d => d.id !== emp.device.id));
    return json({ ok: true, record: { ...meta, date }, signedOut: true });
  }
  return json({ ok: true, record: { ...meta, date } });
}

// ---------------- Bot ----------------
async function telegramWebhook(req, env) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const update = await req.json();
  const msg = update.message;
  const text = msg?.text || '';
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const chatId = String(msg?.chat?.id || '');
  const reply = t => tg(env, 'sendMessage', { chat_id: chatId, text: t, parse_mode: 'HTML', reply_to_message_id: msg.message_id });

  if (cmd === '/chatid') await reply(`Chat id: <code>${chatId}</code>`);
  else if (chatId !== String(env.TELEGRAM_CHAT_ID)) { /* bỏ qua chat lạ */ }
  else if (cmd === '/homnay') await reply(await buildSummary(env, ymd(localNow(env))));
  else if (cmd === '/help' || cmd === '/start') await reply(
    '🤖 Bot chấm công\n/homnay — ai đã vào/ra hôm nay (cả hai ca)\n/chatid — id của group\n\n' +
    `Tự động: 09:00 nhắc ca sáng, 18:30 tổng hợp ca sáng, 23:00 nhắc ca tối, 07:00 tổng hợp ca tối hôm trước.`);
  return new Response('ok');
}

// Ai cần có mặt ở một ca: người có ca thường làm là ca đó, cộng người đã check-in ca đó
async function shiftStatus(env, date, shift) {
  const [emps, logs] = await Promise.all([getEmployees(env), logsOfDay(env, date)]);
  const rows = [];
  for (const emp of emps) {
    const mine = logs.filter(l => l.code === emp.code && shiftOf(l) === shift);
    if (!mine.length && publicEmp(emp).shift !== shift) continue;
    // giờ làm: từ lúc vào tới lần check-out cuối (mỗi ca có thể check-out tối đa 3 lần)
    const first = mine.find(l => l.type === 'in') || null;
    const last = first ? mine.filter(l => l.type === 'out' && l.ts > first.ts).at(-1) || null : null;
    rows.push({ emp, first, last, ms: last ? last.ts - first.ts : 0 });
  }
  return rows;
}

async function shiftReminder(env, date, shift) {
  const st = await shiftStatus(env, date, shift), s = SHIFTS[shift];
  if (!st.length) return;
  const missing = st.filter(r => !r.first);
  const text = missing.length
    ? `⏰ <b>Nhắc check-in ${s.name} ${dmy(date)}</b> (${s.start}–${s.end})\nChưa check-in (${missing.length}/${st.length}):\n` + missing.map(r => '• ' + who(r.emp)).join('\n')
    : `✅ ${s.name} ${dmy(date)}: tất cả ${st.length} người đã check-in.`;
  await tg(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
}

async function shiftSummary(env, date, shift) {
  const st = await shiftStatus(env, date, shift);
  if (!st.length) return;
  const text = `📊 <b>Chấm công ${dmy(date)}</b>\n` + shiftSection(st, shift, true) + '\n\nNếu quên, vui lòng báo quản lý để điều chỉnh.';
  await tg(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
}

// /homnay và "Gửi tổng hợp ngay": cả hai ca của ngày, không gọi người đang làm là "quên check-out"
async function buildSummary(env, date) {
  const parts = [`📊 <b>Chấm công ${dmy(date)}</b>`];
  for (const shift of Object.keys(SHIFTS)) {
    const st = await shiftStatus(env, date, shift);
    if (st.length) parts.push(shiftSection(st, shift, false));
  }
  if (parts.length === 1) parts.push('\nChưa có nhân viên nào.');
  return parts.join('\n');
}

function shiftSection(st, shift, final) {
  const s = SHIFTS[shift];
  const done = st.filter(r => r.first && r.last);
  const working = st.filter(r => r.first && !r.last);
  const absent = st.filter(r => !r.first);
  const late = st.filter(r => r.first?.late);
  const line = r => `• ${esc(r.emp.name)}: ${r.first.time.slice(0, 5)} → ${r.last ? r.last.time.slice(0, 5) : '…'}` +
    (r.ms ? ` (${hours(r.ms)})` : '') + (r.first.late ? ' ⚠️muộn' : '');
  const parts = [`\n<b>${s.name} ${s.start}–${s.end}</b> — ${st.length - absent.length}/${st.length} người có mặt`];
  if (done.length) parts.push(`✅ <b>Đã vào & ra (${done.length})</b>\n` + done.map(line).join('\n'));
  if (working.length) parts.push(final
    ? `🚨 <b>Quên check-out (${working.length})</b> — chưa check-out trước ${s.overnight ? '12:00 trưa nay' : '24:00 hôm nay'} sẽ không được tính công\n` + working.map(r => `• ${who(r.emp)} — vào ${r.first.time.slice(0, 5)}`).join('\n')
    : `🟢 <b>Đang làm việc (${working.length})</b>\n` + working.map(line).join('\n'));
  if (absent.length) parts.push(`${final ? '🚨' : '⚪'} <b>Chưa check-in (${absent.length})</b>\n` +
    absent.map(r => '• ' + (final ? who(r.emp) : esc(r.emp.name))).join('\n'));
  if (late.length) parts.push(`⏱ Đi muộn: ${late.length} người`);
  return parts.join('\n');
}

// ---------------- Lưu trữ ----------------
async function getEmployees(env) {
  return (await env.KV.get('employees', 'json')) || [];
}

// Đọc bảng công qua Cache API của Workers (miễn phí, không tính vào giới hạn 1.000 lệnh liệt kê KV/ngày).
// Ngày hôm nay giữ 60 giây và bị xoá ngay khi có lượt chấm mới; ngày đã qua giữ 1 giờ.
// fresh: bỏ qua cache (dùng khi kiểm tra thứ tự vào/ra lúc chấm công).
const dayCacheKey = date => new Request(`https://cache.timesheet.internal/logs/${date}`);
async function forgetDay(date) {
  await globalThis.caches?.default?.delete(dayCacheKey(date));
}
// Ngày công đã khoá: qua 12:00 trưa hôm sau (hết ca tối) thêm 24 giờ cho lượt gửi trễ thì không nhận thêm lượt nào.
// Ngày đã khoá lưu thành một key `day:<ngày>` (đọc bằng get, hạn mức 100k/ngày) để không phải list lại.
const dayKey = date => 'day:' + date;
const isLocked = (env, date) => Date.now() > dayEndTs(env, date, 'toi') + MAX_DELAY_MS;
async function listLogs(env, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await env.KV.list({ prefix, cursor });
    for (const k of r.keys) if (k.metadata) out.push({ ...k.metadata, date: k.name.slice(4, 14) });
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out.sort((a, b) => a.ts - b.ts);
}
// Lịch sử nhiều ngày (Bảng công): ngày đã khoá đọc ảnh chụp; chưa có thì list theo tháng (1 lệnh cho tới 1.000 lượt)
// thay vì mỗi ngày một lệnh, rồi lưu ảnh chụp. Ngày chưa khoá (hôm nay, hôm qua) vẫn list như cũ.
async function logsOfRange(env, days) {
  const got = new Map();
  const locked = days.filter(d => isLocked(env, d));
  await Promise.all(locked.map(async d => { const snap = await env.KV.get(dayKey(d), 'json'); if (snap) got.set(d, snap); }));
  const byMonth = new Map();
  for (const d of locked) if (!got.has(d)) byMonth.set(d.slice(0, 7), [...(byMonth.get(d.slice(0, 7)) || []), d]);
  for (const [month, ds] of byMonth) {
    const logs = ds.length > 1 ? await listLogs(env, `log:${month}-`) : await listLogs(env, `log:${ds[0]}:`);
    for (const d of ds) {
      const mine = logs.filter(l => l.date === d);
      got.set(d, mine);
      await env.KV.put(dayKey(d), JSON.stringify(mine));
    }
  }
  const out = [];
  for (const d of days) out.push(...(got.get(d) || await logsOfDay(env, d)));
  return out;
}
async function logsOfDay(env, date, { fresh = false } = {}) {
  const cache = globalThis.caches?.default;
  if (cache && !fresh) {
    const hit = await cache.match(dayCacheKey(date));
    if (hit) return hit.json();
  }
  const out = await listLogs(env, `log:${date}:`);
  if (cache) {
    const maxAge = date < ymd(localNow(env)) ? 3600 : 60;
    await cache.put(dayCacheKey(date), new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${maxAge}` } }));
  }
  return out;
}

function isHoliday(env, date) {
  return String(env.HOLIDAYS || '').split(',').map(s => s.trim()).includes(date);
}

// ---------------- Telegram ----------------
const tgBase = env => env.TELEGRAM_API || 'https://api.telegram.org'; // đổi được khi chạy thử

async function tg(env, method, body) {
  if (!env.BOT_TOKEN) throw httpError(500, 'Chưa cấu hình BOT_TOKEN', 'CONFIG_MISSING');
  const init = body instanceof FormData
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  // Telegram giới hạn ~20 tin/phút mỗi group: bị báo 429 thì chờ đúng số giây yêu cầu rồi gửi lại (tối đa 2 lần)
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${tgBase(env)}/bot${env.BOT_TOKEN}/${method}`, init);
    const data = await r.json();
    if (data.ok) return data.result;
    const wait = data.parameters?.retry_after;
    if (data.error_code === 429 && wait !== undefined && attempt < 2 && wait <= 10) {
      await new Promise(res => setTimeout(res, wait * 1000));
      continue;
    }
    throw data.error_code === 429
      ? httpError(503, 'Telegram đang giới hạn tốc độ gửi, lượt này sẽ được gửi lại sau.', 'TELEGRAM_BUSY')
      : httpError(502, 'Telegram: ' + data.description, 'TELEGRAM_ERROR');
  }
}

// ---------------- Tiện ích ----------------
const pad = n => String(n).padStart(2, '0');
const offsetMs = env => Number(env.TZ_OFFSET || 7) * 3600e3;
const localNow = env => new Date(Date.now() + offsetMs(env));
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const hms = d => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const dmy = s => s.split('-').reverse().join('/');
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const hours = ms => `${Math.floor(ms / 3600e3)}g${pad(Math.floor(ms / 60e3) % 60)}`;
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const who = e => esc(e.name) + (e.tg ? ` @${esc(e.tg)}` : '');

function dateRange(from, to) {
  const out = [];
  for (let d = new Date(from + 'T00:00:00Z'); ymd(d) <= to && out.length < 100; d.setUTCDate(d.getUTCDate() + 1)) out.push(ymd(d));
  return out;
}
// Lỗi có chủ đích: status HTTP, mã lỗi cho máy đọc (code) và câu báo cho người dùng (message).
function httpError(status, message, code = DEFAULT_CODES[status] || 'ERROR', extra = {}) {
  return Object.assign(new Error(message), { status, code, expose: true }, extra);
}
const DEFAULT_CODES = {
  400: 'INVALID_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT',
  429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR', 502: 'UPSTREAM_ERROR', 503: 'UPSTREAM_BUSY',
};
// Mọi lỗi trả về cùng một dạng: { error, code, status, requestId } + header X-Request-Id (Retry-After khi bị giới hạn).
// Lỗi ngoài dự kiến (KV, lỗi code…) không lộ chi tiết nội bộ ra ngoài: ghi log kèm requestId để tra trong Observability.
function errorResponse(e, req) {
  const requestId = req.headers.get('cf-ray') || crypto.randomUUID().slice(0, 13);
  if (e instanceof SyntaxError && !e.expose) e = httpError(400, 'Dữ liệu gửi lên không đúng định dạng');
  if (!e.expose) {
    console.error(JSON.stringify({ requestId, path: new URL(req.url).pathname, error: String(e?.stack || e) }));
    e = httpError(500, 'Máy chủ gặp lỗi, thử lại sau ít phút. Nếu lặp lại, gửi mã tra cứu cho quản trị viên.');
  }
  const body = { error: e.message, code: e.code, status: e.status, requestId };
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': requestId };
  if (e.retryAfter) { body.retryAfter = e.retryAfter; headers['Retry-After'] = String(e.retryAfter); }
  if (e.serverTime) body.serverTime = e.serverTime;   // SIGNATURE_EXPIRED: app chỉnh lệch đồng hồ rồi gửi lại
  return new Response(JSON.stringify(body), { status: e.status, headers });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
