// Logic xác minh khuôn mặt và đăng ký góc mặt.
// Không phụ thuộc camera hay face-api, nên app dùng trực tiếp và bộ test (test/face-logic.test.js) chạy được bằng Node.
(function (root) {
  // Độ lệch khuôn mặt tối đa để coi là cùng một người (nhỏ hơn = khắt khe hơn).
  // Mức 0.6 mặc định của face-api quá dễ với khuôn mặt châu Á: hai người khác nhau hay chỉ lệch 0.4–0.55.
  const CONFIG = {
    MATCH_THRESHOLD: 0.42,
    DUP_THRESHOLD: 0.42,     // khi đăng ký: giống người khác hơn mức này thì cảnh báo
    SAME_PERSON_MAX: 0.55,   // khi đăng ký: các góc chụp phải cùng một người (góc nghiêng làm lệch tăng)
    VERIFY_WINDOW: 5,        // chấm công: xét 5 khung hình gần nhất...
    VERIFY_NEED: 4,          // ...cần 4 khung khớp
    FRONTAL_MAX_YAW: 0.15,   // chấm công: phải nhìn gần thẳng mới xét
    FRONTAL_MAX_ROLL: 0.3,
    FRESH_MS: 1500,          // bấm chấm công phải có lần xác minh trong khoảng này
    MISS_LOCK: 2,            // mất khuôn mặt 2 khung hình liền thì khoá chấm công ngay
    // Kiểm tra người thật: ảnh/màn hình là mặt phẳng nên góc quay đo được gần như không đổi khi xoay;
    // người thật quay nhẹ đầu thì đổi rõ. Cần cử động >= LIVE_TURN trong LIVE_WINDOW_MS gần nhất.
    LIVENESS: true,
    LIVE_TURN: 0.06,
    LIVE_WINDOW_MS: 6000,
    MIN_FACE_RATIO: 0.22,    // đăng ký: mặt chiếm ít nhất 22% bề ngang khung hình
    MIN_SCORE: 0.7,          // đăng ký: độ chắc chắn tối thiểu của bộ phát hiện mặt với ảnh nhìn thẳng
    MIN_SCORE_TURNED: 0.5,   // ...và khi quay/cúi: mặt nghiêng luôn bị chấm thấp hơn (đo bằng ảnh thật)
    HOLD_FRAMES: 2,          // đăng ký: giữ đúng góc 2 khung hình liền nhau mới chụp
    MISMATCH_RETRIES: 3,     // đăng ký: không khớp với mẫu nhìn thẳng 3 lần liền mới chụp lại từ đầu
    // Đăng ký: mức quay/cúi tối thiểu, tính so với lúc nhìn thẳng (đo bằng camera thật 2026-10-26:
    // quay tự nhiên lệch ~0.06–0.13, ngẩng/cúi lệch ~0.05–0.07)
    FRONT_MAX_YAW: 0.08,
    TURN_MIN: 0.08,
    PITCH_MIN: 0.04,
  };

  function euclidean(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
  }
  const median = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

  // Góc mặt từ 68 điểm mốc. yaw: 0 = nhìn thẳng, dấu cho biết quay bên nào.
  // pitch: khoảng mũi–mắt chia khoảng cách hai mắt, chỉ dùng để so với lúc nhìn thẳng.
  //   Không chia cho khoảng mắt–cằm: khi ngẩng/cúi hai khoảng cùng co giãn nên tỉ lệ gần như không đổi.
  // roll: độ nghiêng đầu (radian).
  function facePose(p) {
    const avg = pts => ({ x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length });
    const eyeL = avg(p.slice(36, 42)), eyeR = avg(p.slice(42, 48));
    const eyeY = (eyeL.y + eyeR.y) / 2, nose = p[30];
    return {
      yaw: (nose.x - p[0].x) / (p[16].x - p[0].x) - 0.5,
      pitch: (nose.y - eyeY) / Math.hypot(eyeR.x - eyeL.x, eyeR.y - eyeL.y),
      roll: Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x),
    };
  }

  // Độ lệch tới một người: trung bình 2 mẫu gần nhất.
  // Không lấy trung bình mọi góc như FaceMatcher: mẫu nghiêng kéo lệch của chính chủ lên và làm ngưỡng mất ý nghĩa.
  function faceDistance(desc, samples) {
    const d = samples.map(s => euclidean(desc, s)).sort((a, b) => a - b);
    return d.length > 1 ? (d[0] + d[1]) / 2 : d[0] ?? Infinity;
  }

  // Xác minh khi chấm công: chỉ so với mẫu của người đã kích hoạt máy.
  class Verifier {
    constructor(samples = [], cfg = CONFIG) { this.samples = samples; this.cfg = cfg; this.reset(); }
    reset() { this.win = []; this.verified = false; this.verifiedAt = 0; this.misses = 0; this.yaws = []; this.liveOk = false; }
    // Đã thấy cử động thì giữ xác nhận người thật cho tới khi rời camera hoặc người khác bước vào,
    // không bắt quay đầu lại chỉ vì ngồi yên lâu.
    get live() {
      if (!this.cfg.LIVENESS || this.liveOk) return true;
      if (!this.yaws.length) return false;
      const ys = this.yaws.map(y => y.yaw);
      return (this.liveOk = Math.max(...ys) - Math.min(...ys) >= this.cfg.LIVE_TURN);
    }
    // trả về { state, dist }: state = no-samples | turned | checking | unknown | live-check | ok
    frame({ descriptor, pose }, now) {
      const c = this.cfg;
      if (!this.samples.length) return { state: 'no-samples' };
      this.misses = 0;
      const dist = faceDistance(descriptor, this.samples);
      if (Math.abs(pose.yaw) > c.FRONTAL_MAX_YAW || Math.abs(pose.roll) > c.FRONTAL_MAX_ROLL) {
        // quay quá xa: xác minh lại danh tính, nhưng giữ phần đã xác nhận người thật
        const { yaws, liveOk } = this;
        this.reset();
        Object.assign(this, { yaws, liveOk });
        return { state: 'turned', dist };
      }
      this.win.push(dist);
      if (this.win.length > c.VERIFY_WINDOW) this.win.shift();
      const match = dist < c.MATCH_THRESHOLD;
      // khung hình hiện tại không khớp: khoá chấm công ngay, không chờ cả cửa sổ
      if (!match) { this.verified = false; this.verifiedAt = 0; }
      // 2 khung hình liền nhau không khớp: người khác vừa bước vào, phải xác nhận người thật lại
      if (this.win.length >= 2 && this.win.slice(-2).every(d => d >= c.MATCH_THRESHOLD)) {
        this.yaws = []; this.liveOk = false;
        return { state: 'unknown', dist };
      }
      if (match) {
        // chỉ ghi góc quay của các khung hình đúng người, trong cửa sổ thời gian gần nhất
        this.yaws.push({ t: now, yaw: pose.yaw });
        this.yaws = this.yaws.filter(y => now - y.t <= c.LIVE_WINDOW_MS);
      }
      if (match && this.win.filter(d => d < c.MATCH_THRESHOLD).length >= c.VERIFY_NEED) {
        if (!this.live) { this.verified = false; return { state: 'live-check', dist: median(this.win) }; }
        this.verified = true; this.verifiedAt = now;
        return { state: 'ok', dist: median(this.win) };
      }
      return { state: 'checking', dist };
    }
    // khung hình không thấy mặt: 1 khung có thể là nhiễu, MISS_LOCK khung liền thì khoá
    miss() {
      if (++this.misses >= this.cfg.MISS_LOCK) this.reset();
    }
    noFace() { this.reset(); }
    isFresh(now) { return this.verified && this.live && now - this.verifiedAt <= this.cfg.FRESH_MS; }
  }

  // Các bước đăng ký: chỉ chụp khi góc mặt thật sự đúng yêu cầu.
  // Bước quay/cúi thứ hai phải ngược chiều bước trước, nên không phụ thuộc camera có lật ảnh hay không.
  // Góc quay và góc cúi tính so với lúc nhìn thẳng (st.yaw0, st.pitch0 ghi ở bước 1),
  // vì mỗi người và mỗi vị trí đặt camera có độ lệch sẵn khác nhau.
  const dYaw = (p, st) => p.yaw - st.yaw0, dPitch = (p, st) => p.pitch - st.pitch0;
  // guide: lời nhắc theo đúng tư thế lúc đó khi chưa đạt (null = dùng tip)
  const MOVED = 0.03, NODDED = 0.015;
  const ENROLL_STEPS = [
    { tip: 'Nhìn thẳng vào camera', ok: p => Math.abs(p.yaw) < CONFIG.FRONT_MAX_YAW && Math.abs(p.roll) < 0.15 },
    { tip: 'Quay mặt sang trái', ok: (p, st) => Math.abs(dYaw(p, st)) > CONFIG.TURN_MIN,
      guide: (p, st) => Math.abs(dYaw(p, st)) > MOVED ? 'Quay thêm một chút' : null,
      mark: (p, st) => { st.yawSign = Math.sign(dYaw(p, st)); } },
    { tip: 'Quay mặt sang phải',
      ok: (p, st) => Math.sign(dYaw(p, st)) === -st.yawSign && Math.abs(dYaw(p, st)) > CONFIG.TURN_MIN,
      guide: (p, st) => Math.abs(dYaw(p, st)) <= MOVED ? null
        : Math.sign(dYaw(p, st)) === st.yawSign ? 'Bạn đang quay cùng phía với lúc nãy. Hãy quay sang phải' : 'Quay thêm một chút' },
    { tip: 'Nhìn thẳng, ngẩng lên một chút', ok: (p, st) => Math.abs(dYaw(p, st)) < 0.1 && Math.abs(dPitch(p, st)) > CONFIG.PITCH_MIN,
      guide: (p, st) => Math.abs(dYaw(p, st)) >= 0.1 ? 'Nhìn thẳng rồi mới ngẩng lên' : Math.abs(dPitch(p, st)) > NODDED ? 'Ngẩng thêm một chút' : null,
      mark: (p, st) => { st.pitchSign = Math.sign(dPitch(p, st)); } },
    { tip: 'Nhìn thẳng, cúi xuống một chút',
      ok: (p, st) => Math.abs(dYaw(p, st)) < 0.1 && Math.sign(dPitch(p, st)) === -st.pitchSign && Math.abs(dPitch(p, st)) > CONFIG.PITCH_MIN,
      guide: (p, st) => Math.abs(dYaw(p, st)) >= 0.1 ? 'Nhìn thẳng rồi mới cúi xuống'
        : Math.abs(dPitch(p, st)) <= NODDED ? null
        : Math.sign(dPitch(p, st)) === st.pitchSign ? 'Bạn đang ngẩng lên. Hãy cúi xuống' : 'Cúi thêm một chút' },
  ];

  class Enroller {
    constructor(cfg = CONFIG) { this.cfg = cfg; this.active = false; this.samples = []; }
    start(now) { Object.assign(this, { active: true, samples: [], st: {}, hold: 0, held: [], mismatch: 0, stepSince: now }); }
    stop() { this.active = false; }
    get done() { return this.samples.length >= ENROLL_STEPS.length; }
    get tip() { return this.done ? '' : ENROLL_STEPS[this.samples.length].tip; }
    // trả về { event, tip }: event = idle | hint | hold | captured | restart | done
    frame({ descriptor, pose, faceCount = 1, boxRatio = 1, score = 1 }, now) {
      const c = this.cfg;
      if (!this.active) return { event: 'idle' };
      const hint = tip => { this.hold = 0; this.held = []; return { event: 'hint', tip }; };
      if (faceCount > 1) return hint('Chỉ để một người trong khung hình');
      if (!descriptor) return hint('Đưa khuôn mặt vào khung');
      if (boxRatio < c.MIN_FACE_RATIO) return hint('Lại gần camera hơn');
      const i = this.samples.length, step = ENROLL_STEPS[i];
      if (score < (i === 0 ? c.MIN_SCORE : c.MIN_SCORE_TURNED)) return hint(i === 0 ? 'Giữ yên, đủ ánh sáng' : 'Quay ít lại một chút, giữ mặt rõ trong khung');
      if (!step.ok(pose, this.st)) return hint(step.guide?.(pose, this.st) || step.tip);
      this.held.push(Array.from(descriptor));
      if (++this.hold < c.HOLD_FRAMES) return { event: 'hold', tip: 'Giữ yên' };
      // mẫu nhìn thẳng: trung bình các khung hình đang giữ yên, để một khung nhiễu không làm hỏng mẫu gốc
      const sample = i === 0 ? this.held[0].map((_, k) => this.held.reduce((s, d) => s + d[k], 0) / this.held.length) : Array.from(descriptor);
      if (i > 0 && euclidean(sample, this.samples[0]) > c.SAME_PERSON_MAX) {
        if (++this.mismatch >= c.MISMATCH_RETRIES) {
          this.start(now);
          return { event: 'restart', tip: 'Khuôn mặt thay đổi giữa chừng. Đang chụp lại từ đầu, chỉ một người trước camera.' };
        }
        return hint('Giữ yên, chỉ một người trước camera');
      }
      if (i === 0) { this.st.pitch0 = pose.pitch; this.st.yaw0 = pose.yaw; }
      step.mark?.(pose, this.st);
      this.samples.push(sample);
      this.hold = 0; this.held = []; this.mismatch = 0; this.stepSince = now;
      if (this.done) { this.active = false; return { event: 'done', tip: '' }; }
      return { event: 'captured', tip: this.tip };
    }
  }

  // Ảnh khuôn mặt tải lên (thay cho chụp trực tiếp): mỗi ảnh phải có đúng 1 khuôn mặt đủ lớn, đủ rõ,
  // và mọi ảnh phải cùng một người với ảnh đầu tiên dùng được.
  // dets: [{ score, boxWidth, descriptor }] của một ảnh; imgWidth: bề ngang ảnh đã thu nhỏ.
  const UPLOAD = { MIN_FACE_RATIO: 0.12, MIN_SCORE: 0.6, SAME_PERSON_MAX: 0.6 };
  function checkUpload(dets, imgWidth, accepted = []) {
    if (!dets.length) return { ok: false, reason: 'Không thấy khuôn mặt' };
    if (dets.length > 1) return { ok: false, reason: `Có ${dets.length} người trong ảnh` };
    const d = dets[0];
    if (d.boxWidth / imgWidth < UPLOAD.MIN_FACE_RATIO) return { ok: false, reason: 'Khuôn mặt quá nhỏ, dùng ảnh chụp gần hơn' };
    if (d.score < UPLOAD.MIN_SCORE) return { ok: false, reason: 'Ảnh mờ hoặc tối' };
    if (accepted.length && euclidean(d.descriptor, accepted[0]) > UPLOAD.SAME_PERSON_MAX) return { ok: false, reason: 'Khác người với ảnh đầu tiên' };
    return { ok: true };
  }

  // Khi đăng ký: mẫu nhìn thẳng có giống nhân viên khác không
  function findDuplicate(frontal, employees, excludeCode, cfg = CONFIG) {
    let best = null;
    for (const e of employees) {
      if (e.code === excludeCode || !e.descriptors?.length) continue;
      const dist = faceDistance(frontal, e.descriptors);
      if (dist < cfg.DUP_THRESHOLD && (!best || dist < best.dist)) best = { emp: e, dist };
    }
    return best;
  }

  const api = { CONFIG, UPLOAD, ENROLL_STEPS, euclidean, median, facePose, faceDistance, Verifier, Enroller, findDuplicate, checkUpload };
  root.FaceLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
