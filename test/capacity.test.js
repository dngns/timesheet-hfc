// Test dung lượng: mô phỏng nhiều ngày dùng thật (test/simulate.mjs) và kiểm tra còn xa hạn mức gói miễn phí.
// Chạy: npm test. Muốn xem số liệu: npm run simulate -- <số người> <số ngày> <số máy quản trị>
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, report, FREE } from './simulate.mjs';

const peak = (r, k) => Math.max(...Object.values(r.byDay).map(m => m[k] || 0));
function assertUnder(r, share) {
  const msg = '\n' + report(r);
  for (const k of ['requests', 'reads', 'writes', 'lists', 'deletes']) {
    assert.ok(peak(r, k) <= FREE[k] * share, `${k} vượt ${share * 100}% hạn mức` + msg);
  }
  assert.ok(r.tgPeak <= FREE.tgPerMin, 'Telegram quá 20 tin/phút' + msg);
  const blocked = Object.values(r.byDay).flatMap(m => Object.keys(m).filter(k => k.startsWith('blocked:')));
  assert.deepEqual(blocked, [], 'giới hạn tần suất chặn nhầm người dùng thật' + msg);
  assert.equal(r.dupPhotos, 0, 'có ảnh gửi lặp' + msg);
  assert.equal(r.stuck, 0, 'còn lượt kẹt trong hàng đợi' + msg);
}

describe('Hạn mức gói miễn phí khi dùng thật', () => {
  test('30 người, 2 máy quản trị mở Bảng công cả ngày: mọi hạn mức dưới 50%', async () => {
    assertUnder(await simulate({ users: 30, days: 3, adminTabs: 2 }), 0.5);
  });

  test('Lỗi đã gặp: 3 máy quản trị mở Bảng công cả ngày gần cạn hạn mức list KV (~90%)', async () => {
    assertUnder(await simulate({ users: 30, days: 2, adminTabs: 3 }), 0.7);
  });

  test('100 người, 1 máy quản trị: vẫn dưới 70%', async () => {
    assertUnder(await simulate({ users: 100, days: 2 }), 0.7);
  });
});

describe('Sự cố giữa giờ cao điểm', () => {
  test('hết hạn mức ghi KV lúc 07:58–08:30: không ảnh lặp, không mất lượt, không lượt bị từ chối', async () => {
    const r = await simulate({ users: 30, days: 2, faults: [{ kind: 'writes', from: '2026-11-03T07:58', to: '2026-11-03T08:30' }] });
    assertUnder(r, 0.5);
    assert.equal(r.errors['409 /api/punch'] || 0, 0, 'lượt chờ gửi bị từ chối khi gửi lại\n' + report(r));
  });

  test('hết hạn mức list KV cả buổi sáng: chấm công vẫn chạy, chỉ Bảng công lỗi', async () => {
    const r = await simulate({ users: 30, days: 2, faults: [{ kind: 'lists', from: '2026-11-03T07:00', to: '2026-11-03T12:00' }] });
    assert.equal(r.errors['500 /api/punch'] || 0, 0, report(r));
    assert.equal(r.errors['500 /api/status'] || 0, 0, report(r));
  });
});
