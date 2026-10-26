// Test thông báo kiểu Sonner (public/toast.js): vị trí trong chồng, vuốt để tắt, và cách app.js nối vào. Chạy: npm test.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GAP, PEEK, VISIBLE, SCALE, SWIPE, FLICK, stackLayout, swipeDirs, dampen, swipeOffset, shouldDismiss } = require('../public/toast.js');

describe('Chồng thông báo', () => {
  const heights = [52, 72, 52, 52, 52];   // mới nhất trước
  test('gộp: lớp sau ló mép, nhỏ dần, cao bằng lớp trước; chỉ thấy 3 cái mới nhất', () => {
    const b = stackLayout(heights, false);
    assert.deepEqual(b.map(x => x.y), [0, PEEK, 2 * PEEK, 3 * PEEK, 4 * PEEK]);
    assert.deepEqual(b.map(x => x.h), [52, 52, 52, 52, 52], 'cái cao 72 nằm sau cũng chỉ cao bằng cái trước');
    assert.equal(b[1].scale, 1 - SCALE);
    assert.ok(b[2].scale < b[1].scale);
    assert.deepEqual(b.map(x => x.visible), [true, true, true, false, false]);
    assert.equal(VISIBLE, 3);
  });
  test('xoè: xếp đủ chiều cao thật, cách nhau đều, không thu nhỏ', () => {
    const b = stackLayout(heights, true);
    assert.deepEqual(b.map(x => x.y), [0, 52 + GAP, 52 + 72 + 2 * GAP, 52 + 72 + 52 + 3 * GAP, 52 + 72 + 52 + 52 + 4 * GAP]);
    assert.deepEqual(b.map(x => x.h), heights);
    assert.ok(b.every(x => x.scale === 1));
  });
  test('không có thông báo nào thì không có vị trí nào', () => assert.deepEqual(stackLayout([], false), []));
});

describe('Vuốt để tắt (như Sonner)', () => {
  test('hướng được phép tắt theo vị trí: góc dưới phải thì xuống và phải, giữa phía trên thì chỉ lên', () => {
    assert.deepEqual(swipeDirs('bottom'), ['bottom', 'right']);
    assert.deepEqual(swipeDirs('top'), ['top']);
  });
  test('hướng được phép thì thẻ đi đúng theo tay', () => {
    assert.equal(swipeOffset('y', 80, swipeDirs('bottom')), 80);
    assert.equal(swipeOffset('x', 60, swipeDirs('bottom')), 60);
    assert.equal(swipeOffset('y', -80, swipeDirs('top')), -80);
  });
  test('Lỗi đã gặp: kéo ngược hướng thì thẻ đi theo tay tới tận thanh trên', () => {
    // hướng khác bị cản: đi tối đa ~20px dù kéo xa bao nhiêu, buông tay là bật về
    for (const d of [-30, -100, -400, -2000]) {
      const off = swipeOffset('y', d, swipeDirs('bottom'));
      assert.ok(off < 0 && Math.abs(off) < 20, `kéo lên ${d}px: thẻ chỉ đi ${off.toFixed(1)}px`);
    }
    assert.ok(Math.abs(swipeOffset('y', 400, swipeDirs('top'))) < 20, 'điện thoại: kéo xuống bị cản');
    assert.equal(swipeOffset('x', 200, swipeDirs('top')), 0, 'điện thoại: không có hướng ngang để tắt thì đứng yên');
    assert.ok(Math.abs(swipeOffset('x', -300, swipeDirs('bottom'))) < 20, 'máy tính: kéo sang trái bị cản');
    assert.equal(dampen(0), 0);
  });
  test('tắt khi vuốt từ 45px trở lên hoặc vuốt nhanh', () => {
    assert.equal(SWIPE, 45);
    assert.equal(shouldDismiss(45, 1000), true);
    assert.equal(shouldDismiss(30, 1000), false, 'vuốt ngắn, chậm: bật về');
    assert.equal(shouldDismiss(30, 100), true, 'vuốt nhanh (0,3 px/ms > 0,11) thì tắt dù ngắn');
    assert.equal(FLICK, 0.11);
  });
});

describe('app.js nối thông báo', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  test('mọi thông báo đi qua toast.js; máy tính góc dưới phải, điện thoại giữa phía trên', () => {
    assert.match(app, /Toaster\.create\(\$\('toasts'\), \{ phone: \(\) => matchMedia\('\(max-width:760px\)'\)\.matches \}\)/);
    assert.match(app, /function toast\(msg, type = 'info', ms\) \{ return toaster\.show\(msg, type, ms\); \}/);
    assert.match(html, /\.toaster\{position:fixed;[^}]*right:24px;bottom:24px/, 'máy tính: góc dưới bên phải');
    assert.match(html, /\.toaster\[data-edge="top"\]\{top:[^}]*margin:0 auto/, 'điện thoại: giữa phía trên');
  });
  test('file mới được nạp trước app.js và lưu offline', () => {
    assert.ok(html.indexOf('src="toast.js"') > 0 && html.indexOf('src="toast.js"') < html.indexOf('src="app.js"'));
    assert.match(sw, /'toast\.js'/);
  });
});

describe('Nạp tài nguyên (hiệu năng)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  test('font Google không chặn hiển thị; không nạp weight thừa', () => {
    assert.doesNotMatch(html, /<link href="https:\/\/fonts\.googleapis\.com[^>]*rel="stylesheet">/, 'không còn thẻ stylesheet chặn hiển thị');
    assert.match(html, /<link rel="preload" as="style" href="https:\/\/fonts\.googleapis\.com[^"]*" onload="this\.onload=null;this\.rel='stylesheet'">/);
    assert.match(html, /Big\+Shoulders\+Display:wght@700;800&/);
  });
  test('bộ nhận diện (~1,3MB) tải song song nhưng không chặn app: preload + app tự nạp', () => {
    assert.doesNotMatch(html, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@vladmandic\/face-api/, 'không còn thẻ script đồng bộ');
    assert.match(html, /<link rel="preload" as="script" href="https:\/\/cdn\.jsdelivr\.net\/npm\/@vladmandic\/face-api@1\.7\.15\/dist\/face-api\.js" crossorigin="anonymous">/);
    assert.match(app, /const FACE_API = 'https:\/\/cdn\.jsdelivr\.net\/npm\/@vladmandic\/face-api@1\.7\.15\/dist\/face-api\.js'/);
    assert.ok(sw.includes("'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/'"), 'cùng phiên bản với service worker');
    assert.match(app, /await loadFaceApi\(\)/);
  });
  test('đo Core Web Vitals bằng web-vitals (Google) tự host, gửi bằng fetchLater', () => {
    assert.match(html, /<script type="module" src="vitals\.js"><\/script>/);
    const v = fs.readFileSync(path.join(__dirname, '../public/vitals.js'), 'utf8');
    assert.match(v, /from '\.\/vendor\/web-vitals\.attribution\.js'/);
    assert.match(v, /fetchLater\('\/api\/vitals'/);
    assert.ok(fs.existsSync(path.join(__dirname, '../public/vendor/web-vitals.LICENSE.txt')), 'kèm giấy phép Apache-2.0');
    assert.match(sw, /'vitals\.js', 'vendor\/web-vitals\.attribution\.js'/);
  });
});
