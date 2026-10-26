// Test sắp xếp Bảng công (public/sort.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SORTS, DEFAULT_SORT, sortRows } = require('../public/sort.js');

const row = (code, name, inTime, ms = 0) => ({ code, name, first: inTime ? { time: inTime + ':00', ts: Date.parse(`2026-10-26T${inTime}:00`) } : null, ms });
const rows = [
  row('NV2', 'Trần Bích', '08:10', 5e6),
  row('NV10', 'Nguyễn An', null),
  row('NV1', 'Đỗ Cường', '07:50', 9e6),
  row('NV9', 'Lê Dung', '09:05', 1e6),
];
const codes = (list) => list.map(r => r.code);

test('mặc định là Mã NV giảm dần', () => {
  assert.equal(DEFAULT_SORT, 'code-desc');
  assert.ok(SORTS[DEFAULT_SORT]);
});

test('Mã NV so theo số: NV10 lớn hơn NV9', () => {
  assert.deepEqual(codes(sortRows(rows, 'code-desc')), ['NV10', 'NV9', 'NV2', 'NV1']);
  assert.deepEqual(codes(sortRows(rows, 'code-asc')), ['NV1', 'NV2', 'NV9', 'NV10']);
});

test('họ tên A→Z theo tiếng Việt (Đ sau D)', () => {
  assert.deepEqual(sortRows(rows, 'name').map(r => r.name), ['Đỗ Cường', 'Lê Dung', 'Nguyễn An', 'Trần Bích']);
});

test('giờ vào: người chưa vào luôn ở cuối, cả khi sắp sớm trước hay muộn trước', () => {
  assert.deepEqual(codes(sortRows(rows, 'in-asc')), ['NV1', 'NV2', 'NV9', 'NV10']);
  assert.deepEqual(codes(sortRows(rows, 'in-desc')), ['NV9', 'NV2', 'NV1', 'NV10']);
});

test('số giờ làm nhiều trước', () => {
  assert.deepEqual(codes(sortRows(rows, 'hours-desc')), ['NV1', 'NV2', 'NV9', 'NV10']);
});

test('đọc được cả dòng có dạng { emp: {...} } của danh sách hôm nay', () => {
  const r = [{ emp: { code: 'NV1', name: 'A' }, first: null, ms: 0 }, { emp: { code: 'NV3', name: 'B' }, first: null, ms: 0 }];
  assert.deepEqual(sortRows(r, 'code-desc').map(x => x.emp.code), ['NV3', 'NV1']);
});

test('khoá sắp xếp lạ thì dùng mặc định, không làm hỏng danh sách', () => {
  assert.deepEqual(codes(sortRows(rows, 'abc')), codes(sortRows(rows, DEFAULT_SORT)));
});

test('không sửa mảng gốc', () => {
  const before = codes(rows);
  sortRows(rows, 'code-asc');
  assert.deepEqual(codes(rows), before);
});
