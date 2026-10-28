// Test khung oval theo khuôn mặt thật (public/guide.js).
// Chạy: npm test. Test ghi "Lỗi đã gặp" tái hiện lỗi đã tìm ra, không được xoá.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ovalFor } = require('../public/guide.js');

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

test('Lỗi đã gặp: oval cố định theo % khung camera to hơn hẳn khuôn mặt thật (webcam máy tính)', () => {
  // webcam 1280×720 ngồi cách màn hình: mặt rộng ~230px (18% khung). Khung hiển thị 720×540 (cắt hai bên, như object-fit: cover).
  const g = ovalFor({ x: 525, y: 200, width: 230, height: 250 }, { w: 1280, h: 720 }, { w: 720, h: 540 });
  const shown = 230 * 0.75;                      // bề ngang mặt trên màn hình
  assert.ok(g.w >= shown * 1.15 && g.w <= shown * 1.45, `oval ${g.w}px, mặt ${shown}px`);
  assert.ok(g.w / 720 < 0.4, 'nhỏ hơn hẳn khung cố định cũ (49% bề ngang)');
  near(g.h, g.w * 4 / 3);
});

test('oval nằm đúng chỗ khuôn mặt: tính phần bị cắt hai bên và lật ngang như gương', () => {
  const video = { w: 1280, h: 720 }, stage = { w: 720, h: 540 };   // scale 0.75, cắt (960-720)/2 = 120px mỗi bên
  const left = ovalFor({ x: 200, y: 260, width: 200, height: 200 }, video, stage);
  // tâm mặt ở x=300 trong video → 300*0.75 - 120 = 105 → lật gương: 720 - 105 = 615
  near(left.cx, 615);
  assert.ok(left.cy < (260 + 100) * 0.75, 'dời lên để chứa cả trán (khung nhận diện không có trán)');
});

test('điện thoại (khung dọc): mặt gần camera thì oval to theo', () => {
  const g = ovalFor({ x: 120, y: 260, width: 470, height: 520 }, { w: 720, h: 1280 }, { w: 358, h: 319 });
  const s = 358 / 720;
  assert.ok(g.w > 470 * s * 1.15);
});

test('Lỗi đã gặp: mặt nhỏ hoặc to hơn khung oval mà không có lời nhắc lại gần / lùi xa', () => {
  const { fitHint } = require('../public/guide.js');
  const video = { w: 640, h: 480 }, stage = { w: 720, h: 540 };   // webcam 4:3, khung hiển thị 4:3 (scale 1,125)
  const oval = { cx: 360, cy: 270, w: 0.36 * 720 };               // oval máy tính: 36% bề ngang
  const at = (w, cx = 320, cy = 250) => fitHint(ovalFor({ x: cx - w / 2, y: cy - w / 2, width: w, height: w * 1.1 }, video, stage), oval);
  assert.equal(at(100), 'near', 'mặt nhỏ (ngồi xa): nhắc lại gần');
  assert.equal(at(260), 'far', 'mặt to (sát camera): nhắc lùi xa');
  assert.equal(at(175), null, 'vừa khung: không nhắc');
  assert.equal(at(175, 140), 'center', 'lệch hẳn sang một bên: nhắc đưa mặt vào giữa');
});

test('app.js nhắc theo cỡ mặt đo được; oval đứng yên; index.html nạp guide.js', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert.match(app, /async function detectLoop[\s\S]*?updateFit\(det\)/);
  assert.match(app, /fitHint\(/);
  assert.doesNotMatch(app, /placeOval|--cx/, 'oval không chạy theo mặt');
  assert.ok(html.indexOf('src="guide.js"') > 0 && html.indexOf('src="guide.js"') < html.indexOf('src="app.js"'));
  assert.match(sw, /'guide\.js'/);
});
