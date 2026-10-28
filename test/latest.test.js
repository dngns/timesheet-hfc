// Test "chỉ lấy lần bấm cuối" cho bộ lọc Bảng công (public/latest.js).
// Chạy: npm test. Test ghi "Lỗi đã gặp" tái hiện lỗi đã tìm ra, không được xoá.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { latestOnly } = require('../public/latest.js');

test('Lỗi đã gặp: bấm liên tục các chip lọc thì mỗi lần bấm gọi API một lần', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = [];
    const load = latestOnly((signal, range) => { calls.push(range); }, 300);
    for (const r of ['today', '7d', 'month', 'lastmonth', 'month', '7d', 'today', 'lastmonth']) { load.run(r); mock.timers.tick(100); }
    assert.deepEqual(calls, [], 'đang bấm thì chưa gọi');
    mock.timers.tick(300);
    assert.deepEqual(calls, ['lastmonth'], 'chỉ gọi đúng lần bấm cuối');
  } finally { mock.timers.reset(); }
});

test('lần gọi mới huỷ request cũ đang chạy (AbortController)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const signals = [];
    const load = latestOnly(signal => { signals.push(signal); }, 300);
    load.run('a'); mock.timers.tick(300);
    load.run('b'); mock.timers.tick(300);
    assert.equal(signals.length, 2);
    assert.equal(signals[0].aborted, true, 'request cũ bị huỷ');
    assert.equal(signals[1].aborted, false);
  } finally { mock.timers.reset(); }
});

test('cancel(): rời trang thì huỷ cả lần gọi đang chờ lẫn request đang chạy', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const signals = [], calls = [];
    const load = latestOnly((signal, r) => { signals.push(signal); calls.push(r); }, 300);
    load.run('a'); mock.timers.tick(300);
    load.run('b'); load.cancel(); mock.timers.tick(1000);
    assert.deepEqual(calls, ['a'], 'lần đang chờ không chạy nữa');
    assert.equal(signals[0].aborted, true, 'request đang chạy bị huỷ');
  } finally { mock.timers.reset(); }
});

test('app.js: chip lọc và ô ngày đi qua latestOnly; chuyển trang thì huỷ', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert.match(app, /const historyLoader = latestOnly\(/);
  assert.match(app.match(/async function loadHistory\([^)]*\) \{[\s\S]*?\n\}\n/)[0], /historyLoader\.(run|cancel)\(/);
  assert.match(app.match(/function showView\(v\) \{[\s\S]*?\n\}\n/)[0], /historyLoader\.cancel\(\)/);
  assert.match(app, /AbortError/, 'request bị huỷ không báo lỗi');
  assert.ok(html.indexOf('src="latest.js"') > 0 && html.indexOf('src="latest.js"') < html.indexOf('src="app.js"'));
  assert.match(sw, /'latest\.js'/);
});
