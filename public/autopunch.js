// Tự check-in sau khi xác minh khuôn mặt: đếm ngược quanh oval, người dùng bấm Huỷ được.
// File này chỉ quyết định khi nào được tự chấm; xác minh khuôn mặt vẫn hoàn toàn do face-logic.js (Verifier).
(function (root) {
  const DELAY_MS = 3000;   // đủ để thấy và bấm Huỷ, không bắt người dùng chờ lâu

  // s: { verified, canPunch, action, attempted, dialogOpen, hidden, enrolling }
  //   verified    khuôn mặt đã xác minh xong (kể cả bước quay nhẹ đầu)
  //   canPunch    nút chấm công đang bấm được (có ca để vào, không đang gửi, không vừa chấm xong)
  //   action      'in' | 'out': việc tiếp theo
  //   attempted   lần xác minh này đã tự chấm (hoặc người dùng đã Huỷ): không tự chấm lại
  function canAuto(s) {
    return !!s.verified && !!s.canPunch && s.action === 'in'   // chỉ tự check-in: mở app giữa ca để xem giờ không được tự check-out
      && !s.attempted && !s.dialogOpen && !s.hidden && !s.enrolling;
  }
  const secondsLeft = (until, now) => Math.max(0, Math.ceil((until - now) / 1000));

  const api = { DELAY_MS, canAuto, secondsLeft };
  root.AutoPunch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
