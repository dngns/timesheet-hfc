// Test luật tự check-in (public/autopunch.js) và cách app.js nối vào. Chạy: npm test.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DELAY_MS, canAuto, secondsLeft } = require('../public/autopunch.js');

const ready = { verified: true, canPunch: true, action: 'in', attempted: false, dialogOpen: false, hidden: false, enrolling: false };

describe('Luật tự check-in', () => {
  test('đủ điều kiện thì tự check-in', () => assert.equal(canAuto(ready), true));
  test('chưa xác minh xong (kể cả còn bước quay nhẹ đầu) thì không tự chấm', () => {
    assert.equal(canAuto({ ...ready, verified: false }), false);
  });
  test('không bao giờ tự check-out: mở app giữa ca để xem giờ không được ghi ra ca', () => {
    assert.equal(canAuto({ ...ready, action: 'out' }), false);
  });
  test('mỗi lần xác minh chỉ tự chấm một lần: đã Huỷ hoặc đã thử (kể cả bị từ chối) thì phải bấm tay', () => {
    assert.equal(canAuto({ ...ready, attempted: true }), false);
  });
  test('nút đang khoá (không có ca mở, đang gửi, vừa chấm xong) thì không tự chấm', () => {
    assert.equal(canAuto({ ...ready, canPunch: false }), false);
  });
  test('đang mở hộp thoại, đang đăng ký khuôn mặt hoặc app chạy nền thì không tự chấm', () => {
    assert.equal(canAuto({ ...ready, dialogOpen: true }), false);
    assert.equal(canAuto({ ...ready, enrolling: true }), false);
    assert.equal(canAuto({ ...ready, hidden: true }), false);
  });
  test('đếm 3 giây, làm tròn lên', () => {
    assert.equal(DELAY_MS, 3000);
    assert.equal(secondsLeft(10000, 7000), 3);
    assert.equal(secondsLeft(10000, 7001), 3);
    assert.equal(secondsLeft(10000, 9999), 1);
    assert.equal(secondsLeft(10000, 10500), 0);
  });
});

describe('app.js nối tự check-in', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  test('dùng luật trong autopunch.js, không tự viết lại', () => {
    assert.match(app, /= AutoPunch;/);
    assert.match(app, /canAuto\(\{/);
    assert.doesNotMatch(app, /const DELAY_MS\s*=/);
  });
  test('hết giờ đếm thì gọi đúng hàm chấm công (vẫn kiểm tra xác minh còn mới)', () => {
    const fire = app.match(/function fireAuto\(\) \{[\s\S]*?\n\}\n/)[0];
    assert.match(fire, /auto\.attempted = true/, 'đánh dấu đã thử trước khi chấm');
    assert.match(fire, /punch\(\)/);
    assert.match(app, /async function punch\(\) \{\n  if \(!current[^\n]*\n  if \(!verifier\.isFresh\(Date\.now\(\)\)\)/);
  });
  test('mất mặt hoặc người khác vào khung thì dừng đếm và cho tự chấm lại ở lần xác minh sau', () => {
    const body = app.match(/function setCurrent\([^)]*\) \{[\s\S]*?\n\}\n/)[0];
    assert.match(body, /if \(!emp\) \{ stopAuto\(\); auto\.attempted = false; \}/);
  });
  test('có nút Huỷ và vòng đếm quanh oval; file mới được nạp và lưu offline', () => {
    assert.match(html, /id="btnAutoCancel"/);
    assert.match(html, /class="ring"/);
    assert.match(app, /\$\('btnAutoCancel'\)\.onclick/);
    assert.ok(html.indexOf('src="autopunch.js"') > 0 && html.indexOf('src="autopunch.js"') < html.indexOf('src="app.js"'));
    assert.match(sw, /'autopunch\.js'/);
  });
});
