// Test ca làm việc phía app, đọc danh sách nhân viên và kiểm tra ảnh khuôn mặt tải lên
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SHIFTS, suggestShift, shiftLabel, shiftDateFor, dayEndsAt, isMissed } = require('../public/shifts.js');
const { parseEmployees, parseTable, TEMPLATE } = require('../public/import.js');
const { checkUpload } = require('../public/face-logic.js');

describe('Ca làm việc', () => {
  test('giờ ca trong app giống hệt server', () => {
    const worker = fs.readFileSync(path.join(__dirname, '../src/worker.js'), 'utf8');
    for (const [k, s] of Object.entries(SHIFTS)) {
      assert.match(worker, new RegExp(`${k}: \\{ name: '${s.name}', start: '${s.start}', end: '${s.end}', overnight: ${s.overnight} \\}`));
    }
  });
  test('gợi ý ca theo giờ: sáng sớm và trưa là ca sáng, tối và sau nửa đêm là ca tối', () => {
    for (const h of [4, 7, 8, 13]) assert.equal(suggestShift(h), 'sang', String(h));
    for (const h of [18, 21, 22, 23, 0, 3]) assert.equal(suggestShift(h), 'toi', String(h));
  });
  test('giờ giữa hai ca thì dùng ca thường làm', () => {
    assert.equal(suggestShift(15, 'toi'), 'toi');
    assert.equal(suggestShift(16, 'sang'), 'sang');
    assert.equal(suggestShift(16, 'xyz'), 'sang');
  });
  test('ngày công: ca tối vào sau nửa đêm tính ngày hôm trước, giống server', () => {
    assert.equal(shiftDateFor('toi', '2026-11-01', 0), '2026-10-31');
    assert.equal(shiftDateFor('toi', '2026-10-26', 22), '2026-10-26');
    assert.equal(shiftDateFor('sang', '2026-10-26', 1), '2026-10-26');
  });
  test('ngày công của ca sáng hết lúc 00:00 hôm sau, ca tối hết lúc 12:00 trưa hôm sau', () => {
    assert.equal(dayEndsAt('2026-10-26', 'sang'), new Date('2026-10-27T00:00:00').getTime());
    assert.equal(dayEndsAt('2026-10-26', 'toi'), new Date('2026-10-27T12:00:00').getTime());
  });
  test('thiếu công: đã check-in, không check-out, và đã qua hết ngày công của ca', () => {
    const first = { ts: 1 }, last = { ts: 2 };
    const at = s => new Date(s).getTime();
    assert.equal(isMissed({ date: '2026-10-26', shift: 'sang', first }, at('2026-10-26T23:59:00')), false);
    assert.equal(isMissed({ date: '2026-10-26', shift: 'sang', first }, at('2026-10-27T00:00:01')), true);
    assert.equal(isMissed({ date: '2026-10-26', shift: 'sang', first, last }, at('2026-10-28T00:00:00')), false);
    assert.equal(isMissed({ date: '2026-10-26', shift: 'toi', first }, at('2026-10-27T11:00:00')), false);
    assert.equal(isMissed({ date: '2026-10-26', shift: 'toi', first }, at('2026-10-27T12:00:01')), true);
    assert.equal(isMissed({ date: '2026-10-26', shift: 'sang' }, at('2026-10-28T00:00:00')), false);
  });
  test('nhãn ca có giờ bắt đầu và kết thúc', () => {
    assert.equal(shiftLabel('toi'), 'Ca tối 22:00–06:00');
  });
});

describe('Đọc danh sách nhân viên', () => {
  test('file mẫu đọc được đúng 2 người', () => {
    const { rows, errors } = parseEmployees(TEMPLATE);
    assert.deepEqual(errors, []);
    assert.deepEqual(rows, [
      { code: 'NV01', name: 'Nguyễn Văn An', role: 2, shift: 'sang', tg: '@nguyenvanan' },
      { code: 'NV02', name: 'Trần Thị Bích', role: 1, shift: 'toi', tg: '' },
    ]);
  });
  test('dán từ Excel (cách nhau bằng tab), tiêu đề không dấu, thứ tự cột khác', () => {
    const { rows } = parseEmployees('ho ten\tma nv\tca\nLê Cường\tNV03\tCa tối\n');
    assert.deepEqual(rows[0], { code: 'NV03', name: 'Lê Cường', role: 2, shift: 'toi', tg: '' });
  });
  test('CSV có BOM, dấu chấm phẩy, ô có ngoặc kép và dấu phẩy bên trong', () => {
    const { rows } = parseEmployees('﻿Mã NV;Họ tên\r\n"NV04";"Phạm, Minh ""Đức"""\r\n');
    assert.deepEqual([rows[0].code, rows[0].name], ['NV04', 'Phạm, Minh "Đức"']);
  });
  test('không có dòng tiêu đề thì hiểu theo thứ tự Mã NV, Họ tên, Quyền, Ca', () => {
    const { rows } = parseEmployees('NV05,Võ Hà,admin,sáng\nNV06,Đỗ Dũng\n');
    assert.deepEqual(rows.map(r => [r.code, r.role, r.shift]), [['NV05', 1, 'sang'], ['NV06', 2, '']]);
  });
  test('bỏ dòng trống; ca lạ giữ nguyên để server báo lỗi đúng dòng', () => {
    const { rows } = parseEmployees('Mã NV,Họ tên,Ca\n\nNV07,X,chiều\n,,\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].shift, 'chiều');
  });
  test('thiếu cột Mã NV hoặc Họ tên thì báo lỗi', () => {
    assert.match(parseEmployees('Tên,Ca\nAn,sáng').errors[0], /Mã NV/);
    assert.deepEqual(parseEmployees('').rows, []);
  });
  test('xuống dòng trong ô có ngoặc kép không làm tách dòng', () => {
    assert.equal(parseTable('a,"b\nc"\nd,e').length, 2);
  });
});

describe('Ảnh khuôn mặt tải lên', () => {
  const face = (d = 0) => Array.from({ length: 128 }, (_, i) => Math.sin(i) * 0.08 + d);
  const det = (extra = {}) => ({ score: 0.9, boxWidth: 200, descriptor: face(), ...extra });
  test('đúng 1 khuôn mặt rõ, đủ lớn thì dùng được', () => {
    assert.deepEqual(checkUpload([det()], 800), { ok: true });
  });
  test('không thấy mặt, nhiều người, mặt nhỏ, ảnh mờ đều bị từ chối kèm lý do', () => {
    assert.match(checkUpload([], 800).reason, /Không thấy/);
    assert.match(checkUpload([det(), det()], 800).reason, /2 người/);
    assert.match(checkUpload([det({ boxWidth: 50 })], 800).reason, /quá nhỏ/);
    assert.match(checkUpload([det({ score: 0.4 })], 800).reason, /mờ/);
  });
  test('ảnh của người khác với ảnh đầu tiên bị từ chối', () => {
    assert.match(checkUpload([det({ descriptor: face(0.1) })], 800, [face()]).reason, /Khác người/);
    assert.equal(checkUpload([det({ descriptor: face(0.01) })], 800, [face()]).ok, true);
  });
});
