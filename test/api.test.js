// Test backend (src/worker.js): chạy Worker thật trong Node, với KV trong bộ nhớ và Telegram giả lập.
// Chạy: npm test. Test ghi "Lỗi đã gặp" tái hiện lỗi đã tìm ra, không được xoá.
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// ---------- Môi trường giả lập ----------
class MemKV {
  constructor() { this.m = new Map(); this.lists = 0; this.listLag = false; this.hidden = new Set(); }
  async get(k, type) { const v = this.m.get(k); return v ? (type === 'json' ? JSON.parse(v.value) : v.value) : null; }
  async put(k, value, opts = {}) {
    if (this.putFail?.(k)) throw new Error('KV put() limit exceeded for the day.');   // hết 1.000 lần ghi/ngày hoặc KV lỗi
    this.puts = (this.puts || 0) + 1; this.m.set(k, { value, metadata: opts.metadata });
    if (this.listLag) this.hidden.add(k);   // KV thật: key mới có thể chưa hiện trong list
  }
  async getWithMetadata(k) { const v = this.m.get(k); return { value: v ? v.value : null, metadata: v?.metadata ?? null }; }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = '', cursor } = {}) {
    if (this.listFail) throw new Error('KV list() limit exceeded for the day.');   // hết hạn mức 1.000 lần/ngày
    this.lists++;
    const keys = [...this.m.keys()].filter(k => k.startsWith(prefix) && !this.hidden.has(k)).sort();
    const start = cursor ? Number(cursor) : 0, page = keys.slice(start, start + 1000), done = start + 1000 >= keys.length;
    return { keys: page.map(name => ({ name, metadata: this.m.get(name).metadata })), list_complete: done, cursor: done ? undefined : String(start + 1000) };
  }
}

// Workers Rate Limiting giả lập: đếm theo key, không tự đặt lại (đủ cho một test)
class FakeRL {
  constructor(limit) { this.max = limit; this.n = new Map(); }
  async limit({ key }) { const n = (this.n.get(key) || 0) + 1; this.n.set(key, n); return { success: n <= this.max }; }
}

let env, tgCalls, realFetch, msgId, tgFailNext;
const ROOT = 'root-test-key';
beforeEach(() => {
  env = {
    KV: new MemKV(), ADMIN_KEY: ROOT, BOT_TOKEN: 'tok', WEBHOOK_SECRET: 'hook', TELEGRAM_CHAT_ID: '-100777',
    TELEGRAM_API: 'http://tg.test', TZ_OFFSET: '7', LATE_GRACE_MIN: '30',
    ASSETS: { fetch: async () => new Response('asset') },
  };
  tgCalls = []; msgId = 100; tgFailNext = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = String(url).split('/').pop();
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body].map(([k, v]) => [k, typeof v === 'string' ? v : '[file]'])) : JSON.parse(init.body || '{}');
    tgCalls.push({ method, body });
    if (tgFailNext > 0) { tgFailNext--; return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } }), { status: 429 }); }
    const id = ++msgId;
    const result = method === 'sendPhoto' ? { message_id: id, photo: [{ file_id: 'F' + id }] }
      : method === 'getMe' ? { username: 'test_bot' } : method === 'getFile' ? { file_path: 'p.jpg' } : { message_id: id };
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
  };
});
afterEach(() => { globalThis.fetch = realFetch; mock.timers.reset(); });

// giờ Việt Nam -> mốc thời gian
const vn = (s) => Date.parse(s + '+07:00');
function setNow(s) { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: vn(s) }); }

async function call(method, path, { code, json, form, headers = {}, cf, ip, body: raw } = {}) {
  const h = { ...headers };
  if (ip) h['CF-Connecting-IP'] = ip;
  if (code) h['X-Access-Code'] = code;
  let body = raw;   // raw: thân yêu cầu thô (vd JSON hỏng)
  if (json !== undefined) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  if (form) { body = new FormData(); for (const [k, v] of Object.entries(form)) body.append(k, v); }
  const req = new Request('https://ts.test' + path, { method, headers: h, body });
  if (cf) Object.defineProperty(req, 'cf', { value: cf });   // vị trí theo mạng Cloudflare gắn vào request
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
// Đăng nhập theo máy: tạo khoá trên "máy", kích hoạt bằng mã, rồi ký từng request như public/app.js
async function activate(code, { borrowed = false } = {}) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64');
  const r = await call('POST', '/api/devices', { code, json: { pub, borrowed } });
  return { id: r.data.deviceId, key: kp.privateKey, r };
}
async function signed(dev, method, path, opts = {}) {
  const ts = opts.ts ?? Date.now();
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.key, new TextEncoder().encode(`${ts}.${method}.${path}`));
  const headers = { 'X-Device': dev.id, 'X-Timestamp': String(ts), 'X-Signature': Buffer.from(sig).toString('base64') };
  return call(method, path, { ...opts, headers });
}
const photo = () => new File([new Uint8Array([0xff, 0xd8, 1, 2])], 'p.jpg', { type: 'image/jpeg' });
const desc = (seed = 1) => Array.from({ length: 128 }, (_, i) => Math.sin(i * seed) * 0.08);
async function addEmp(code, name, extra = {}) {
  const r = await call('PUT', '/api/employees', { code: ROOT, json: { code, name, descriptors: [desc()], ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.accessCode;
}
// lượt vào mặc định chọn ca sáng; lượt ra không cần ca (lấy theo ca đang mở)
const punch = (code, type, extra = {}, opts = {}) =>
  call('POST', '/api/punch', { code, form: { type, photo: photo(), ...(type === 'in' && !('shift' in extra) ? { shift: 'sang' } : {}), ...extra }, ...opts });
const sent = m => tgCalls.filter(c => c.method === m);

// ---------- Kích hoạt và phân quyền ----------
describe('Kích hoạt và phân quyền', () => {
  test('không có mã hoặc mã sai thì 401', async () => {
    assert.equal((await call('GET', '/api/me')).status, 401);
    assert.equal((await call('GET', '/api/me', { code: 'ZZZZ-ZZZZ' })).status, 401);
  });

  test('mã kích hoạt: đúng định dạng, nhập thường/không gạch/có khoảng trắng đều được', async () => {
    const c = await addEmp('NV01', 'An');
    assert.match(c, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    for (const v of [c, c.toLowerCase(), c.replace('-', ''), ` ${c.slice(0, 4)} ${c.slice(5)} `]) {
      const r = await call('GET', '/api/me', { code: v });
      assert.equal(r.status, 200, v);
      assert.equal(r.data.code, 'NV01');
    }
  });

  test('không bao giờ trả hash của mã ra ngoài', async () => {
    const c = await addEmp('NV01', 'An', { role: 1 });
    const all = JSON.stringify([
      (await call('GET', '/api/employees', { code: ROOT })).data,
      (await call('GET', '/api/me', { code: c })).data,
      (await call('PUT', '/api/employees', { code: ROOT, json: { code: 'NV01', name: 'An' } })).data,
    ]);
    assert.doesNotMatch(all, /keyHash/);
  });

  test('nhân viên (role 2) bị chặn ở mọi chức năng quản trị', async () => {
    const c = await addEmp('NV02', 'Bình');
    const checks = [
      ['GET', '/api/employees'], ['PUT', '/api/employees', { code: 'X', name: 'X' }], ['DELETE', '/api/employees?code=NV02'],
      ['POST', '/api/employees/code?code=NV02'], ['GET', '/api/photo?id=F1'], ['GET', '/api/logs'], ['POST', '/api/setup'], ['POST', '/api/report-now'],
    ];
    for (const [m, p, j] of checks) assert.equal((await call(m, p, { code: c, json: j })).status, 403, `${m} ${p}`);
  });

  test('quyền: mặc định nhân viên; 1 hoặc "1" là quản trị; giá trị lạ thành nhân viên', async () => {
    for (const [role, want] of [[undefined, 2], [1, 1], ['1', 1], [7, 2], ['admin', 2]]) {
      const r = await call('PUT', '/api/employees', { code: ROOT, json: { code: 'R', name: 'R', role } });
      assert.equal(r.data.employee.role, want, String(role));
    }
  });

  test('sửa nhân viên không đổi mã cũ; tạo mã mới thì mã cũ hết hiệu lực', async () => {
    const old = await addEmp('NV01', 'An');
    const edit = await call('PUT', '/api/employees', { code: ROOT, json: { code: 'NV01', name: 'An mới' } });
    assert.equal(edit.data.accessCode, undefined);
    assert.equal((await call('GET', '/api/me', { code: old })).data.name, 'An mới');
    const rot = await call('POST', '/api/employees/code?code=NV01', { code: ROOT });
    assert.equal((await call('GET', '/api/me', { code: old })).status, 401);
    assert.equal((await call('GET', '/api/me', { code: rot.data.accessCode })).status, 200);
  });

  test('sửa nhân viên không gửi khuôn mặt thì giữ mẫu cũ', async () => {
    await addEmp('NV01', 'An');
    await call('PUT', '/api/employees', { code: ROOT, json: { code: 'NV01', name: 'An' } });
    const list = (await call('GET', '/api/employees', { code: ROOT })).data;
    assert.equal(list[0].descriptors.length, 1);
  });

  test('quản trị viên không tự hạ quyền, tự xoá hay tự đổi mã của mình', async () => {
    const a = await addEmp('AD', 'Quản lý', { role: 1 });
    assert.equal((await call('PUT', '/api/employees', { code: a, json: { code: 'AD', name: 'Quản lý', role: 2 } })).status, 400);
    assert.equal((await call('DELETE', '/api/employees?code=AD', { code: a })).status, 400);
    assert.equal((await call('POST', '/api/employees/code?code=AD', { code: a })).status, 400);
  });

  test('thiếu mã NV hoặc họ tên thì 400', async () => {
    assert.equal((await call('PUT', '/api/employees', { code: ROOT, json: { code: '', name: 'A' } })).status, 400);
    assert.equal((await call('PUT', '/api/employees', { code: ROOT, json: { code: 'A', name: '  ' } })).status, 400);
  });

  test('Lỗi đã gặp: dữ liệu khuôn mặt sai dạng bị từ chối (tránh làm hỏng nhận diện trên máy nhân viên)', async () => {
    for (const descriptors of [[[1, 2, 3]], [desc().map(() => 'x')], [desc().map(() => NaN)], 'abc', Array(11).fill(desc())]) {
      const r = await call('PUT', '/api/employees', { code: ROOT, json: { code: 'B', name: 'B', descriptors } });
      assert.equal(r.status, 400, JSON.stringify(descriptors).slice(0, 40));
    }
  });

  test('xoá nhân viên thì mã của họ hết hiệu lực, lịch sử vẫn còn', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    await punch(c, 'in');
    await call('DELETE', '/api/employees?code=NV01', { code: ROOT });
    assert.equal((await call('GET', '/api/me', { code: c })).status, 401);
    assert.equal((await call('GET', '/api/logs', { code: ROOT })).data.length, 1);
  });
});

// ---------- Chấm công ----------
describe('Chấm công', () => {
  test('tài khoản quản trị gốc không chấm công', async () => {
    assert.equal((await punch(ROOT, 'in')).status, 403);
  });

  test('luôn ghi cho người đăng nhập, bỏ qua mã NV gửi kèm', async () => {
    setNow('2026-10-26T08:00:00');
    await addEmp('NV01', 'An'); const b = await addEmp('NV02', 'Bình');
    const r = await punch(b, 'in', { code: 'NV01' });
    assert.equal(r.data.record.code, 'NV02');
  });

  test('thứ tự vào/ra: ra khi chưa vào và vào hai lần đều bị chặn; ra lại lần 2 được', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    assert.equal((await punch(c, 'out')).status, 409);
    assert.equal((await punch(c, 'in')).status, 200);
    setNow('2026-10-26T08:01:00');
    assert.equal((await punch(c, 'in')).status, 409);
    for (const [t, type, want] of [['12:00', 'out', 200], ['13:00', 'in', 409], ['17:30', 'out', 200]]) {
      setNow(`2026-10-26T${t}:00`);
      assert.equal((await punch(c, type)).status, want, `${t} ${type}`);
    }
  });

  test('gửi lại cùng một lượt (cùng thời điểm) không tạo bản ghi và ảnh thứ hai', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An'), ts = String(vn('2026-10-26T07:59:00'));
    await punch(c, 'in', { ts });
    setNow('2026-10-26T08:00:30');
    const r = await punch(c, 'in', { ts });
    assert.equal(r.status, 200);
    assert.equal(r.data.duplicate, true);
    assert.equal(sent('sendPhoto').length, 1);
  });

  test('thiếu ảnh hoặc loại chấm công sai thì 400', async () => {
    const c = await addEmp('NV01', 'An');
    assert.equal((await call('POST', '/api/punch', { code: c, form: { type: 'in' } })).status, 400);
    assert.equal((await punch(c, 'lunch')).status, 400);
  });

  test('đi muộn: check-in sau giờ bắt đầu ca + LATE_GRACE_MIN; ca đã check-in thì không vào lại', async () => {
    const c = await addEmp('NV01', 'An'), d = await addEmp('NV02', 'Bình');
    setNow('2026-10-26T08:30:00'); assert.equal((await punch(c, 'in')).data.record.late, undefined);
    setNow('2026-10-26T08:31:00'); assert.equal((await punch(d, 'in')).data.record.late, true);
    setNow('2026-10-26T12:00:00'); await punch(c, 'out');
    setNow('2026-10-26T13:30:00'); assert.equal((await punch(c, 'in')).status, 409);
  });

  test('lượt gửi trễ (mất mạng) giữ đúng giờ chụp và ghi chú trong ảnh', async () => {
    setNow('2026-10-26T09:00:00');
    const c = await addEmp('NV01', 'An');
    const r = await punch(c, 'in', { ts: String(vn('2026-10-26T08:10:00')) });
    assert.equal(r.data.record.time, '08:10:00');
    assert.match(sent('sendPhoto')[0].body.caption, /Gửi trễ/);
  });

  test('giờ chụp ở tương lai (đồng hồ máy chạy nhanh) thì dùng giờ server', async () => {
    setNow('2026-10-26T09:00:00');
    const c = await addEmp('NV01', 'An');
    const r = await punch(c, 'in', { ts: String(vn('2026-10-27T09:00:00')) });
    assert.equal(r.data.record.time, '09:00:00');
  });

  test('chú thích ảnh Telegram thoát ký tự HTML trong tên', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', '<b>An</b> & <script>');
    await punch(c, 'in');
    const cap = sent('sendPhoto')[0].body.caption;
    assert.match(cap, /&lt;b&gt;An&lt;\/b&gt; &amp; &lt;script&gt;/);
    assert.equal(sent('sendPhoto')[0].body.chat_id, '-100777');
  });
});

// ---------- Xem lịch sử ----------
describe('Mỗi ca: check-in 1 lần, check-out tối đa 3 lần', () => {
  test('Lỗi đã gặp: vừa check-in xong, trạng thái vẫn là đang trong ca dù lệnh liệt kê KV chưa thấy lượt mới', async () => {
    // KV thật: list có thể chậm tới ~60 giây; app hỏi trạng thái ngay sau check-in nên hiện lại nút Check-in
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    env.KV.listLag = true;
    assert.equal((await punch(c, 'in')).status, 200);
    const st = (await call('GET', '/api/status', { code: c })).data;
    assert.equal(st.open?.shift, 'sang', JSON.stringify(st));
  });

  test('Lỗi đã gặp: trong lúc KV liệt kê chậm, check-in lần hai vẫn bị chặn', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    env.KV.listLag = true;
    await punch(c, 'in');
    setNow('2026-10-26T08:00:20');
    assert.equal((await punch(c, 'in')).status, 409);
    assert.equal(sent('sendPhoto').length, 1);
  });

  test('sau lần check-out đầu vẫn là đang trong ca: nút phải là Check-out, không phải Check-in', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    await punch(c, 'in');
    setNow('2026-10-26T12:00:00'); await punch(c, 'out');
    const st = (await call('GET', '/api/status', { code: c })).data;
    assert.equal(st.open?.shift, 'sang');
    assert.equal(st.open?.outs, 1);
  });

  test('check-out tối đa 3 lần; lần thứ 4 bị từ chối; đủ 3 lần thì ca kết thúc', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    for (const t of ['12:00', '13:30', '17:05']) { setNow(`2026-10-26T${t}:00`); assert.equal((await punch(c, 'out')).status, 200, t); }
    setNow('2026-10-26T17:10:00');
    const r = await punch(c, 'out');
    assert.equal(r.status, 409);
    assert.match(r.data.error, /3 lần/);
    const st = (await call('GET', '/api/status', { code: c })).data;
    assert.equal(st.open, null);
    assert.deepEqual(st.last, { shift: 'sang', shiftDate: '2026-10-26' });   // app dựa vào đây để khoá ô Ca sáng
  });

  test('đã check-in ca sáng hôm nay thì không check-in lại ca sáng, kể cả sau khi đã check-out đủ', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    for (const t of ['12:00', '13:00', '14:00']) { setNow(`2026-10-26T${t}:00`); await punch(c, 'out'); }
    setNow('2026-10-26T15:00:00');
    const r = await punch(c, 'in', { shift: 'sang' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /đã check-in Ca sáng/);
  });

  test('Lỗi đã gặp: đã check-out ca sáng thì check-in ca tối cùng ngày được ngay, không phải đợi', async () => {
    // bản trước bắt đợi tới 23:00 (giờ hết ca + 6 tiếng) mới được vào ca khác
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-26T17:00:00'); await punch(c, 'out');
    setNow('2026-10-26T22:00:00');
    assert.equal((await punch(c, 'in', { shift: 'toi' })).status, 200);
  });

  test('chưa check-out ca sáng thì không check-in ca tối', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-26T22:00:00');
    assert.equal((await punch(c, 'in', { shift: 'toi' })).status, 409);
  });

  test('Lỗi đã gặp: sang ngày mới thì quay về Check-in, dù hôm trước quên check-out', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-27T00:05:00');
    const st = (await call('GET', '/api/status', { code: c })).data;
    assert.equal(st.open, null);
    setNow('2026-10-27T07:55:00');
    assert.equal((await punch(c, 'in')).status, 200);
  });

  test('quên check-out thì qua nửa đêm không check-out bù được nữa (ngày đó thiếu công)', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-27T00:30:00');
    assert.equal((await punch(c, 'out')).status, 409);
  });

  test('check-out tăng ca lần 2, 3 trong ngày được; sang ngày mới thì không', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-26T17:00:00'); assert.equal((await punch(c, 'out')).status, 200);
    setNow('2026-10-26T19:30:00'); assert.equal((await punch(c, 'out')).status, 200);
    setNow('2026-10-27T00:10:00'); assert.equal((await punch(c, 'out')).status, 409);
  });

  test('ca tối: check-out lúc 06:00 và tăng ca tới 08:00 vẫn thuộc ca đêm trước; 12:00 trưa thì quay về Check-in', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T22:00:00'); await punch(c, 'in', { shift: 'toi' });
    setNow('2026-10-27T06:00:00'); assert.equal((await punch(c, 'out')).status, 200);
    setNow('2026-10-27T08:00:00');
    const r = await punch(c, 'out');
    assert.equal(r.status, 200); assert.equal(r.data.record.date, '2026-10-26');
    setNow('2026-10-27T11:59:00'); assert.notEqual((await call('GET', '/api/status', { code: c })).data.open, null);
    setNow('2026-10-27T12:00:00'); assert.equal((await call('GET', '/api/status', { code: c })).data.open, null);
  });

  test('tin tổng hợp cuối ca cảnh báo quên check-out sẽ không được tính công', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-26T18:30:00');
    const jobs = []; await worker.scheduled({}, env, { waitUntil: p => jobs.push(p) }); await Promise.all(jobs);
    assert.match(sent('sendMessage')[0].body.text, /không được tính công/);
  });

  test('lượt ra lần 2 và 3 ghi rõ số lần trong ảnh', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-26T12:00:00'); await punch(c, 'out');
    setNow('2026-10-26T17:00:00'); await punch(c, 'out');
    assert.match(sent('sendPhoto')[1].body.caption, /CHECK-OUT<\/b> \(lần 1\/3\)/);
    assert.match(sent('sendPhoto')[2].body.caption, /CHECK-OUT<\/b> \(lần 2\/3\)/);
  });

  test('giờ làm tính từ lúc vào tới lần check-out cuối', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-26T12:00:00'); await punch(c, 'out');
    setNow('2026-10-26T17:30:00'); await punch(c, 'out');
    setNow('2026-10-26T18:30:00');
    const jobs = []; await worker.scheduled({}, env, { waitUntil: p => jobs.push(p) }); await Promise.all(jobs);
    assert.match(sent('sendMessage')[0].body.text, /An: 08:00 → 17:30 \(9g30\)/);
  });

  test('gửi lại đúng lượt ra (mất phản hồi) không bị tính thêm một lần ra', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-26T12:00:00');
    const ts = String(Date.now());
    await punch(c, 'out', { ts }); await punch(c, 'out', { ts });
    assert.equal((await call('GET', '/api/status', { code: c })).data.open.outs, 1);
  });

  test('vẫn đọc được lượt vào đã chấm trước khi có bản ghi trạng thái (bản cũ)', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    await env.KV.put('log:2026-10-26:' + Date.parse('2026-10-26T07:30:00+07:00') + ':NV01', '', { metadata: { code: 'NV01', name: 'An', type: 'in', ts: Date.parse('2026-10-26T07:30:00+07:00'), time: '07:30:00' } });
    assert.equal((await call('GET', '/api/status', { code: c })).data.open?.shift, 'sang');
    assert.equal((await punch(c, 'out')).status, 200);
  });
});

describe('Ca làm việc', () => {
  test('check-in phải chọn ca hợp lệ', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    assert.equal((await punch(c, 'in', { shift: '' })).status, 400);
    assert.equal((await punch(c, 'in', { shift: 'chieu' })).status, 400);
  });

  test('ca tối qua nửa đêm: vào 22:05, ra 06:00 hôm sau tính cùng một ngày công', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T22:05:00');
    const a = await punch(c, 'in', { shift: 'toi' });
    assert.equal(a.data.record.date, '2026-10-26');
    setNow('2026-10-27T06:00:00');
    const b = await punch(c, 'out');
    assert.equal(b.status, 200, JSON.stringify(b.data));
    assert.equal(b.data.record.date, '2026-10-26');
    assert.equal(b.data.record.shift, 'toi');
    assert.equal(b.data.record.day, '2026-10-27');
    const logs = (await call('GET', '/api/logs?from=2026-10-26', { code: ROOT })).data;
    assert.deepEqual(logs.map(l => l.type), ['in', 'out']);
  });

  test('đến ca tối sau nửa đêm vẫn tính cho ngày hôm trước và bị đánh dấu muộn', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-27T00:30:00');
    const r = await punch(c, 'in', { shift: 'toi' });
    assert.equal(r.data.record.date, '2026-10-26');
    assert.equal(r.data.record.late, true);
  });

  test('ca sáng 06:00 (mở sớm 2 giờ) thuộc ngày mới; ca tối 22:20 trong giờ ân hạn không muộn', async () => {
    const a = await addEmp('NV01', 'An'), b = await addEmp('NV02', 'Bình');
    setNow('2026-10-27T06:00:00'); assert.equal((await punch(a, 'in')).data.record.date, '2026-10-27');
    setNow('2026-10-26T22:20:00'); assert.equal((await punch(b, 'in', { shift: 'toi' })).data.record.late, undefined);
  });

  test('Lỗi đã gặp: 21:00 vẫn check-in được ca sáng (ca 08:00–17:00)', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T21:00:00');
    const r = await punch(c, 'in', { shift: 'sang' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /06:00.*17:00/);
    assert.equal(sent('sendPhoto').length, 0);
    assert.equal((await punch(c, 'in', { shift: 'toi' })).status, 200);
  });

  test('check-in sớm hơn 2 giờ trước giờ vào thì chưa mở; check-out không bị giới hạn khung giờ', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T05:59:00');
    assert.equal((await punch(c, 'in', { shift: 'sang' })).status, 400);
    setNow('2026-10-26T06:00:00');
    assert.equal((await punch(c, 'in', { shift: 'sang' })).status, 200);
    setNow('2026-10-26T19:00:00');   // tăng ca, check-out ngoài khung giờ ca vẫn được
    assert.equal((await punch(c, 'out')).status, 200);
  });

  test('đang trong ca thì không check-in ca khác', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T22:00:00'); await punch(c, 'in', { shift: 'toi' });
    setNow('2026-10-27T08:00:00');
    const r = await punch(c, 'in', { shift: 'sang' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Ca tối/);
  });

  test('quên check-out quá 20 giờ thì được vào ca mới', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(c, 'in');
    setNow('2026-10-27T08:00:00');
    assert.equal((await punch(c, 'in')).status, 200);
  });

  test('trạng thái ca đang mở cho app, kể cả sau nửa đêm', async () => {
    const c = await addEmp('NV01', 'An', { shift: 'toi' });
    setNow('2026-10-26T21:00:00');
    let st = (await call('GET', '/api/status', { code: c })).data;
    assert.equal(st.open, null); assert.equal(st.shift, 'toi');
    setNow('2026-10-26T22:00:00'); await punch(c, 'in', { shift: 'toi' });
    setNow('2026-10-27T03:00:00');
    st = (await call('GET', '/api/status', { code: c })).data;
    assert.equal(st.open.shift, 'toi'); assert.equal(st.open.shiftDate, '2026-10-26');
    setNow('2026-10-27T06:00:00'); await punch(c, 'out');
    // check-out tối đa 3 lần: sau lần ra đầu ca vẫn mở, tới 12:00 (06:00 + 6 giờ) mới đóng
    assert.equal((await call('GET', '/api/status', { code: c })).data.open.outs, 1);
    setNow('2026-10-27T12:01:00');
    assert.equal((await call('GET', '/api/status', { code: c })).data.open, null);
  });

  test('ảnh Telegram có thời gian dd/mm/yyyy hh:mm, mã NV, họ tên, ca và vị trí GPS', async () => {
    setNow('2026-10-26T22:05:00');
    const c = await addEmp('NV01', 'Nguyễn Văn An', { tg: 'an' });
    await punch(c, 'in', { shift: 'toi', lat: '21.028511', lng: '105.804817', acc: '14.6' });
    const cap = sent('sendPhoto')[0].body.caption;
    assert.match(cap, /CHECK-IN<\/b> · Ca tối 22:00–06:00/);
    assert.match(cap, /Thời gian: 26\/10\/2026 22:05/);
    assert.match(cap, /Mã NV: NV01/);
    assert.match(cap, /Họ tên: Nguyễn Văn An @an/);
    assert.match(cap, /maps\.google\.com\/\?q=21\.02851,105\.80482/);
    assert.match(cap, /±15 m/);
    const log = (await call('GET', '/api/logs', { code: ROOT })).data[0];
    assert.equal(log.loc, '21.02851,105.80482,15');
  });

  test('check-out ca tối sau nửa đêm ghi rõ ngày công trong ảnh', async () => {
    const c = await addEmp('NV01', 'An');
    setNow('2026-10-26T22:00:00'); await punch(c, 'in', { shift: 'toi' });
    setNow('2026-10-27T06:00:00'); await punch(c, 'out');
    const cap = sent('sendPhoto')[1].body.caption;
    assert.match(cap, /CHECK-OUT<\/b> \(lần 1\/3\) · Ca tối 22:00–06:00 \(ngày 26\/10\/2026\)/);
    assert.match(cap, /Thời gian: 27\/10\/2026 06:00/);
  });

  test('không có GPS thì dùng vị trí theo mạng, có GPS sai thì bỏ qua', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    await punch(c, 'in', { lat: '999', lng: '0' }, { cf: { city: 'Hanoi', country: 'VN' } });
    assert.match(sent('sendPhoto')[0].body.caption, /theo mạng, không có GPS\): Hanoi, VN/);
    setNow('2026-10-26T17:00:00');
    await punch(c, 'out');
    assert.match(sent('sendPhoto')[1].body.caption, /Vị trí: không xác định/);
  });

  test('metadata KV của một lượt luôn dưới 1024 byte (giới hạn của Cloudflare)', async () => {
    setNow('2026-10-26T22:05:00');
    const c = await addEmp('X'.repeat(30), 'Nguyễn '.repeat(11).trim(), { tg: 'a'.repeat(40) });
    await punch(c, 'in', { shift: 'toi', lat: '-21.123456', lng: '-105.123456', acc: '99999' }, { cf: { city: 'Thành phố Hồ Chí Minh', country: 'VN' } });
    const [, v] = [...env.KV.m].find(([k]) => k.startsWith('log:'));
    assert.ok(new TextEncoder().encode(JSON.stringify(v.metadata)).length < 1024);
  });
});

describe('Nhập danh sách nhân viên', () => {
  test('nhập nhiều người: tạo mã cho từng người, chỉ 1 lần ghi KV', async () => {
    const before = env.KV.puts || 0;
    const r = await call('POST', '/api/employees/import', { code: ROOT, json: { rows: [
      { code: 'NV01', name: 'An' }, { code: 'NV02', name: 'Bình', role: 1, shift: 'toi', tg: '@binh' }, { code: 'NV03', name: 'Cường' },
    ] } });
    assert.equal(r.status, 200);
    assert.equal(r.data.created.length, 3);
    assert.equal((env.KV.puts || 0) - before, 1);
    const me = (await call('GET', '/api/me', { code: r.data.created[1].accessCode })).data;
    assert.deepEqual([me.code, me.role, me.shift, me.tg], ['NV02', 1, 'toi', 'binh']);
  });

  test('báo lỗi theo dòng: thiếu tên, ca sai, trùng mã trong file; dòng đúng vẫn được nhập', async () => {
    const r = (await call('POST', '/api/employees/import', { code: ROOT, json: { rows: [
      { code: 'NV01', name: 'An' }, { code: 'NV02', name: '' }, { code: 'NV03', name: 'C', shift: 'chieu' }, { code: 'NV01', name: 'An 2' },
    ] } })).data;
    assert.deepEqual(r.created.map(x => x.code), ['NV01']);
    assert.deepEqual(r.errors.map(e => e.row), [2, 3, 4]);
  });

  test('người đã có: mặc định bỏ qua; chọn cập nhật thì đổi thông tin nhưng giữ mã và khuôn mặt', async () => {
    const old = await addEmp('NV01', 'An');
    let r = (await call('POST', '/api/employees/import', { code: ROOT, json: { rows: [{ code: 'NV01', name: 'An mới' }] } })).data;
    assert.equal(r.skipped.length, 1);
    r = (await call('POST', '/api/employees/import', { code: ROOT, json: { update: true, rows: [{ code: 'NV01', name: 'An mới', shift: 'toi' }] } })).data;
    assert.deepEqual(r.updated, ['NV01']);
    const me = (await call('GET', '/api/me', { code: old })).data;
    assert.deepEqual([me.name, me.shift, me.descriptors.length], ['An mới', 'toi', 1]);
  });

  test('nhân viên không được nhập; quá 500 dòng thì từ chối', async () => {
    const c = await addEmp('NV09', 'X');
    assert.equal((await call('POST', '/api/employees/import', { code: c, json: { rows: [{ code: 'A', name: 'A' }] } })).status, 403);
    const rows = Array.from({ length: 501 }, (_, i) => ({ code: 'N' + i, name: 'N' }));
    assert.equal((await call('POST', '/api/employees/import', { code: ROOT, json: { rows } })).status, 400);
  });
});

describe('Khuôn mặt và ảnh đại diện', () => {
  const smallJpeg = 'data:image/jpeg;base64,' + Buffer.from(new Uint8Array(6000).fill(7)).toString('base64');
  test('mẫu khuôn mặt được làm tròn 4 chữ số để tiết kiệm KV', async () => {
    await call('PUT', '/api/employees', { code: ROOT, json: { code: 'NV01', name: 'An', descriptors: [desc().map(n => n + 0.0000123456)] } });
    const d = (await call('GET', '/api/employees', { code: ROOT })).data[0].descriptors[0];
    assert.ok(d.every(n => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6));
  });

  test('ảnh đại diện: lưu, quản trị và chính người đó xem được, người khác không', async () => {
    const r = await call('PUT', '/api/employees', { code: ROOT, json: { code: 'NV01', name: 'An', descriptors: [desc()], avatar: smallJpeg } });
    assert.equal(r.data.employee.hasAvatar, true);
    const own = r.data.accessCode, other = await addEmp('NV02', 'Bình');
    const res = await worker.fetch(new Request('https://ts.test/api/avatar?code=NV01', { headers: { 'X-Access-Code': own } }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
    assert.equal((await res.arrayBuffer()).byteLength, 6000);
    assert.equal((await call('GET', '/api/avatar?code=NV01', { code: other })).status, 403);
    assert.equal((await call('GET', '/api/avatar?code=NV01', { code: ROOT })).status, 200);
  });

  test('ảnh đại diện quá 40KB hoặc sai định dạng bị từ chối', async () => {
    const big = 'data:image/jpeg;base64,' + Buffer.from(new Uint8Array(41 * 1024)).toString('base64');
    assert.equal((await call('PUT', '/api/employees', { code: ROOT, json: { code: 'A', name: 'A', avatar: big } })).status, 400);
    assert.equal((await call('PUT', '/api/employees', { code: ROOT, json: { code: 'A', name: 'A', avatar: 'data:image/png;base64,AAAA' } })).status, 400);
  });

  test('xoá nhân viên thì xoá luôn ảnh đại diện', async () => {
    await call('PUT', '/api/employees', { code: ROOT, json: { code: 'NV01', name: 'An', avatar: smallJpeg } });
    await call('DELETE', '/api/employees?code=NV01', { code: ROOT });
    assert.equal(env.KV.m.has('avatar:NV01'), false);
  });
});

describe('Chống chấm công lùi giờ', () => {
  test('Lỗi đã gặp: lượt chụp hơn 24 giờ trước bị từ chối (chỉnh giờ máy + tắt mạng)', async () => {
    setNow('2026-10-26T09:00:00');
    const c = await addEmp('NV01', 'An');
    const r = await punch(c, 'in', { ts: String(vn('2026-10-25T08:00:00')) });
    assert.equal(r.status, 400);
    assert.equal(sent('sendPhoto').length, 0);
  });

  test('Lỗi đã gặp: lượt gửi trễ được đánh dấu trong dữ liệu, kèm giờ server nhận', async () => {
    setNow('2026-10-26T10:15:00');
    const c = await addEmp('NV01', 'An');
    await punch(c, 'in', { ts: String(vn('2026-10-26T07:55:00')) });
    const log = (await call('GET', '/api/logs', { code: ROOT })).data[0];
    assert.equal(log.delayed, true);
    assert.equal(log.received, '10:15');
  });

  test('lượt gửi ngay (lệch dưới 2 phút) không bị đánh dấu', async () => {
    setNow('2026-10-26T08:00:30');
    const c = await addEmp('NV01', 'An');
    await punch(c, 'in', { ts: String(vn('2026-10-26T08:00:00')) });
    assert.equal((await call('GET', '/api/logs', { code: ROOT })).data[0].delayed, undefined);
  });
});

describe('Giảm lệnh liệt kê KV (giới hạn 1.000 lần/ngày)', () => {
  // Cache API của Workers giả lập
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.caches = { default: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => { store.set(req.url, res.clone()); },
      delete: async (req) => store.delete(req.url),
    } };
  });
  afterEach(() => { delete globalThis.caches; });

  test('Lỗi đã gặp: xem bảng công nhiều lần không liệt kê KV lại mỗi lần', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    await punch(c, 'in');
    const before = env.KV.lists;
    for (let i = 0; i < 5; i++) await call('GET', '/api/logs', { code: ROOT });
    assert.equal(env.KV.lists - before, 1);
  });

  test('có lượt chấm mới thì bảng công thấy ngay (xoá cache của ngày đó)', async () => {
    setNow('2026-10-26T08:00:00');
    const a = await addEmp('NV01', 'An'), b = await addEmp('NV02', 'Bình');
    await punch(a, 'in');
    assert.equal((await call('GET', '/api/logs', { code: ROOT })).data.length, 1);
    await punch(b, 'in');
    assert.equal((await call('GET', '/api/logs', { code: ROOT })).data.length, 2);
  });

  test('kiểm tra thứ tự vào/ra luôn đọc dữ liệu mới, không dùng cache', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    await call('GET', '/api/logs', { code: ROOT });          // cache ngày rỗng
    await env.KV.put('log:2026-10-26:' + vn('2026-10-26T07:00:00') + ':NV01', '', { metadata: { code: 'NV01', name: 'An', type: 'in', ts: vn('2026-10-26T07:00:00'), time: '07:00:00' } });
    assert.equal((await punch(c, 'in')).status, 409);       // phải thấy lượt vào lúc 07:00
  });
});

describe('Ảnh chụp ngày đã khoá và list theo tháng (không có Cache API, như trên *.workers.dev)', () => {
  // ghi sẵn lượt vào của mỗi người trong các ngày tháng 10
  async function seedOctober(days = 26, people = 3) {
    for (let d = 1; d <= days; d++) for (let p = 1; p <= people; p++) {
      const date = `2026-10-${String(d).padStart(2, '0')}`, ts = vn(`${date}T08:0${p}:00`);
      await env.KV.put(`log:${date}:${ts}:NV0${p}`, '', { metadata: { code: `NV0${p}`, name: 'N' + p, type: 'in', ts, time: `08:0${p}:00` } });
    }
  }

  test('Lỗi đã gặp: xem bảng công cả tháng tốn 1 lệnh list cho mỗi ngày (cạn hạn mức 1.000 lần/ngày)', async () => {
    setNow('2026-11-26T08:00:00');
    await seedOctober();
    const before = env.KV.lists;
    const r = await call('GET', '/api/logs?from=2026-10-01&to=2026-10-31', { code: ROOT });
    assert.equal(r.status, 200);
    assert.equal(r.data.length, 26 * 3);
    assert.ok(env.KV.lists - before <= 2, `lần đầu chỉ list theo tháng, đã list ${env.KV.lists - before} lần`);
    const again = env.KV.lists;
    const r2 = await call('GET', '/api/logs?from=2026-10-01&to=2026-10-31', { code: ROOT });
    assert.equal(env.KV.lists, again, 'ngày đã khoá đọc từ ảnh chụp, không list lại');
    assert.deepEqual(r2.data, r.data);
    const dates = r.data.map(l => l.date + l.ts);
    assert.deepEqual(dates, [...dates].sort(), 'đúng thứ tự ngày và giờ');
  });

  test('ngày còn nhận lượt gửi trễ (chưa khoá) thì không chụp lại, lượt mới vẫn hiện', async () => {
    setNow('2026-10-26T22:00:00');
    const c = await addEmp('NV01', 'An');
    await punch(c, 'in', { shift: 'toi' });
    setNow('2026-10-28T11:00:00');   // 24 giờ sau hết ngày công ca tối mới khoá (12:00 ngày 28)
    assert.equal((await call('GET', '/api/logs?from=2026-10-26&to=2026-10-26', { code: ROOT })).data.length, 1);
    assert.equal((await punch(c, 'out', { ts: String(vn('2026-10-27T11:30:00')) })).status, 200);
    assert.equal((await call('GET', '/api/logs?from=2026-10-26&to=2026-10-26', { code: ROOT })).data.length, 2);
    setNow('2026-10-28T12:30:00');
    assert.equal((await call('GET', '/api/logs?from=2026-10-26&to=2026-10-26', { code: ROOT })).data.length, 2);
    const before = env.KV.lists;
    assert.equal((await call('GET', '/api/logs?from=2026-10-26&to=2026-10-26', { code: ROOT })).data.length, 2);
    assert.equal(env.KV.lists, before);
  });

  test('Lỗi đã gặp: hết hạn mức list KV thì người chưa có bản ghi trạng thái không chấm công được (500)', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    env.KV.listFail = true;
    assert.equal((await call('GET', '/api/status', { code: c })).status, 200);
    const r = await punch(c, 'in');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    setNow('2026-10-26T08:05:00');
    assert.equal((await punch(c, 'in')).status, 409, 'đã có bản ghi trạng thái nên vẫn chặn check-in lần hai');
  });
});

describe('Không gửi ảnh lặp khi lỗi giữa chừng', () => {
  test('Lỗi đã gặp: ghi KV lỗi sau khi đã gửi ảnh, app gửi lại mỗi 30 giây thì group nhận ảnh lặp mãi', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    await env.KV.put('state:NV01', JSON.stringify({ none: true }));   // đã có bản ghi trạng thái: không cần dựng lại
    env.KV.putFail = () => true;
    const ts = String(Date.now());
    for (let i = 0; i < 3; i++) assert.equal((await punch(c, 'in', { ts })).status, 500);
    assert.equal(sent('sendPhoto').length, 0, 'không ghi được trạng thái thì chưa gửi ảnh nào');
    env.KV.putFail = null;
    assert.equal((await punch(c, 'in', { ts })).status, 200);
    assert.equal(sent('sendPhoto').length, 1);
  });

  test('gửi ảnh lỗi thì trả lại trạng thái cũ: chưa vào ca, gửi lại được', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    tgFailNext = 10;
    const ts = String(Date.now());
    assert.ok((await punch(c, 'in', { ts })).status >= 500);
    assert.equal((await call('GET', '/api/status', { code: c })).data.open, null);
    tgFailNext = 0;
    assert.equal((await punch(c, 'in', { ts })).status, 200);
    assert.equal((await call('GET', '/api/logs', { code: ROOT })).data.length, 1);
  });

  test('ghi bản ghi lỗi sau khi gửi ảnh: lần gửi lại bổ sung bản ghi, sau đó không gửi thêm ảnh', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    env.KV.putFail = k => k.startsWith('log:');
    const ts = String(Date.now());
    assert.equal((await punch(c, 'in', { ts })).status, 500);
    env.KV.putFail = null;
    for (let i = 0; i < 3; i++) assert.equal((await punch(c, 'in', { ts })).status, 200);
    assert.equal((await call('GET', '/api/logs', { code: ROOT })).data.length, 1);
    assert.ok(sent('sendPhoto').length <= 2, `đã gửi ${sent('sendPhoto').length} ảnh`);
  });
});

describe('Giới hạn tần suất (Workers Rate Limiting)', () => {
  test('Lỗi đã gặp: bấm "Gửi tổng hợp ngay" nhiều lần thì group nhận nhiều tin', async () => {
    env.RL_ACTION = new FakeRL(1);
    setNow('2026-10-26T10:00:00');
    assert.equal((await call('POST', '/api/report-now', { code: ROOT })).status, 200);
    const r = await call('POST', '/api/report-now', { code: ROOT });
    assert.equal(r.status, 429);
    assert.match(r.data.error, /chờ 1 phút/i);
    assert.equal(sent('sendMessage').length, 1);
  });

  test('chấm công dồn dập bằng một mã thì bị chặn 429, không gửi ảnh', async () => {
    env.RL_PUNCH = new FakeRL(6);
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    for (let i = 0; i < 6; i++) await punch(c, 'in', { ts: String(Date.now() - i) });
    const before = sent('sendPhoto').length;
    assert.equal((await punch(c, 'out')).status, 429);
    assert.equal(sent('sendPhoto').length, before);
  });

  test('nhập sai mã nhiều lần từ một mạng thì 429; mã đúng cùng mạng vẫn dùng được', async () => {
    env.RL_AUTH = new FakeRL(5);
    const c = await addEmp('NV01', 'An');
    for (let i = 0; i < 5; i++) assert.equal((await call('GET', '/api/me', { code: 'SAIMA' + i, ip: '1.2.3.4' })).status, 401);
    assert.equal((await call('GET', '/api/me', { code: 'SAIMA9', ip: '1.2.3.4' })).status, 429);
    assert.equal((await call('GET', '/api/me', { code: c, ip: '1.2.3.4' })).status, 200);
  });

  test('quá nhiều yêu cầu từ một mạng thì 429', async () => {
    env.RL_IP = new FakeRL(3);
    const c = await addEmp('NV01', 'An');
    for (let i = 0; i < 3; i++) assert.equal((await call('GET', '/api/me', { code: c, ip: '5.6.7.8' })).status, 200);
    assert.equal((await call('GET', '/api/me', { code: c, ip: '5.6.7.8' })).status, 429);
    assert.equal((await call('GET', '/api/me', { code: c, ip: '9.9.9.9' })).status, 200);
  });

  test('chưa cấu hình giới hạn (chạy thử) thì không chặn', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/report-now', { code: ROOT })).status, 200);
  });
});

describe('Đăng nhập theo máy (mã kích hoạt không lưu trên máy)', () => {
  test('kích hoạt bằng mã rồi mọi request chỉ cần chữ ký của máy', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    const dev = await activate(c);
    assert.equal(dev.r.status, 200, JSON.stringify(dev.r.data));
    assert.match(dev.id, /^d_[0-9a-f]{16,}$/);
    assert.equal(dev.r.data.me.code, 'NV01');
    const me = await signed(dev, 'GET', '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.code, 'NV01');
    assert.equal((await signed(dev, 'POST', '/api/punch', { form: { type: 'in', shift: 'sang', photo: photo() } })).status, 200);
  });

  test('Lỗi đã gặp: chép thông tin đăng nhập từ F12 sang máy khác vẫn dùng được', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    const dev = await activate(c);
    // máy khác chép được mã máy (X-Device) nhưng không có khoá bí mật (không xuất ra được)
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const r = await signed({ id: dev.id, key: other.privateKey }, 'GET', '/api/me');
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'INVALID_SIGNATURE');
    // chép nguyên một request đã ký: chữ ký gắn với đường dẫn, dùng cho đường dẫn khác không được
    const ts = Date.now();
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.key, new TextEncoder().encode(`${ts}.GET./api/me`));
    const h = { 'X-Device': dev.id, 'X-Timestamp': String(ts), 'X-Signature': Buffer.from(sig).toString('base64') };
    assert.equal((await call('GET', '/api/status', { headers: h })).data.code, 'INVALID_SIGNATURE');
  });

  test('chữ ký cũ hơn 5 phút bị từ chối, kèm giờ server để app chỉnh lệch đồng hồ', async () => {
    setNow('2026-10-26T08:00:00');
    const dev = await activate(await addEmp('NV01', 'An'));
    const r = await signed(dev, 'GET', '/api/me', { ts: Date.now() - 6 * 60e3 });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'SIGNATURE_EXPIRED');
    assert.equal(r.data.serverTime, Date.now());
    assert.equal((await signed(dev, 'GET', '/api/me', { ts: Date.now() - 4 * 60e3 })).status, 200);
  });

  test('không giới hạn số máy: mượn điện thoại người khác để tự chấm công', async () => {
    const c = await addEmp('NV01', 'An');
    const devs = [];
    for (let i = 0; i < 4; i++) devs.push(await activate(c));
    for (const d of devs) assert.equal((await signed(d, 'GET', '/api/me')).status, 200);
  });

  test('máy mượn: chấm công xong thì máy tự đăng xuất', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    const dev = await activate(c, { borrowed: true });
    const r = await signed(dev, 'POST', '/api/punch', { form: { type: 'in', shift: 'sang', photo: photo() } });
    assert.equal(r.status, 200);
    assert.equal(r.data.signedOut, true);
    assert.equal((await signed(dev, 'GET', '/api/me')).data.code, 'DEVICE_REVOKED');
  });

  test('máy mượn quá 24 giờ không chấm công thì hết hạn', async () => {
    setNow('2026-10-26T08:00:00');
    const dev = await activate(await addEmp('NV01', 'An'), { borrowed: true });
    setNow('2026-10-27T08:01:00');
    assert.equal((await signed(dev, 'GET', '/api/me')).data.code, 'DEVICE_REVOKED');
  });

  test('đăng xuất chỉ thu hồi máy đó; đổi mã kích hoạt hoặc "đăng xuất mọi máy" thì thu hồi hết', async () => {
    const c = await addEmp('NV01', 'An');
    const a = await activate(c), b = await activate(c), d = await activate(c);
    assert.equal((await signed(a, 'DELETE', '/api/devices')).status, 200);
    assert.equal((await signed(a, 'GET', '/api/me')).data.code, 'DEVICE_REVOKED');
    assert.equal((await signed(b, 'GET', '/api/me')).status, 200);
    assert.equal((await call('DELETE', '/api/devices?code=NV01', { code: ROOT })).status, 200);
    assert.equal((await signed(b, 'GET', '/api/me')).data.code, 'DEVICE_REVOKED');
    assert.equal((await signed(d, 'GET', '/api/me')).data.code, 'DEVICE_REVOKED');
    const e = await activate(c);
    await call('POST', '/api/employees/code?code=NV01', { code: ROOT });
    assert.equal((await signed(e, 'GET', '/api/me')).data.code, 'DEVICE_REVOKED');
  });

  test('sửa thông tin nhân viên không làm mất máy đã kích hoạt; danh sách không lộ khoá công khai', async () => {
    const c = await addEmp('NV01', 'An');
    const dev = await activate(c);
    await call('PUT', '/api/employees', { code: ROOT, json: { code: 'NV01', name: 'An mới' } });
    assert.equal((await signed(dev, 'GET', '/api/me')).data.name, 'An mới');
    const list = (await call('GET', '/api/employees', { code: ROOT })).data;
    assert.equal(list[0].devices, 1);
    assert.doesNotMatch(JSON.stringify(list), /"pub"/);
  });

  test('quản trị gốc cũng đăng nhập theo máy', async () => {
    const dev = await activate(ROOT);
    assert.equal(dev.r.status, 200);
    assert.equal((await signed(dev, 'GET', '/api/me')).data.root, true);
    assert.equal((await signed(dev, 'GET', '/api/employees')).status, 200);
  });

  test('kích hoạt bằng mã sai hoặc khoá công khai hỏng thì từ chối', async () => {
    assert.equal((await call('POST', '/api/devices', { code: 'SAIMA', json: { pub: 'AAAA' } })).status, 401);
    const c = await addEmp('NV01', 'An');
    const r = await call('POST', '/api/devices', { code: c, json: { pub: 'không-phải-khoá' } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'INVALID_DEVICE_KEY');
  });
});

describe('Định dạng lỗi trả về', () => {
  const shape = (r, status, code) => {
    assert.equal(r.status, status);
    assert.equal(r.data.status, status, 'có status trong nội dung');
    assert.equal(r.data.code, code);
    assert.equal(typeof r.data.error, 'string');
    assert.ok(r.data.error.length > 0);
    assert.match(r.data.requestId, /^[\w-]{6,}$/, 'có mã tra cứu');
    assert.equal(r.headers.get('X-Request-Id'), r.data.requestId);
  };

  test('Lỗi đã gặp: lỗi chỉ có "error", không có status, mã lỗi hay mã tra cứu', async () => {
    shape(await call('GET', '/api/me', { code: 'SAIMA' }), 401, 'INVALID_ACCESS_CODE');
    shape(await call('GET', '/api/me'), 401, 'MISSING_ACCESS_CODE');
  });

  test('mã lỗi theo từng trường hợp', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    shape(await call('GET', '/api/employees', { code: c }), 403, 'ADMIN_ONLY');
    shape(await call('GET', '/api/khong-co', { code: c }), 404, 'NOT_FOUND');
    shape(await punch(c, 'in', { shift: 'toi' }), 400, 'SHIFT_CLOSED');
    await punch(c, 'in');
    setNow('2026-10-26T08:05:00');
    shape(await punch(c, 'in'), 409, 'SHIFT_IN_PROGRESS');   // chưa check-out thì ca vẫn đang mở
    shape(await call('GET', '/api/logs?from=2026-01-01&to=2026-12-31', { code: ROOT }), 400, 'INVALID_REQUEST');
  });

  test('giới hạn tần suất: 429 kèm Retry-After', async () => {
    env.RL_ACTION = new FakeRL(1);
    await call('POST', '/api/report-now', { code: ROOT });
    const r = await call('POST', '/api/report-now', { code: ROOT });
    shape(r, 429, 'RATE_LIMITED');
    assert.equal(r.headers.get('Retry-After'), '60');
    assert.equal(r.data.retryAfter, 60);
  });

  test('Lỗi đã gặp: lỗi nội bộ (vd KV) trả nguyên thông báo kỹ thuật ra ngoài', async () => {
    env.KV.putFail = () => true;
    const r = await call('PUT', '/api/employees', { code: ROOT, json: { code: 'NV01', name: 'An', descriptors: [desc()] } });
    shape(r, 500, 'INTERNAL_ERROR');
    assert.doesNotMatch(r.data.error, /KV|put\(\)|limit exceeded/i, 'không lộ chi tiết nội bộ');
  });

  test('Telegram lỗi: 502 kèm mã riêng', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    tgFailNext = 10;
    shape(await punch(c, 'in'), 503, 'TELEGRAM_BUSY');
  });
});

describe('Telegram giới hạn tốc độ', () => {
  test('Lỗi đã gặp: Telegram báo gửi quá nhanh (429) thì server tự chờ và gửi lại', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    tgFailNext = 1;
    const r = await punch(c, 'in');
    assert.equal(r.status, 200);
    assert.equal(sent('sendPhoto').length, 2);
  });

  test('429 liên tục thì báo lỗi để app giữ lượt lại và gửi sau', async () => {
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    tgFailNext = 10;
    const r = await punch(c, 'in');
    assert.ok(r.status >= 500, String(r.status));
  });
});

describe('Lịch sử', () => {
  test('quản trị thấy tất cả lượt chấm công', async () => {
    setNow('2026-10-26T08:00:00');
    const a = await addEmp('NV01', 'An'), b = await addEmp('NV02', 'Bình');
    await punch(a, 'in'); await punch(b, 'in');
    assert.equal((await call('GET', '/api/logs', { code: ROOT })).data.length, 2);
  });

  test('Lỗi đã gặp: nhân viên gọi thẳng /api/logs với nhiều khoảng ngày làm cạn hạn mức liệt kê KV (1.000 lần/ngày)', async () => {
    // app không gọi /api/logs cho nhân viên; trên *.workers.dev Cache API không có tác dụng nên mỗi ngày hỏi là một lần list
    setNow('2026-10-26T08:00:00');
    const c = await addEmp('NV01', 'An');
    await punch(c, 'in');
    const before = env.KV.lists;
    for (const y of [2001, 2002, 2003]) {
      const r = await call('GET', `/api/logs?from=${y}-01-01&to=${y}-03-02`, { code: c });
      assert.equal(r.status, 403);
    }
    assert.equal(env.KV.lists, before, 'nhân viên không được gây ra lệnh liệt kê KV nào');
  });

  test('khoảng ngày: quá 62 ngày thì 400; từ ngày sau đến ngày thì rỗng', async () => {
    assert.equal((await call('GET', '/api/logs?from=2026-01-01&to=2026-12-31', { code: ROOT })).status, 400);
    const r = await call('GET', '/api/logs?from=2026-10-26&to=2026-10-01', { code: ROOT });
    assert.equal(r.status, 200); assert.deepEqual(r.data, []);
  });

  test('khoảng nhiều ngày trả đủ các ngày, đúng thứ tự thời gian', async () => {
    const c = await addEmp('NV01', 'An');
    for (const d of ['24', '25', '26']) { setNow(`2026-10-${d}T08:00:00`); await punch(c, 'in'); }
    const r = (await call('GET', '/api/logs?from=2026-10-24&to=2026-10-26', { code: ROOT })).data;
    assert.deepEqual(r.map(l => l.date), ['2026-10-24', '2026-10-25', '2026-10-26']);
  });
});

// ---------- Bot Telegram ----------
describe('Bot Telegram', () => {
  const hook = (text, chatId = -100777, secret = 'hook') => worker.fetch(new Request('https://ts.test/telegram/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { message_id: 1, text, chat: { id: chatId } } }),
  }), env);

  test('sai mã bí mật webhook thì 403, không trả lời', async () => {
    assert.equal((await hook('/homnay', -100777, 'sai')).status, 403);
    assert.equal(tgCalls.length, 0);
  });

  test('/chatid trả lời ở mọi chat (để lấy id lúc cài đặt)', async () => {
    await hook('/chatid', 555);
    assert.match(sent('sendMessage')[0].body.text, /555/);
  });

  test('/homnay và /homnay@tenbot trả lời trong group đã cấu hình, bỏ qua chat lạ', async () => {
    setNow('2026-10-26T10:00:00');
    await addEmp('NV01', 'An');
    await hook('/homnay'); await hook('/homnay@test_bot'); await hook('/homnay', 999);
    assert.equal(sent('sendMessage').length, 2);
    assert.match(sent('sendMessage')[0].body.text, /Chấm công 26\/10\/2026/);
  });

  test('cập nhật không có tin nhắn (ví dụ bot được thêm vào group) không làm lỗi', async () => {
    const r = await worker.fetch(new Request('https://ts.test/telegram/webhook', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook' }, body: JSON.stringify({ my_chat_member: {} }),
    }), env);
    assert.equal(r.status, 200);
  });

  test('kết nối bot: đặt webhook kèm mã bí mật và danh sách lệnh', async () => {
    const r = await call('POST', '/api/setup', { code: ROOT });
    assert.equal(r.data.bot, 'test_bot');
    const wh = sent('setWebhook')[0].body;
    assert.equal(wh.url, 'https://ts.test/telegram/webhook');
    assert.equal(wh.secret_token, 'hook');
  });
});

// ---------- Tự động nhắc và tổng hợp ----------
describe('Lịch tự động', () => {
  const run = async () => { const jobs = []; await worker.scheduled({}, env, { waitUntil: p => jobs.push(p) }); await Promise.all(jobs); };

  test('09:00 nhắc đúng người chưa check-in, có tag @username', async () => {
    setNow('2026-10-26T08:00:00');
    const a = await addEmp('NV01', 'An'); await addEmp('NV02', 'Bình', { tg: '@binh' });
    await punch(a, 'in');
    setNow('2026-10-26T09:00:00'); await run();
    const t = sent('sendMessage')[0].body.text;
    assert.match(t, /Nhắc check-in/); assert.match(t, /Bình @binh/); assert.doesNotMatch(t, /An/);
  });

  test('18:30 tổng hợp: cảnh báo quên check-out và chưa check-in, tính giờ làm', async () => {
    const a = await addEmp('NV01', 'An'), b = await addEmp('NV02', 'Bình'); await addEmp('NV03', 'Cường');
    setNow('2026-10-26T08:00:00'); await punch(a, 'in'); await punch(b, 'in');
    setNow('2026-10-26T17:30:00'); await punch(a, 'out');
    setNow('2026-10-26T18:30:00'); await run();
    const t = sent('sendMessage')[0].body.text;
    assert.match(t, /An: 08:00 → 17:30 \(9g30\)/);
    assert.match(t, /Quên check-out \(1\)[\s\S]*Bình/);
    assert.match(t, /Chưa check-in \(1\)[\s\S]*Cường/);
  });

  test('23:00 nhắc người ca tối chưa check-in, không nhắc người ca sáng', async () => {
    await addEmp('NV01', 'An'); await addEmp('NV02', 'Bình', { shift: 'toi', tg: 'binh' });
    setNow('2026-10-26T23:00:00'); await run();
    const t = sent('sendMessage')[0].body.text;
    assert.match(t, /Nhắc check-in Ca tối 26\/10\/2026/); assert.match(t, /Bình @binh/); assert.doesNotMatch(t, /An/);
  });

  test('07:00 tổng hợp ca tối hôm trước: tính giờ qua nửa đêm, cảnh báo quên check-out', async () => {
    const a = await addEmp('NV01', 'An', { shift: 'toi' }), b = await addEmp('NV02', 'Bình', { shift: 'toi' });
    setNow('2026-10-26T22:00:00'); await punch(a, 'in', { shift: 'toi' }); await punch(b, 'in', { shift: 'toi' });
    setNow('2026-10-27T06:00:00'); await punch(a, 'out');
    setNow('2026-10-27T07:00:00'); await run();
    const t = sent('sendMessage')[0].body.text;
    assert.match(t, /Chấm công 26\/10\/2026/);
    assert.match(t, /An: 22:00 → 06:00 \(8g00\)/);
    assert.match(t, /Quên check-out \(1\)[\s\S]*Bình/);
  });

  test('/homnay hiện cả hai ca', async () => {
    const a = await addEmp('NV01', 'An'), b = await addEmp('NV02', 'Bình', { shift: 'toi' });
    setNow('2026-10-26T08:00:00'); await punch(a, 'in');
    setNow('2026-10-26T22:00:00'); await punch(b, 'in', { shift: 'toi' });
    await call('POST', '/api/report-now', { code: ROOT });
    const t = sent('sendMessage')[0].body.text;
    assert.match(t, /Ca sáng 08:00–17:00[\s\S]*An/); assert.match(t, /Ca tối 22:00–06:00[\s\S]*Bình/);
  });

  test('Lỗi đã gặp: không nhắc và không tổng hợp vào ngày lễ (HOLIDAYS)', async () => {
    env.HOLIDAYS = '2026-09-02, 2026-10-26';
    await addEmp('NV01', 'An');
    setNow('2026-10-26T09:00:00'); await run();
    setNow('2026-10-26T18:30:00'); await run();
    assert.equal(sent('sendMessage').length, 0);
    setNow('2026-10-27T09:00:00'); await run();
    assert.equal(sent('sendMessage').length, 1);
  });

  test('Lỗi đã gặp: "Gửi tổng hợp ngay" giữa ngày không gọi người đang làm là "quên check-out"', async () => {
    const a = await addEmp('NV01', 'An');
    setNow('2026-10-26T08:00:00'); await punch(a, 'in');
    setNow('2026-10-26T10:00:00');
    await call('POST', '/api/report-now', { code: ROOT });
    const t = sent('sendMessage')[0].body.text;
    assert.doesNotMatch(t, /Quên check-out/);
    assert.match(t, /Đang làm việc/);
  });
});

test('đường dẫn không phải API thì trả về giao diện', async () => {
  const r = await worker.fetch(new Request('https://ts.test/index.html'), env);
  assert.equal(await r.text(), 'asset');
});

describe('Số đo Core Web Vitals (/api/vitals)', () => {
  const sample = { id: 'abc', device: 'phone', view: 'kiosk', net: '4g', metrics: {
    LCP: { value: 1830, rating: 'good', target: 'main>#stage', loadDelay: 12, secret: 'x' },
    INP: { value: 240, rating: 'needs-improvement', inputDelay: 180, processing: 30, presentation: 30, script: { url: 'https://cdn/face-api.js', fn: 'detect', ms: 170, extra: 1 } },
    CLS: { value: 0.04, rating: 'good', target: '.msg-card' },
    HACK: { value: 1 },
  } };
  test('không cần đăng nhập, chỉ ghi một dòng log, không ghi KV (không tốn hạn mức ghi)', async () => {
    const logs = mock.method(console, 'log', () => {});
    const before = env.KV.puts || 0;
    const r = await call('POST', '/api/vitals', { json: sample });
    assert.equal(r.status, 204);
    assert.equal(env.KV.puts || 0, before, 'không ghi KV');
    assert.equal(logs.mock.callCount(), 1);
    const line = JSON.parse(logs.mock.calls[0].arguments[0]);
    logs.mock.restore();
    assert.equal(line.type, 'web-vitals');
    assert.deepEqual(Object.keys(line.metrics).sort(), ['CLS', 'INP', 'LCP'], 'bỏ số đo lạ');
    assert.equal(line.metrics.LCP.secret, undefined, 'bỏ trường lạ');
    assert.equal(line.metrics.INP.script.fn, 'detect');
    assert.equal(line.metrics.INP.script.extra, undefined);
  });
  test('gói quá lớn hoặc hỏng thì từ chối; không có số đo nào thì không ghi gì', async () => {
    assert.equal((await call('POST', '/api/vitals', { json: { metrics: { LCP: { value: 1, target: 'x'.repeat(5000) } } } })).status, 413);
    assert.equal((await call('POST', '/api/vitals', { body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
    const logs = mock.method(console, 'log', () => {});
    assert.equal((await call('POST', '/api/vitals', { json: { metrics: {} } })).status, 204);
    assert.equal(logs.mock.callCount(), 0);
    logs.mock.restore();
  });
});
