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

  test('lỗi máy chủ kèm mã tra cứu để báo quản trị viên tra trong log', () => {
    assert.match(describeError(500, 'Máy chủ gặp lỗi', 'abc123-SIN'), /mã tra cứu: abc123-SIN/);
    assert.doesNotMatch(describeError(409, 'Đã check-in', 'abc123-SIN'), /mã tra cứu/, 'lỗi nghiệp vụ không cần mã tra cứu');
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

  test('Lỗi đã gặp: đang tối vẫn chọn được ca sáng (app không khoá ca ngoài khung giờ)', () => {
    const body = app.match(/function renderShift\(\) \{[\s\S]*?\n\}\n/)[0];
    assert.match(body, /isShiftOpen\(/);
    // ô ca ngoài khung giờ bị khoá và ghi giờ mở; app chỉ tự chọn ca đang mở và chưa chấm; không có thì nút khoá và ghi giờ mở
    assert.match(body, /\$\{off\(k\) \? 'disabled' : ''\}/, 'ô ca ngoài khung giờ bị khoá');
    assert.match(body, /closed\(k\) \? `Mở \$\{opensAt\(k\)\}`/, 'ô ca khoá ghi giờ mở');
    assert.match(body, /chosenShift = !off\(sug\) \? sug : Object\.keys\(SHIFTS\)\.find\(k => !off\(k\)\) \|\| null/, 'chỉ chọn ca đang mở');
    assert.match(body, /mở lúc \$\{opensAt\(k\)\}/, 'ghi giờ mở của ca');
    assert.match(app.match(/function updatePunch\(\) \{[\s\S]*?\n\}\n/)[0], /act === 'in' && !SHIFTS\[chosenShift\]/, 'không có ca đang mở thì không check-in được');
  });

  test('Lỗi đã gặp: chuyển qua lại giữa các tab thì bảng công "Hôm nay" tải lại mỗi lần (tốn lệnh list KV)', () => {
    const body = fn('loadToday');
    assert.match(body, /TODAY_FRESH_MS/, 'dữ liệu hôm nay còn mới thì không tải lại');
    assert.match(app, /const TODAY_FRESH_MS = 60 \* 1000/);
    const nav = app.match(/function showView\(v\) \{[\s\S]*?\n\}\n/)[0];
    assert.doesNotMatch(nav, /loadToday\(\{ force/, 'chuyển tab không bắt tải lại');
    // đổi qua khoảng ngày khác rồi chọn lại khoảng cũ: dùng lại kết quả vừa tải
    assert.match(fn('loadHistory'), /historyCache\.get\(/);
  });

  test('Lỗi đã gặp: mã kích hoạt nằm trong localStorage và header mọi request (mở F12 là thấy, chép sang máy khác dùng được)', () => {
    assert.doesNotMatch(app, /store\.set\('ts\.accessCode'/, 'không lưu mã kích hoạt trên máy');
    assert.doesNotMatch(fn('api'), /'X-Access-Code': store/, 'request thường không gửi mã kích hoạt');
    assert.doesNotMatch(app, /accessCode: store\.get/, 'hàng đợi không lưu mã kích hoạt');
    assert.match(app, /generateKey\(\{ name: 'ECDSA', namedCurve: 'P-256' \}, false/, 'khoá bí mật không xuất ra được');
    assert.match(fn('api'), /signHeaders\(/, 'mọi request được ký');
    assert.match(fn('signHeaders'), /X-Signature/);
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /id="onboardBorrowed"/, 'có lựa chọn máy mượn');
  });

  test('thanh trên cùng ghi rõ đang ở môi trường TEST hay UAT', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /id="envChip"/);
    assert.match(app.match(/function applyRole\(\) \{[\s\S]*?\n\}\n/)[0], /envChip[\s\S]*me\?\.space/);
  });

  test('app đọc mã lỗi và mã tra cứu từ server', () => {
    const body = fn('api');
    assert.match(body, /requestId/);
    assert.match(body, /\.code/);
  });

  test('Lỗi đã gặp: các nút gửi lên server bấm nhiều lần thì gửi nhiều lần', () => {
    for (const id of ['btnSetup', 'btnReport', 'btnNewCode', 'btnDeleteEmp']) {
      assert.match(app, new RegExp(`\\$\\('${id}'\\)\\.onclick = [\\s\\S]{0,400}?busy\\(`), id);
    }
    assert.match(app, /\$\('onboardForm'\)\.onsubmit = [\s\S]{0,300}?busy\(/, 'nút kích hoạt');
  });

  test('hỏi xác nhận bằng hộp của app, không dùng confirm() của trình duyệt (không sửa giao diện được, nút tiếng Anh)', () => {
    assert.doesNotMatch(app.replace(/\/\/.*$/gm, ''), /(^|[^\w.])confirm\(/m, 'không còn confirm()');
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /<dialog id="confirmDlg"/);
    const logout = app.match(/\$\('btnLogout'\)\.onclick = async \(\) => \{[\s\S]*?\n\};\n/)[0];
    assert.match(logout, /askConfirm\(\{[\s\S]*danger: true/, 'đăng xuất: nút chính màu đỏ');
    assert.match(logout, /queueAll\(\)/, 'báo lượt chấm công chưa gửi');
    assert.match(app, /\$\('confirmCancel'\)\.focus\(\)/, 'nút an toàn được chọn sẵn');
  });

  test('Lỗi đã gặp: bấm Esc hai lần thì hộp thoại kích hoạt đóng hẳn, không còn chỗ nào để nhập mã', () => {
    // Chrome/Brave chỉ cho chặn Esc một lần (sự kiện cancel); lần thứ hai hộp thoại vẫn đóng.
    // Chưa kích hoạt thì màn sau hộp thoại vô dụng: đóng là phải mở lại ngay.
    assert.match(app, /\$\('onboardDlg'\)\.addEventListener\('close', \(\) => \{[^\n]*if \(!store\.get\('ts\.account'\)\)[^\n]*showModal\(\)/, 'đóng khi chưa kích hoạt thì mở lại');
  });

  test('Lỗi đã gặp: trên iPhone khó nhập mã kích hoạt (bàn phím che ô nhập, tự sửa chữ, phải đổi bàn phím để gõ dấu gạch)', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const input = html.match(/<input class="input code-input" id="onboardKey"[^>]*>/)[0];
    assert.match(input, /autocorrect="off"/, 'iOS không tự sửa mã');
    assert.match(input, /enterkeyhint="go"/, 'phím Return ghi Đi để gửi luôn');
    assert.match(input, /placeholder="VD: [0-9A-Z]+"/, 'mã mẫu không có dấu gạch (server tự bỏ dấu gạch, khỏi đổi bàn phím)');
    assert.match(html, /\.onboard\{[^}]*max-height:calc\(var\(--vvh/, 'hộp thoại không cao quá phần màn còn thấy khi bàn phím bật');
    assert.match(app, /visualViewport\.addEventListener\('resize'/, 'app đo phần màn còn thấy');
  });

  test('Lỗi đã gặp: công tắc Máy mượn bật lên thì trắng tinh ở chế độ tối (nền màu mực trùng nút gạt trắng)', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /\.switch:checked\{background:var\(--in\)/);
    assert.doesNotMatch(html, /\.switch:checked\{background:var\(--ink\)/);
  });

  test('Lỗi đã gặp: nút Kích hoạt bấm được khi chưa nhập mã; nhập sai mã thì ô nhập bị xoá trắng', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /<button class="btn ink" id="btnActivate"[^>]* disabled/, 'mới mở: nút khoá');
    assert.match(app, /function syncActivate\(\) \{[^\n]*\$\('btnActivate'\)\.disabled = !\$\('onboardKey'\)\.value\.trim\(\)/, 'ô trống thì khoá nút');
    assert.match(app, /\$\('onboardKey'\)\.addEventListener\('input', syncActivate\)/);
    assert.match(app, /id="onboardClear"|\$\('onboardClear'\)/, 'có nút xoá nhanh mã');
    const open = app.match(/function openOnboarding\([^)]*\) \{[\s\S]*?\n\}\n/)[0];
    assert.match(open, /if \(!keep\) \$\('onboardKey'\)\.value = ''/, 'nhập sai thì giữ mã để sửa');
  });
});
