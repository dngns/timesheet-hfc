// Test gửi lại lượt chấm công chờ và cách báo lỗi trên app (public/retry.js, public/app.js).
// Chạy: npm test. Test ghi "Lỗi đã gặp" tái hiện lỗi đã tìm ra, không được xoá.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const fn = name => app.match(new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))[0];

describe('retry.js', () => {
  const { retryDelay, isRetryable, describeError } = require('../public/retry.js');

  test('Lỗi đã gặp: hàng đợi thử lại 30 giây/lần mãi mãi; giờ giãn dần 30 giây, 1, 2, 4, 8 phút, tối đa 15 phút', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(retryDelay), [30e3, 60e3, 120e3, 240e3, 480e3, 900e3, 900e3]);
  });

  test('Lỗi đã gặp: bị giới hạn tần suất (429) không được bỏ lượt chờ gửi', () => {
    assert.equal(isRetryable(0), true, 'mất mạng');
    assert.equal(isRetryable(500), true);
    assert.equal(isRetryable(429), true);
    assert.equal(isRetryable(409), false, 'bị từ chối thật (vd đã check-in) thì bỏ');
    assert.equal(isRetryable(400), false);
  });

  test('Lỗi đã gặp: server lỗi bị báo là mất mạng', () => {
    assert.match(describeError(0, 'Failed to fetch'), /mạng/);
    assert.match(describeError(500, 'KV put() limit exceeded'), /^Server đang lỗi/);
    assert.doesNotMatch(describeError(500, 'x'), /mạng/);
    assert.match(describeError(429, 'Chờ 1 phút'), /Chờ 1 phút/);
  });
});

describe('app.js báo lỗi và chống bấm lặp', () => {
  test('index.html và service worker nạp retry.js trước app.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
    assert.ok(html.indexOf('src="retry.js"') > 0 && html.indexOf('src="retry.js"') < html.indexOf('src="app.js"'));
    assert.match(sw, /'retry\.js'/);
  });

  test('Lỗi đã gặp: chấm công lỗi server (5xx) hiện "sẽ gửi khi có mạng" dù mạng bình thường', () => {
    const body = fn('punch');
    assert.match(body, /describeError\(/);
    assert.match(body, /nextAt:/, 'lượt lưu vào hàng đợi có giờ thử lại');
  });

  test('Lỗi đã gặp: hàng đợi bỏ lượt khi bị 429 và thử lại không giãn cách', () => {
    const body = fn('flushQueue');
    assert.match(body, /isRetryable\(/);
    assert.match(body, /retryDelay\(/);
    assert.match(body, /nextAt/);
  });

  test('Lỗi đã gặp: không tải được trạng thái ca thì app im lặng, có thể hiện sai nút', () => {
    const body = fn('loadToday');
    assert.doesNotMatch(body, /catch \{\}/);
    assert.match(body, /showSyncWarn\(/);
  });

  test('Lỗi đã gặp: còn lượt chờ gửi mà chấm tiếp thì lượt mới tới server trước lượt cũ, bị từ chối (409)', () => {
    // vd check-in lúc mất kết nối nằm trong hàng đợi (chờ giờ thử lại), app hiện Check-out, bấm thì lượt ra tới trước lượt vào
    const body = fn('punch');
    const flush = body.indexOf('flushQueue(true)'), send = body.indexOf('sendPunch(item)');
    assert.ok(flush > 0 && flush < send, 'gửi các lượt chờ trước khi gửi lượt mới');
    assert.match(body, /QueuedBehind/, 'lượt cũ vẫn chưa gửi được thì lượt mới xếp hàng sau');
  });

  test('Lỗi đã gặp: máy quản trị tải bảng công 5 phút/lần cả khi không mở Bảng công (3 máy ~ 90% hạn mức list KV)', () => {
    const body = fn('loadToday');
    assert.match(body, /if \(isAdmin\(\) && todayOpen\(\)\)/);
    assert.match(body, /getHours\(\) < 12/, 'ngày hôm qua chỉ cần trước 12:00 (ca tối hôm qua còn mở)');
  });

  test('Lỗi đã gặp: các nút gửi lên server bấm nhiều lần thì gửi nhiều lần', () => {
    for (const id of ['btnSetup', 'btnReport', 'btnNewCode', 'btnDeleteEmp']) {
      assert.match(app, new RegExp(`\\$\\('${id}'\\)\\.onclick = [\\s\\S]{0,400}?busy\\(`), id);
    }
    assert.match(app, /\$\('onboardForm'\)\.onsubmit = [\s\S]{0,300}?busy\(/, 'nút kích hoạt');
  });
});
