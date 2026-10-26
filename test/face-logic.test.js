// Test logic xác minh khuôn mặt và đăng ký góc mặt (public/face-logic.js).
// Chạy: npm test. Các test ghi "Lỗi đã gặp" tái hiện đúng lỗi người dùng báo, không được xoá.
//
// Dữ liệu khuôn mặt là giả lập: mỗi "người" là một vector 128 chiều như đầu ra của face-api,
// và ta đặt được chính xác độ lệch giữa hai ảnh. Test này kiểm tra quy tắc quyết định,
// không đo độ chính xác của mô hình face-api với khuôn mặt thật (xem QA-NHAN-DIEN.md).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/face-logic.js');
const { CONFIG: C, Verifier, Enroller, ENROLL_STEPS, facePose, faceDistance, findDuplicate, euclidean } = F;

// ---------- Dữ liệu giả lập ----------
let seed = 12345;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const person = () => Float32Array.from({ length: 128 }, () => gauss() * 0.088);
// ảnh của `base` lệch đúng `d`
function at(base, d) {
  const dir = Float32Array.from({ length: 128 }, gauss);
  const n = Math.hypot(...dir);
  return Float32Array.from(base, (x, i) => x + (dir[i] / n) * d);
}
const pose = (yaw = 0, pitch = 0.45, roll = 0) => ({ yaw, pitch, roll });
const FRONT = pose();

// Chủ tài khoản: 5 mẫu như khi đăng ký (nhìn thẳng + 4 góc lệch nhiều hơn)
function owner() {
  const base = person();
  return { base, samples: [at(base, 0.1), at(base, 0.3), at(base, 0.3), at(base, 0.28), at(base, 0.28)] };
}
function feedVerifier(v, frames, start = 0, step = 220) {
  return frames.map((f, i) => v.frame(f, start + i * step).state);
}

// ---------- Góc mặt ----------
describe('facePose: đo góc mặt từ 68 điểm mốc', () => {
  const landmarks = ({ noseX = 50, noseY = 67, rightEyeY = 40, chinY = 100 } = {}) => {
    const P = Array.from({ length: 68 }, () => ({ x: 50, y: 60 }));
    P[0] = { x: 0, y: 50 }; P[16] = { x: 100, y: 50 }; P[8] = { x: 50, y: chinY };
    for (let i = 36; i < 42; i++) P[i] = { x: 30, y: 40 };
    for (let i = 42; i < 48; i++) P[i] = { x: 70, y: rightEyeY };
    P[30] = { x: noseX, y: noseY };
    return P;
  };
  test('nhìn thẳng: yaw và roll gần 0', () => {
    const p = facePose(landmarks());
    assert.ok(Math.abs(p.yaw) < 1e-9);
    assert.ok(Math.abs(p.roll) < 1e-9);
  });
  test('mũi lệch hai bên cho yaw trái dấu nhau', () => {
    assert.ok(facePose(landmarks({ noseX: 70 })).yaw > 0.13);
    assert.ok(facePose(landmarks({ noseX: 30 })).yaw < -0.13);
  });
  test('mũi thấp xuống làm pitch tăng', () => {
    assert.ok(facePose(landmarks({ noseY: 75 })).pitch > facePose(landmarks({ noseY: 67 })).pitch + 0.06);
  });
  test('Lỗi đã gặp: ngẩng lên làm mũi và cằm cùng co lại vẫn đo được góc cúi thay đổi', () => {
    // đo bằng camera thật: cách đo cũ (mũi–mắt chia mắt–cằm) gần như không đổi khi ngẩng, nên kẹt ở bước "ngẩng lên"
    const front = facePose(landmarks({ noseY: 67, chinY: 100 }));
    const up = facePose(landmarks({ noseY: 62, chinY: 89 }));     // cả hai khoảng co ~18%
    assert.ok(Math.abs(up.pitch - front.pitch) > C.PITCH_MIN, `chênh ${Math.abs(up.pitch - front.pitch)}`);
  });

  test('hai mắt lệch độ cao cho roll khác 0', () => {
    assert.ok(Math.abs(facePose(landmarks({ rightEyeY: 55 })).roll) > 0.3);
  });
});

// ---------- Độ lệch ----------
describe('faceDistance', () => {
  test('lấy trung bình 2 mẫu gần nhất', () => {
    const b = person();
    const d = faceDistance(b, [at(b, 0.2), at(b, 0.3), at(b, 0.9)]);
    assert.ok(Math.abs(d - 0.25) < 1e-4, `d = ${d}`);
  });
  test('một mẫu: dùng chính mẫu đó; không có mẫu: vô cùng', () => {
    const b = person();
    assert.ok(Math.abs(faceDistance(b, [at(b, 0.3)]) - 0.3) < 1e-4);
    assert.equal(faceDistance(b, []), Infinity);
  });
  test('Lỗi đã gặp: mẫu chụp nghiêng không kéo độ lệch của chính chủ vượt ngưỡng', () => {
    // FaceMatcher cũ lấy trung bình mọi mẫu: 2 mẫu nghiêng ở 0.6 kéo trung bình lên ~0.43
    const b = person();
    const samples = [at(b, 0.15), at(b, 0.2), at(b, 0.6), at(b, 0.6), at(b, 0.6)];
    const frame = at(b, 0.05);
    assert.ok(faceDistance(frame, samples) < C.MATCH_THRESHOLD);
  });
});

// ---------- Xác minh khi chấm công ----------
describe('Verifier: xác minh khi chấm công', () => {
  // Các test danh tính tắt bước kiểm tra người thật để kiểm riêng từng quy tắc; bước người thật có test riêng bên dưới.
  const NOLIVE = { ...C, LIVENESS: false };
  test('đúng người nhìn thẳng: chỉ xác nhận từ khung hình thứ 4, không sớm hơn', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE);
    const states = feedVerifier(v, Array.from({ length: 5 }, () => ({ descriptor: at(o.base, 0.15), pose: FRONT })));
    assert.deepEqual(states, ['checking', 'checking', 'checking', 'ok', 'ok']);
  });

  test('Lỗi đã gặp: người khác hẳn không bao giờ được xác nhận', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE);
    for (let k = 0; k < 50; k++) {
      const r = v.frame({ descriptor: person(), pose: FRONT }, k * 220);
      assert.notEqual(r.state, 'ok', `khung ${k}: lệch ${r.dist}`);
      assert.equal(v.isFresh(k * 220), false);
    }
  });

  test('Lỗi đã gặp: người khác chỉ lệch 0.43–0.55 (vùng lọt qua ngưỡng 0.5 cũ) không được xác nhận', () => {
    for (const d of [0.43, 0.45, 0.48, 0.5, 0.55]) {
      const o = owner(), v = new Verifier(o.samples, NOLIVE);
      // mọi khung hình của "người lạ" đều cách chủ tài khoản đúng d
      const states = feedVerifier(v, Array.from({ length: 20 }, () => {
        const lookalike = at(o.base, d);
        return { descriptor: lookalike, pose: FRONT };
      }));
      assert.ok(!states.includes('ok'), `lệch ${d}: ${states.join(',')}`);
    }
  });

  test('Lỗi đã gặp: đã xác nhận, người khác bước vào thì huỷ trong 2 khung hình', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE);
    feedVerifier(v, Array.from({ length: 5 }, () => ({ descriptor: at(o.base, 0.15), pose: FRONT })));
    assert.ok(v.isFresh(4 * 220));
    const other = person();
    const s1 = v.frame({ descriptor: at(other, 0.1), pose: FRONT }, 5 * 220).state;
    const s2 = v.frame({ descriptor: at(other, 0.1), pose: FRONT }, 6 * 220).state;
    assert.equal(s2, 'unknown', `khung 1: ${s1}, khung 2: ${s2}`);
    assert.equal(v.isFresh(6 * 220), false);
  });

  test('Lỗi đã gặp: đã xác nhận, chỉ một khung hình người lạ là khoá chấm công ngay', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE);
    feedVerifier(v, Array.from({ length: 5 }, () => ({ descriptor: at(o.base, 0.15), pose: FRONT })));
    assert.ok(v.isFresh(4 * 220));
    v.frame({ descriptor: person(), pose: FRONT }, 5 * 220);
    assert.equal(v.isFresh(5 * 220), false);
  });

  test('chính chủ có một khung hình nhiễu thì xác nhận lại ngay ở khung hình khớp kế tiếp', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE);
    const states = feedVerifier(v, [0.15, 0.15, 0.15, 0.15, 0.6, 0.15].map(d => ({ descriptor: at(o.base, d), pose: FRONT })));
    assert.deepEqual(states, ['checking', 'checking', 'checking', 'ok', 'checking', 'ok']);
  });

  test('khớp và không khớp xen kẽ thì không xác nhận', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE), other = person();
    const frames = Array.from({ length: 20 }, (_, i) => ({ descriptor: i % 2 ? other : at(o.base, 0.15), pose: FRONT }));
    assert.ok(!feedVerifier(v, frames).includes('ok'));
  });

  test('3 khung khớp và 2 khung lệch sát ngưỡng thì chưa đủ', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE);
    const ds = [0.15, 0.6, 0.15, 0.6, 0.15];
    const states = feedVerifier(v, ds.map(d => ({ descriptor: at(o.base, d), pose: FRONT })));
    assert.ok(!states.includes('ok'), states.join(','));
  });

  test('đúng người nhưng quay ngang hoặc nghiêng đầu thì không xét', () => {
    for (const p of [pose(0.2), pose(-0.2), pose(0, 0.45, 0.4)]) {
      const o = owner(), v = new Verifier(o.samples, NOLIVE);
      const states = feedVerifier(v, Array.from({ length: 8 }, () => ({ descriptor: at(o.base, 0.1), pose: p })));
      assert.ok(states.every(s => s === 'turned'), states.join(','));
    }
  });

  test('quay đi giữa chừng thì phải xác minh lại từ đầu', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE);
    const good = () => ({ descriptor: at(o.base, 0.15), pose: FRONT });
    feedVerifier(v, [good(), good(), good(), good()]);
    assert.equal(v.frame({ descriptor: at(o.base, 0.15), pose: pose(0.3) }, 1000).state, 'turned');
    assert.equal(v.isFresh(1000), false);
    assert.equal(v.frame(good(), 1200).state, 'checking');
  });

  test('xác minh hết hạn sau FRESH_MS nếu không có khung hình mới', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE);
    feedVerifier(v, Array.from({ length: 4 }, () => ({ descriptor: at(o.base, 0.15), pose: FRONT })));
    const t = 3 * 220;
    assert.ok(v.isFresh(t + C.FRESH_MS));
    assert.equal(v.isFresh(t + C.FRESH_MS + 1), false);
  });

  test('mất khuôn mặt thì xoá trạng thái xác minh', () => {
    const o = owner(), v = new Verifier(o.samples, NOLIVE);
    feedVerifier(v, Array.from({ length: 4 }, () => ({ descriptor: at(o.base, 0.15), pose: FRONT })));
    v.noFace();
    assert.equal(v.isFresh(700), false);
  });

  test('tài khoản chưa có mẫu khuôn mặt thì không xác nhận ai', () => {
    const v = new Verifier([], NOLIVE);
    assert.equal(v.frame({ descriptor: person(), pose: FRONT }, 0).state, 'no-samples');
    assert.equal(v.isFresh(0), false);
  });

  test('mô phỏng 300 người lạ: không ai được xác nhận; 300 lượt của chủ: đều được xác nhận', () => {
    let falseAccept = 0, falseReject = 0;
    for (let k = 0; k < 300; k++) {
      const o = owner();
      const stranger = person();
      const vs = new Verifier(o.samples, NOLIVE);
      if (feedVerifier(vs, Array.from({ length: 10 }, () => ({ descriptor: at(stranger, 0.1), pose: FRONT }))).includes('ok')) falseAccept++;
      const vo = new Verifier(o.samples, NOLIVE);
      // chủ tài khoản: mỗi khung lệch ngẫu nhiên 0.1–0.3 như camera thật
      if (!feedVerifier(vo, Array.from({ length: 10 }, () => ({ descriptor: at(o.base, 0.1 + rnd() * 0.2), pose: FRONT }))).includes('ok')) falseReject++;
    }
    assert.equal(falseAccept, 0);
    assert.equal(falseReject, 0);
  });
});

// ---------- Kiểm tra người thật và rời camera ----------
describe('Verifier: người thật và rời camera', () => {
  const live = (i) => pose(i % 4 < 2 ? 0.05 : -0.04);   // quay nhẹ qua lại như người thật
  test('Lỗi đã gặp: ảnh tĩnh giơ trước camera khớp mặt nhưng không bao giờ được chấm công', () => {
    const o = owner(), v = new Verifier(o.samples);
    for (let k = 0; k < 40; k++) {
      // ảnh phẳng: góc quay gần như không đổi dù tay cầm ảnh rung
      const r = v.frame({ descriptor: at(o.base, 0.1), pose: pose(0.02 + (k % 3) * 0.005) }, k * 220);
      assert.notEqual(r.state, 'ok');
      assert.equal(v.isFresh(k * 220), false);
    }
  });

  test('người thật đã được nhận ra thì quay nhẹ đầu là mở chấm công', () => {
    const o = owner(), v = new Verifier(o.samples);
    // đứng yên trước: nhận ra nhưng chưa mở, nhắc quay nhẹ đầu; sau đó quay nhẹ qua lại
    const states = Array.from({ length: 10 }, (_, k) => v.frame({ descriptor: at(o.base, 0.12), pose: k < 5 ? FRONT : live(k) }, k * 220).state);
    assert.equal(states[4], 'live-check', states.join(','));
    assert.equal(states.at(-1), 'ok');
    assert.ok(v.isFresh(7 * 220));
  });

  test('cử động đầu quá cũ (ngoài cửa sổ thời gian) không được tính', () => {
    // cử động lúc t=0, rồi hơn LIVE_WINDOW_MS sau mới đủ khung hình để xác minh
    const o = owner(), v = new Verifier(o.samples);
    v.frame({ descriptor: at(o.base, 0.1), pose: pose(0.06) }, 0);
    const start = C.LIVE_WINDOW_MS + 1000;
    const states = [0, 1, 2, 3].map(i => v.frame({ descriptor: at(o.base, 0.1), pose: pose(0) }, start + i * 220).state);
    assert.equal(states.at(-1), 'live-check', states.join(','));
  });

  // người đã được xác nhận là người thật: quay nhẹ 1 lần ở đầu phiên
  const liveSession = (o, v) => { for (let k = 0; k < 8; k++) v.frame({ descriptor: at(o.base, 0.12), pose: k < 4 ? FRONT : live(k) }, k * 220); };

  test('Lỗi đã gặp: đã xác nhận người thật, ngồi yên quá 6 giây không bị bắt quay đầu lại', () => {
    // QA camera thật: ngồi yên sau khi đã quay đầu, 6 giây sau nút lại khoá và nhắc quay đầu
    const o = owner(), v = new Verifier(o.samples);
    liveSession(o, v);
    let t = 8 * 220, last;
    for (; t < 20000; t += 220) last = v.frame({ descriptor: at(o.base, 0.12), pose: FRONT }, t);
    assert.equal(last.state, 'ok');
    assert.ok(v.isFresh(t - 220));
  });

  test('Lỗi đã gặp: quay đầu hơi xa rồi nhìn lại thì không phải quay đầu lần nữa', () => {
    const o = owner(), v = new Verifier(o.samples);
    liveSession(o, v);
    v.frame({ descriptor: at(o.base, 0.3), pose: pose(0.44) }, 2000);   // quay quá xa
    const states = [0, 1, 2, 3, 4].map(i => v.frame({ descriptor: at(o.base, 0.12), pose: FRONT }, 2200 + i * 220).state);
    assert.equal(states.at(-1), 'ok', states.join(','));
  });

  test('người khác bước vào thì phải xác nhận người thật lại từ đầu', () => {
    const o = owner(), v = new Verifier(o.samples);
    liveSession(o, v);
    const other = person();
    v.frame({ descriptor: other, pose: FRONT }, 2000); v.frame({ descriptor: other, pose: FRONT }, 2220);
    const states = [0, 1, 2, 3, 4].map(i => v.frame({ descriptor: at(o.base, 0.12), pose: FRONT }, 2440 + i * 220).state);
    assert.equal(states.at(-1), 'live-check', states.join(','));
  });

  test('rời camera rồi quay lại thì phải xác nhận người thật lại từ đầu', () => {
    const o = owner(), v = new Verifier(o.samples);
    liveSession(o, v);
    v.miss(2000); v.miss(2220);
    const states = [0, 1, 2, 3, 4].map(i => v.frame({ descriptor: at(o.base, 0.12), pose: FRONT }, 2440 + i * 220).state);
    assert.equal(states.at(-1), 'live-check', states.join(','));
  });

  test('Lỗi đã gặp: rời khỏi camera thì khoá chấm công sau 2 khung hình, không chờ 1,5 giây', () => {
    const o = owner(), v = new Verifier(o.samples, { ...C, LIVENESS: false });
    for (let k = 0; k < 5; k++) v.frame({ descriptor: at(o.base, 0.12), pose: FRONT }, k * 220);
    assert.ok(v.isFresh(4 * 220));
    v.miss(5 * 220);
    assert.ok(v.isFresh(5 * 220), 'một khung hình mất mặt (nhiễu) chưa khoá');
    v.miss(6 * 220);
    assert.equal(v.isFresh(6 * 220), false);
  });

  test('một khung mất mặt rồi thấy lại thì không khoá', () => {
    const o = owner(), v = new Verifier(o.samples, { ...C, LIVENESS: false });
    for (let k = 0; k < 5; k++) v.frame({ descriptor: at(o.base, 0.12), pose: FRONT }, k * 220);
    v.miss(5 * 220);
    v.frame({ descriptor: at(o.base, 0.12), pose: FRONT }, 6 * 220);
    v.miss(7 * 220);
    assert.ok(v.isFresh(7 * 220));
  });
});

// ---------- Đăng ký góc mặt ----------
describe('Enroller: đăng ký khuôn mặt theo góc', () => {
  const ok = { boxRatio: 0.4, score: 0.9 };
  const frame = (desc, p, extra = {}) => ({ descriptor: desc, pose: p, ...ok, ...extra });
  // giữ một góc đủ số khung để chụp
  const hold = (e, desc, p, now) => {
    let r;
    for (let i = 0; i < C.HOLD_FRAMES; i++) r = e.frame(frame(at(desc, 0.05), p), now + i * 220);
    return r;
  };
  const LEFT = pose(0.2), RIGHT = pose(-0.2), UP = pose(0, 0.37), DOWN = pose(0, 0.53);

  test('Lỗi đã gặp: đứng yên nhìn thẳng 60 giây chỉ chụp được 1 mẫu, không tự nhảy bước', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    for (let t = 0; t <= 60000; t += 220) e.frame(frame(at(b, 0.05), FRONT), t);
    assert.equal(e.samples.length, 1);
    assert.equal(e.active, true);
  });

  test('Lỗi đã gặp: quay chưa đủ góc thì không chụp', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0);
    for (let t = 1000; t < 20000; t += 220) e.frame(frame(at(b, 0.05), pose(C.TURN_MIN * 0.75)), t);
    assert.equal(e.samples.length, 1);
  });

  test('Lỗi đã gặp: nhìn thẳng vốn lệch sẵn một chút, quay một bên vừa phải vẫn được tính', () => {
    // đo bằng camera thật: nhìn thẳng -0.03, quay trái chỉ đạt -0.09..-0.13 trong 23 giây nên kẹt với mức 0.13 tuyệt đối
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, pose(-0.03), 0);
    hold(e, b, pose(-0.12), 1000);
    assert.equal(e.samples.length, 2);
  });

  test('góc quay tính so với lúc nhìn thẳng: camera đặt lệch, quay sang phía "khó" vẫn được tính', () => {
    // nhìn thẳng đã lệch -0.06; quay sang phía kia tới +0.04 là đã quay 0.10 so với lúc nhìn thẳng
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, pose(-0.06), 0);
    hold(e, b, pose(0.04), 1000);
    assert.equal(e.samples.length, 2);
  });

  test('Lỗi đã gặp: ngẩng lên vừa phải (lệch ~0.05 so với lúc nhìn thẳng) vẫn được tính', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0); hold(e, b, LEFT, 1000); hold(e, b, RIGHT, 2000);
    hold(e, b, pose(0, 0.40), 3000);
    assert.equal(e.samples.length, 4);
  });

  test('phải giữ đúng góc đủ số khung hình liền nhau', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    assert.equal(e.frame(frame(b, FRONT), 0).event, 'hold');
    assert.equal(e.frame(frame(b, LEFT), 220).event, 'hint');      // lệch góc: đếm lại
    assert.equal(e.frame(frame(b, FRONT), 440).event, 'hold');
    assert.equal(e.frame(frame(b, FRONT), 660).event, 'captured');
  });

  test('Lỗi đã gặp: quay cùng một bên hai lần không được tính là bước "quay phải"', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0);
    hold(e, b, LEFT, 1000);
    assert.equal(e.samples.length, 2);
    for (let t = 2000; t < 12000; t += 220) e.frame(frame(at(b, 0.05), LEFT), t);
    assert.equal(e.samples.length, 2);
  });

  test('Lỗi đã gặp: quay cùng phía ở bước "quay phải" thì được nhắc rõ là phải quay sang phải', () => {
    // QA camera thật: lời nhắc cũ "Quay sang phía ngược lại với lúc nãy" khó hiểu, người dùng quay sai phía gần 40 giây
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0);
    hold(e, b, LEFT, 1000);
    const r = e.frame(frame(at(b, 0.05), pose(0.15)), 2000);
    assert.match(r.tip, /cùng phía/);
    assert.match(r.tip, /quay sang phải/i);
  });

  test('quay hoặc ngẩng chưa đủ thì nhắc làm thêm một chút', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0);
    assert.match(e.frame(frame(b, pose(0.05)), 1000).tip, /thêm một chút/);
    hold(e, b, LEFT, 2000); hold(e, b, RIGHT, 3000);
    assert.match(e.frame(frame(b, pose(0, 0.43)), 4000).tip, /thêm một chút/);
  });

  test('ở bước "cúi xuống" mà đang ngẩng lên thì được nhắc rõ', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0); hold(e, b, LEFT, 1000); hold(e, b, RIGHT, 2000); hold(e, b, UP, 3000);
    assert.match(e.frame(frame(b, UP), 4000).tip, /cúi xuống/);
  });

  test('Lỗi đã gặp: một lần không khớp do mẫu nhiễu không làm tự chụp lại từ đầu', () => {
    // QA camera thật: mẫu nhìn thẳng lệch 0.5 với chính chủ, app chụp lại từ đầu ngay lần đầu không khớp
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0);
    const r = hold(e, at(b, 0.62), LEFT, 1000);            // một lần lệch quá mức
    assert.notEqual(r.event, 'restart');
    assert.equal(e.samples.length, 1);
    hold(e, b, LEFT, 2000);
    assert.equal(e.samples.length, 2);
  });

  test('mẫu nhìn thẳng là trung bình các khung hình đang giữ yên', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    const f1 = at(b, 0.1), f2 = at(b, 0.1);
    e.frame(frame(f1, FRONT), 0);
    e.frame(frame(f2, FRONT), 220);
    const mean = Array.from(f1, (x, i) => (x + f2[i]) / 2);
    assert.ok(euclidean(e.samples[0], mean) < 1e-6);
  });

  test('ngẩng hoặc cúi khi đang quay ngang thì không tính', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0); hold(e, b, LEFT, 1000); hold(e, b, RIGHT, 2000);
    for (let t = 3000; t < 8000; t += 220) e.frame(frame(at(b, 0.05), pose(0.2, 0.37)), t);
    assert.equal(e.samples.length, 3);
  });

  test('Lỗi đã gặp: cúi cùng chiều với lúc ngẩng không được tính là bước cuối', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0); hold(e, b, LEFT, 1000); hold(e, b, RIGHT, 2000); hold(e, b, UP, 3000);
    for (let t = 4000; t < 10000; t += 220) e.frame(frame(at(b, 0.05), UP), t);
    assert.equal(e.samples.length, 4);
    assert.equal(hold(e, b, DOWN, 11000).event, 'done');
  });

  test('đủ 5 bước theo đúng thứ tự: 5 mẫu, mẫu đầu là ảnh nhìn thẳng, kết thúc', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    const front = at(b, 0.01);
    e.frame(frame(front, FRONT), 0);
    e.frame(frame(front, FRONT), 220);
    const events = [hold(e, b, LEFT, 1000), hold(e, b, RIGHT, 2000), hold(e, b, UP, 3000), hold(e, b, DOWN, 4000)].map(r => r.event);
    assert.deepEqual(events, ['captured', 'captured', 'captured', 'done']);
    assert.equal(e.samples.length, 5);
    assert.ok(euclidean(e.samples[0], front) < 1e-6);
    assert.equal(e.active, false);
  });

  test('không phụ thuộc chiều camera: quay phải trước rồi trái vẫn hoàn tất', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0); hold(e, b, RIGHT, 1000); hold(e, b, LEFT, 2000); hold(e, b, DOWN, 3000);
    assert.equal(hold(e, b, UP, 4000).event, 'done');
  });

  test('Lỗi đã gặp: có hai người trong khung hình thì không chụp', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    for (let t = 0; t < 5000; t += 220) e.frame(frame(at(b, 0.05), FRONT, { faceCount: 2 }), t);
    assert.equal(e.samples.length, 0);
  });

  test('Lỗi đã gặp: người khác thế chỗ giữa chừng thì chụp lại từ đầu, không lưu mẫu nào của họ', () => {
    const b = person(), other = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0); hold(e, b, LEFT, 1000);
    let r;
    for (let k = 0; k < C.MISMATCH_RETRIES; k++) {
      r = hold(e, other, RIGHT, 2000 + k * 500);
      if (r.event !== 'restart') assert.equal(e.samples.length, 2, 'không được lưu mẫu của người khác');
    }
    assert.equal(r.event, 'restart');
    assert.equal(e.samples.length, 0);
    assert.equal(e.active, true);
  });

  test('Lỗi đã gặp: mặt quay nghiêng bị bộ phát hiện chấm thấp (0.5–0.7) vẫn chụp được ở bước quay', () => {
    // đo bằng ảnh thật: quay ~0.17 thì độ chắc chắn tụt dưới 0.7, app cũ kẹt và báo nhầm "đủ ánh sáng"
    const b = person(), e = new Enroller();
    e.start(0);
    hold(e, b, FRONT, 0);
    for (let i = 0; i < C.HOLD_FRAMES; i++) e.frame(frame(at(b, 0.05), LEFT, { score: 0.6 }), 1000 + i * 220);
    assert.equal(e.samples.length, 2);
  });

  test('ảnh nhìn thẳng vẫn phải rõ (độ chắc chắn từ 0.7)', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    for (let t = 0; t < 3000; t += 220) e.frame(frame(at(b, 0.05), FRONT, { score: 0.6 }), t);
    assert.equal(e.samples.length, 0);
  });

  test('mặt quá nhỏ, mờ hoặc không có mặt thì không chụp', () => {
    const b = person(), e = new Enroller();
    e.start(0);
    for (let t = 0; t < 3000; t += 220) {
      e.frame(frame(b, FRONT, { boxRatio: 0.1 }), t);
      e.frame(frame(b, FRONT, { score: 0.5 }), t + 1);
      e.frame({ descriptor: null, pose: null, faceCount: 0 }, t + 2);
    }
    assert.equal(e.samples.length, 0);
  });

  test('chưa bấm bắt đầu thì không chụp', () => {
    const e = new Enroller();
    assert.equal(e.frame(frame(person(), FRONT), 0).event, 'idle');
    assert.equal(e.samples.length, 0);
  });
});

// ---------- Trùng khuôn mặt khi đăng ký ----------
describe('findDuplicate', () => {
  test('giống nhân viên khác thì cảnh báo, khác hẳn thì không', () => {
    const a = person(), b = person();
    const employees = [{ code: 'A', name: 'A', descriptors: [at(a, 0.1), at(a, 0.2)] }, { code: 'B', name: 'B', descriptors: [at(b, 0.1)] }];
    assert.equal(findDuplicate(at(a, 0.15), employees, 'NEW')?.emp.code, 'A');
    assert.equal(findDuplicate(person(), employees, 'NEW'), null);
  });
  test('bỏ qua chính người đang sửa và người chưa có mẫu', () => {
    const a = person();
    const employees = [{ code: 'A', name: 'A', descriptors: [at(a, 0.1)] }, { code: 'C', name: 'C', descriptors: [] }];
    assert.equal(findDuplicate(at(a, 0.1), employees, 'A'), null);
  });
});

// ---------- App dùng đúng logic đã test ----------
describe('app.js dùng face-logic.js', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  test('không tự định nghĩa lại ngưỡng hay cách so khớp riêng', () => {
    assert.doesNotMatch(app, /const\s+MATCH_THRESHOLD\s*=/);
    assert.doesNotMatch(app, /FaceMatcher/);
    assert.doesNotMatch(app, /euclideanDistance/);
    assert.match(app, /= FaceLogic;/);
    assert.match(app, /new Verifier\(/);
    assert.match(app, /new Enroller\(/);
  });
  test('chấm công kiểm tra xác minh còn mới', () => {
    assert.match(app, /verifier\.isFresh\(Date\.now\(\)\)/);
  });
  test('app.js có đủ các phần đã nối với giao diện', () => {
    for (const [what, re] of [
      ['nhập danh sách', /function previewImport[\s\S]*\/api\/employees\/import/],
      ['chọn ca', /function renderShift[\s\S]*suggestShift\(/],
      ['trạng thái ca đang mở', /\/api\/status/],
      ['vị trí GPS', /navigator\.geolocation\.watchPosition/],
      ['tải ảnh khuôn mặt', /async function addUpload[\s\S]*checkUpload\(/],
      ['ảnh đại diện', /\/api\/avatar\?code=/],
    ]) assert.match(app, re, what);
    for (const id of ['btnImport', 'importDlg', 'shiftOpts', 'shiftNow', 'geoInfo', 'btnUploadFace', 'faceFiles', 'eShift']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
      assert.match(app, new RegExp(`\\$\\('${id}'\\)`), 'app.js dùng ' + id);
    }
  });

  test('Lỗi đã gặp: hàng đợi offline 30 giây/lần tải lại bảng công kể cả khi không có gì để gửi (cạn hạn mức list KV)', () => {
    // mỗi tab quản trị gọi /api/logs 2 lần/phút, kể cả khi tab bị ẩn: ~5.700 lệnh list/ngày
    const body = app.match(/async function flushQueue\([^)]*\) \{[\s\S]*?\n\}\n/)[0];
    assert.equal(body.match(/loadToday\(/g).length, 1, 'chỉ gọi loadToday ở một chỗ');
    assert.match(body, /if \(sent\)[^\n]*loadToday\(/, 'chỉ làm mới khi đã gửi được lượt nào');
  });

  test('Lỗi đã gặp: trên điện thoại nút chấm công nằm dưới màn hình phải cuộn mới thấy, thanh điều hướng chỉ có một mục', () => {
    assert.match(app, /document\.body\.classList\.toggle\('solo', !isAdmin\(\)\)/, 'nhân viên: ẩn thanh điều hướng một mục');
    const mobile = [...html.matchAll(/@media \(max-width:760px\)\{([\s\S]*?)\n  \}/g)].map(m => m[1]).join('\n');
    assert.match(mobile, /body\.solo \.nav\{display:none\}/);
    // Cách sửa đầu tiên (nút dính đáy, camera 48svh) vẫn phải cuộn trên màn thấp, và cuộn thì camera trôi khỏi màn:
    // không thấy khuôn mặt đã xác minh chưa. Giờ màn Chấm công cao đúng một màn hình, không cuộn: camera tràn kín màn,
    // nút và chọn ca nổi trên video ở đáy, nên luôn nằm trong màn hình. Áp cho mọi cỡ màn (máy tính cũng vậy),
    // nên kiểm tra CSS chung chứ không chỉ khối điện thoại.
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');   // bỏ các khối @media
    assert.match(outside, /body:has\(#view-kiosk:not\(\[hidden\]\)\)\{height:100svh;overflow:hidden;display:flex;flex-direction:column\}/, 'màn chấm công cao đúng một màn hình, không cuộn (mọi cỡ màn)');
    assert.match(outside, /#stageHome \.stage\{position:absolute;inset:0;/, 'camera phủ kín màn hình (mọi cỡ màn)');
    assert.match(outside, /\.side\{position:absolute;left:0;right:0;bottom:0;/, 'nút chấm công ghim ở đáy màn hình, nổi trên video (mọi cỡ màn)');
    assert.doesNotMatch(css, /\.stage\{[^}]*height:clamp/, 'camera không đặt cứng chiều cao (cứng thì màn thấp đẩy nút xuống dưới)');
  });

  test('Lỗi đã gặp: khung oval cố định theo pixel trong SVG, không co theo khung camera (máy tính, điện thoại khác nhau)', () => {
    // Khung cũ: ellipse cố định trong SVG 400×300 (rx 76). Lần sửa sau đặt 59% bề ngang thì lại quá to trên máy tính
    // (mặt ngồi trước webcam chỉ ~30% khung). Giờ: oval đứng yên làm khung hướng dẫn, cỡ vừa phải theo từng loại màn hình.
    assert.doesNotMatch(html, /<ellipse class="ring"/);
    const pct = css => Number(css.match(/width:min\((\d+)cqw/)?.[1]);
    const desk = pct(html.match(/\.guide \.oval\{([^}]*)\}/)?.[1] || '');
    assert.ok(desk >= 32 && desk <= 42, `máy tính: oval rộng 32–42% khung (đang ${desk || '?'}%)`);
    // chỉ các khối @media nhiều dòng (khối một dòng như {main{padding:16px}} làm regex chạy lan sang CSS máy tính)
    const mobile = [...html.matchAll(/@media \(max-width:760px\)\{\n([\s\S]*?)\n  \}/g)].map(m => m[1]).join('\n');
    const phone = pct(mobile.match(/\.guide \.oval\{([^}]*)\}/)?.[1] || '');
    assert.ok(phone >= 45 && phone <= 56, `điện thoại (mặt gần camera hơn): oval rộng 45–56% khung (đang ${phone || '?'}%)`);
    assert.match(html, /\.guide \.oval\{[^}]*aspect-ratio:3\/4/, 'giữ tỉ lệ khuôn mặt');
    assert.doesNotMatch(html, /\.oval\.track/, 'oval đứng yên, không chạy theo mặt');
  });

  test('index.html nạp đủ các file logic dùng chung trước app.js', () => {
    for (const f of ['face-logic.js', 'sort.js', 'shifts.js', 'import.js']) {
      assert.ok(html.indexOf(`src="${f}"`) > 0 && html.indexOf(`src="${f}"`) < html.indexOf('src="app.js"'), f);
    }
  });
  test('index.html nạp face-logic.js trước app.js', () => {
    assert.ok(html.indexOf('face-logic.js') > 0 && html.indexOf('face-logic.js') < html.indexOf('app.js'));
  });
});
