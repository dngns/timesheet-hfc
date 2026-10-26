// Mô phỏng nhiều ngày dùng thật để đo hạn mức gói miễn phí (KV, request, Telegram, giới hạn tần suất).
// Chạy Worker thật (src/worker.js) trong Node với KV trong bộ nhớ và Telegram giả lập; phía app mô phỏng theo
// đúng nhịp của public/app.js (làm mới 5 phút/lần, hàng đợi gửi lại theo public/retry.js).
//
// Chạy:  npm run simulate               (30 người, 3 ngày)
//        npm run simulate -- 100 5      (100 người, 5 ngày)
// Test test/capacity.test.js dùng file này để chặn việc vượt hạn mức quay lại.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { retryDelay, isRetryable } = require('../public/retry.js');

// Hạn mức gói Workers Free (mỗi ngày tính theo 00:00 UTC = 07:00 giờ Việt Nam)
export const FREE = { requests: 100000, reads: 100000, writes: 1000, lists: 1000, deletes: 1000, tgPerMin: 20 };

// Giới hạn tần suất đọc thẳng từ wrangler.toml để mô phỏng đúng cấu hình sẽ deploy
export function readRateLimits(file = path.join(here, '../wrangler.toml')) {
  const out = {};
  const re = /name\s*=\s*"(\w+)"[^\n]*\n[^\[]*?simple\s*=\s*\{\s*limit\s*=\s*(\d+),\s*period\s*=\s*(\d+)\s*\}/g;
  for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) out[m[1]] = { limit: +m[2], period: +m[3] };
  return out;
}

// ---------- đồng hồ giả: worker dùng Date.now() và new Date() ----------
const RealDate = Date;
let NOW = 0;
class FakeDate extends RealDate {
  constructor(...a) { a.length ? super(...a) : super(NOW); }
  static now() { return NOW; }
}
const vn = s => RealDate.parse(s + '+07:00');
const utcDay = t => new RealDate(t).toISOString().slice(0, 10);
const vnDate = t => new RealDate(t + 7 * 3600e3).toISOString().slice(0, 10);
const addDays = (date, n) => { const d = new RealDate(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// số ngẫu nhiên cố định theo seed: chạy lại ra đúng kết quả cũ
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ---------- môi trường giả lập ----------
class SimKV {
  constructor(m) { this.m = new Map(); this.metric = m; this.putFail = null; this.listFail = null; }
  async get(k, type) { this.metric('reads'); const v = this.m.get(k); return v ? (type === 'json' ? JSON.parse(v.value) : v.value) : null; }
  async getWithMetadata(k) { this.metric('reads'); const v = this.m.get(k); return { value: v ? v.value : null, metadata: v?.metadata ?? null }; }
  async put(k, value, opts = {}) {
    if (this.putFail?.(k)) throw new Error('KV put() limit exceeded for the day.');
    this.metric('writes'); this.m.set(k, { value, metadata: opts.metadata });
  }
  async delete(k) { this.metric('deletes'); this.m.delete(k); }
  async list({ prefix = '', cursor } = {}) {
    if (this.listFail?.()) throw new Error('KV list() limit exceeded for the day.');
    this.metric('lists');
    const keys = [...this.m.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0, page = keys.slice(start, start + 1000), done = start + 1000 >= keys.length;
    return { keys: page.map(name => ({ name, metadata: this.m.get(name).metadata })), list_complete: done, cursor: done ? undefined : String(start + 1000) };
  }
}
// Workers Rate Limiting: đếm theo cửa sổ `period` giây cho từng key
class SimRL {
  constructor(name, { limit, period }, sim) { Object.assign(this, { name, max: limit, period, sim }); this.n = new Map(); }
  async limit({ key }) {
    const k = key + '@' + Math.floor(NOW / (this.period * 1000));
    const n = (this.n.get(k) || 0) + 1; this.n.set(k, n);
    const peak = this.sim.rlPeak[this.name] || { n: 0 };
    if (n > peak.n) this.sim.rlPeak[this.name] = { n, key, at: NOW };
    if (n > this.max) this.sim.metric('blocked:' + this.name);
    return { success: n <= this.max };
  }
}

/**
 * opts: users (số nhân viên), days, adminTabs (số máy quản trị mở app cả ngày), seed,
 *       legacyClient (app cũ: hàng đợi 30 giây/lần luôn tải lại bảng công, thử lại không giãn cách),
 *       workerPath (chạy với bản worker khác, vd bản cũ để so sánh), rateLimits (mặc định đọc wrangler.toml),
 *       faults: [{ kind: 'writes'|'lists', from: 'YYYY-MM-DDTHH:mm', to: '...' }] (giờ Việt Nam)
 */
export async function simulate(opts = {}) {
  const o = { users: 30, days: 3, adminTabs: 1, seed: 7, legacyClient: false, faults: [], ...opts };
  const rateLimits = o.rateLimits || readRateLimits();
  const worker = (await import(pathToFileURL(o.workerPath || path.join(here, '../src/worker.js')).href)).default;
  const rand = rng(o.seed);

  const sim = { byDay: {}, rlPeak: {}, tgByMin: new Map(), photos: new Map(), errors: {}, samples: {} };
  sim.metric = (name, n = 1) => { const d = (sim.byDay[utcDay(NOW)] ||= {}); d[name] = (d[name] || 0) + n; };
  const env = {
    TZ_OFFSET: '7', LATE_GRACE_MIN: '30', ADMIN_KEY: 'root-sim', BOT_TOKEN: 'tok', WEBHOOK_SECRET: 'hook', TELEGRAM_CHAT_ID: '-1',
    TELEGRAM_API: 'http://tg.sim', ASSETS: { fetch: async () => new Response('asset') },
  };
  env.KV = new SimKV(sim.metric);
  for (const [name, cfg] of Object.entries(rateLimits)) env[name] = new SimRL(name, cfg, sim);

  const realFetch = globalThis.fetch, realDateCtor = globalThis.Date;
  let msgId = 0;
  globalThis.Date = FakeDate;
  globalThis.fetch = async (url, init = {}) => {
    const method = String(url).split('/').pop();
    if (method === 'sendPhoto' || method === 'sendMessage') {
      const min = Math.floor(NOW / 60000);
      sim.tgByMin.set(min, (sim.tgByMin.get(min) || 0) + 1);
      sim.metric('tg:' + method);
    }
    if (method === 'sendPhoto') {
      const name = init.body.get('photo').name;   // `${code}_${type}_${ts}.jpg`: một lượt chấm công
      sim.photos.set(name, (sim.photos.get(name) || 0) + 1);
    }
    const id = ++msgId;
    const result = method === 'sendPhoto' ? { message_id: id, photo: [{ file_id: 'F' + id }] } : method === 'getMe' ? { username: 'sim_bot' } : { message_id: id };
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
  };

  // ---------- hàng đợi sự kiện theo thời gian ----------
  const events = [];
  const at = (t, fn) => { let i = events.length; while (i && events[i - 1].t > t) i--; events.splice(i, 0, { t, fn }); };

  async function call(method, p, { code, json, form, ip = 'office' } = {}) {
    const h = { 'CF-Connecting-IP': ip };
    if (code) h['X-Access-Code'] = code;
    let body;
    if (json !== undefined) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
    if (form) { body = new FormData(); for (const [k, v] of Object.entries(form)) body.append(k, v); }
    sim.metric('requests'); sim.metric('req ' + p.split('?')[0]);
    const res = await worker.fetch(new Request('https://sim.test' + p, { method, headers: h, body }), env);
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (res.status >= 400) {
      const k = `${res.status} ${p.split('?')[0]}`;
      sim.errors[k] = (sim.errors[k] || 0) + 1;
      if ((sim.samples[k] ||= []).length < 3) sim.samples[k].push(`${new RealDate(NOW + 7 * 3600e3).toISOString().slice(5, 16)} ${data?.error || data}`);
    }
    return { status: res.status, data };
  }
  const cron = async () => {
    sim.metric('requests'); sim.metric('cron');
    const pending = [];
    await worker.scheduled({ scheduledTime: NOW }, env, { waitUntil: p => pending.push(p) });
    await Promise.allSettled(pending);
  };

  // ---------- người dùng ----------
  const start = vnDate(vn('2026-11-02T00:00:00'));   // thứ Hai
  NOW = vn(`${addDays(start, -1)}T12:00:00`);
  const admin = { code: 'QL01', name: 'Quản lý', role: 1, shift: 'sang' };
  const staff = Array.from({ length: o.users }, (_, i) => ({
    code: 'NV' + String(i + 1).padStart(3, '0'), name: 'Nhân viên ' + (i + 1), role: 2, shift: rand() < 0.8 ? 'sang' : 'toi',
  }));
  const imp = await call('POST', '/api/employees/import', { code: env.ADMIN_KEY, json: { rows: [admin, ...staff] } });
  const access = new Map(imp.data.created.map(c => [c.code, c.accessCode]));
  sim.byDay = {};   // không tính lượt nhập danh sách ban đầu

  // máy của từng người: hàng đợi offline như public/app.js
  const devices = new Map();
  const device = code => devices.get(code) || devices.set(code, { queue: [], code, key: access.get(code) }).get(code);
  const photo = () => new File([new Uint8Array(20 * 1024)], 'p.jpg', { type: 'image/jpeg' });

  async function sendPunch(dev, item) {
    return call('POST', '/api/punch', { code: dev.key, form: { type: item.type, ts: String(item.ts), photo: photo(), ...(item.shift ? { shift: item.shift } : {}) } });
  }
  async function loadToday(dev) {
    // app mới: ngày hôm qua chỉ tải trước 12:00; app cũ: luôn tải hôm qua + hôm nay
    const hour = new RealDate(NOW + 7 * 3600e3).getUTCHours();
    const from = o.legacyClient || hour < 12 ? addDays(vnDate(NOW), -1) : vnDate(NOW);
    if (dev.isAdmin) await call('GET', `/api/logs?from=${from}&to=${vnDate(NOW)}`, { code: dev.key });
    await call('GET', '/api/status', { code: dev.key });
  }
  async function flushQueue(dev, force) {
    let sent = 0;
    while (dev.queue.length) {
      const item = dev.queue[0];
      if (!o.legacyClient && !force && item.nextAt > NOW) break;
      const r = await sendPunch(dev, item);
      if (r.status === 200) { dev.queue.shift(); sent++; continue; }
      if (isRetryable(r.status) || (o.legacyClient && r.status >= 500)) {
        item.tries = (item.tries || 0) + 1; item.nextAt = NOW + retryDelay(item.tries);
        break;
      }
      dev.queue.shift();
    }
    if (sent || o.legacyClient) await loadToday(dev);
  }
  // app mở trên máy: vòng gửi lại 30 giây/lần trong `minutes` phút
  function keepOpen(dev, minutes) {
    dev.openUntil = Math.max(dev.openUntil || 0, NOW + minutes * 60e3);
    if (dev.ticking) return;
    dev.ticking = true;
    const tick = () => at(NOW + 30e3, async () => {
      if (NOW > dev.openUntil) { dev.ticking = false; return; }
      await flushQueue(dev); tick();
    });
    tick();
  }
  async function punchSession(dev, wantShift) {
    // mở app: tải người dùng, gửi các lượt chờ, rồi nút chấm công theo trạng thái mới nhất
    // (app.js: loadMe → loadToday → flushQueue, gửi được lượt nào thì loadToday lại)
    await call('GET', '/api/me', { code: dev.key });
    await flushQueue(dev);
    const st = (await call('GET', '/api/status', { code: dev.key })).data;
    // nút chấm công tính cả lượt đang chờ gửi (currentOpen trong app.js)
    let open = !!st?.open;
    for (const q of dev.queue) open = q.type === 'in';
    const type = open ? 'out' : 'in';
    const item = { type, ts: NOW, shift: type === 'in' ? wantShift : undefined };
    if (!o.legacyClient && dev.queue.length) {
      await flushQueue(dev, true);
      if (dev.queue.length) { dev.queue.push({ ...item, nextAt: 0 }); keepOpen(dev, 10); return; }
    }
    const r = await sendPunch(dev, item);
    if (r.status >= 500 || r.status === 0) { item.tries = 1; item.nextAt = NOW + retryDelay(1); dev.queue.push(item); }
    await loadToday(dev);
    keepOpen(dev, 10);   // người dùng để app mở thêm vài phút
  }

  // ---------- lịch mỗi ngày ----------
  const minutes = (base, spreadMin) => vn(base) + Math.round(rand() * spreadMin * 60e3);
  for (let d = 0; d < o.days; d++) {
    const day = addDays(start, d), next = addDays(day, 1);
    for (const e of staff) {
      const dev = device(e.code);
      if (e.shift === 'sang') {
        // đến trong 07:40–08:10, dồn nhiều quanh 07:55
        const tin = vn(`${day}T07:40:00`) + Math.round((rand() + rand() + rand()) / 3 * 30 * 60e3);
        at(tin, () => punchSession(dev, 'sang'));
        if (rand() < 0.95) at(minutes(`${day}T17:00:00`, 25), () => punchSession(dev, 'sang'));
        if (rand() < 0.10) at(minutes(`${day}T19:00:00`, 60), () => punchSession(dev, 'sang'));   // tăng ca
      } else {
        at(minutes(`${day}T21:45:00`, 25), () => punchSession(dev, 'toi'));
        if (rand() < 0.95) at(minutes(`${next}T06:00:00`, 20), () => punchSession(dev, 'toi'));
      }
    }
    // quản lý: chấm công như nhân viên + mở Bảng công cả ngày trên `adminTabs` máy
    const adm = device(admin.code); adm.isAdmin = true;
    at(vn(`${day}T07:50:00`), () => punchSession(adm, 'sang'));
    at(vn(`${day}T17:30:00`), () => punchSession(adm, 'sang'));
    for (let tab = 0; tab < o.adminTabs; tab++) {
      const t = { ...adm, queue: [], isAdmin: true };
      at(vn(`${day}T07:30:00`) + tab * 7e3, async () => {
        await call('GET', '/api/me', { code: t.key }); await call('GET', '/api/employees', { code: t.key });
        await loadToday(t);
        keepOpen(t, 11 * 60);
      });
      // tự làm mới 5 phút/lần khi đang mở (07:30–18:30)
      for (let m = 5; m <= 11 * 60; m += 5) at(vn(`${day}T07:30:00`) + m * 60e3 + tab * 7e3, () => loadToday(t));
      // xem lịch sử: tháng này 3 lần, tháng trước 1 lần
      for (const h of ['09:00', '13:00', '17:45']) {
        at(vn(`${day}T${h}:00`) + tab * 9e3, () => call('GET', `/api/logs?from=${day.slice(0, 8)}01&to=${day}`, { code: t.key }));
      }
      at(vn(`${day}T16:00:00`), () => {
        const first = new RealDate(day.slice(0, 8) + '01T00:00:00Z'); first.setUTCMonth(first.getUTCMonth() - 1);
        const from = first.toISOString().slice(0, 10), to = addDays(day.slice(0, 8) + '01', -1);
        return call('GET', `/api/logs?from=${from}&to=${to}`, { code: t.key });
      });
    }
    // cron (giờ Việt Nam): 07:00, 09:00, 18:30, 23:00
    for (const h of ['07:00', '09:00', '18:30', '23:00']) at(vn(`${day}T${h}:00`), cron);
    // bot: /homnay 3 lần/ngày trong group
    for (const h of ['08:30', '12:00', '17:15']) at(vn(`${day}T${h}:00`), async () => {
      sim.metric('requests');
      await worker.fetch(new Request('https://sim.test/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook' },
        body: JSON.stringify({ message: { message_id: 1, text: '/homnay', chat: { id: -1 } } }) }), env);
    });
  }

  // sự cố: hết hạn mức ghi hoặc liệt kê trong một khoảng giờ
  for (const f of o.faults) {
    const from = vn(f.from), to = vn(f.to);
    if (f.kind === 'writes') env.KV.putFail = () => NOW >= from && NOW < to;
    if (f.kind === 'lists') env.KV.listFail = () => NOW >= from && NOW < to;
  }

  try {
    while (events.length) {
      const e = events.shift();
      NOW = e.t;
      await e.fn();
    }
  } finally {
    globalThis.fetch = realFetch; globalThis.Date = realDateCtor;
  }

  const stuck = [...devices.values()].reduce((n, dev) => n + dev.queue.length, 0);
  const dupPhotos = [...sim.photos.values()].filter(n => n > 1).length;
  const tgPeak = Math.max(0, ...sim.tgByMin.values());
  return { opts: o, byDay: sim.byDay, rlPeak: sim.rlPeak, rateLimits, tgPeak, dupPhotos, photos: sim.photos.size, stuck, errors: sim.errors, samples: sim.samples };
}

// ---------- in kết quả ----------
export function report(r) {
  const lines = [];
  const pct = (v, max) => `${v ?? 0}`.padStart(6) + ` / ${max}`.padEnd(9) + ` (${Math.round((v || 0) / max * 100)}%)`;
  lines.push(`Mô phỏng ${r.opts.users} nhân viên + 1 quản lý (${r.opts.adminTabs} máy mở Bảng công cả ngày), ${r.opts.days} ngày` +
    (r.opts.legacyClient ? ', app CŨ' : '') + (r.opts.faults.length ? `, sự cố: ${r.opts.faults.map(f => `${f.kind} ${f.from}→${f.to}`).join(', ')}` : ''));
  lines.push('Ngày (UTC)   Request            Đọc KV             Ghi KV             List KV');
  for (const [day, m] of Object.entries(r.byDay).sort()) {
    lines.push(`${day}  ${pct(m.requests, FREE.requests)}  ${pct(m.reads, FREE.reads)}  ${pct(m.writes, FREE.writes)}  ${pct(m.lists, FREE.lists)}`);
  }
  lines.push(`Telegram: cao nhất ${r.tgPeak} tin/phút (giới hạn group ~${FREE.tgPerMin}). Ảnh: ${r.photos} lượt, ${r.dupPhotos} lượt bị gửi lặp. Còn kẹt trong hàng đợi: ${r.stuck}.`);
  for (const [name, cfg] of Object.entries(r.rateLimits)) {
    const p = r.rlPeak[name];
    const blocked = Object.values(r.byDay).reduce((n, m) => n + (m['blocked:' + name] || 0), 0);
    lines.push(`${name.padEnd(9)} cao nhất ${String(p?.n || 0).padStart(4)} / ${cfg.limit} trong ${cfg.period}s` + (blocked ? `, BỊ CHẶN ${blocked} lần` : ', không chặn ai'));
  }
  if (Object.keys(r.errors).length) lines.push('Lỗi trả về: ' + Object.entries(r.errors).map(([k, v]) => `${k} ×${v}`).join(', '));
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [users = 30, days = 3, adminTabs = 1] = process.argv.slice(2).map(Number);
  console.log(report(await simulate({ users, days, adminTabs })));
}
