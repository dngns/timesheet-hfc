// Oval hướng dẫn đứng yên giữa khung camera; người dùng đưa mặt vào. File này đo khuôn mặt thật so với oval để nhắc
// lại gần / lùi xa / đưa mặt vào giữa. Khung mặt do bộ nhận diện trả về (toạ độ trong video) được đổi sang toạ độ trên khung
// camera đang hiển thị: video phủ kín khung kiểu object-fit: cover (bị cắt hai bên hoặc trên dưới) và lật ngang như gương.
(function (root) {
  const PAD_W = 1.3;     // oval rộng hơn khung nhận diện (khung chỉ ôm từ má tới má)
  const ASPECT = 4 / 3;  // cao/rộng của oval, gần với hình đầu người
  const LIFT = 0.15;     // khung nhận diện không có trán: dời oval lên một chút theo chiều cao khung

  // box: { x, y, width, height } trong video; video, stage: { w, h }. Trả về tâm và kích thước oval (px trên khung hiển thị).
  function ovalFor(box, video, stage) {
    const s = Math.max(stage.w / video.w, stage.h / video.h);
    const offX = (stage.w - video.w * s) / 2, offY = (stage.h - video.h * s) / 2;
    const cx = stage.w - (offX + (box.x + box.width / 2) * s);
    const cy = offY + (box.y + box.height / 2 - LIFT * box.height) * s;
    const w = box.width * s * PAD_W;
    return { cx, cy, w, h: w * ASPECT };
  }

  // So vùng đầu (ovalFor) với oval hướng dẫn { cx, cy, w } trên khung hiển thị.
  // 'near': mặt nhỏ, lại gần; 'far': mặt to, lùi xa; 'center': lệch khỏi oval; null: vừa khung.
  const FIT = { MIN: 0.75, MAX: 1.25, OFF: 0.25 };
  function fitHint(head, oval) {
    const r = head.w / oval.w;
    if (Math.abs(head.cx - oval.cx) > FIT.OFF * oval.w || Math.abs(head.cy - oval.cy) > FIT.OFF * oval.w * 4 / 3) return 'center';
    if (r < FIT.MIN) return 'near';
    if (r > FIT.MAX) return 'far';
    return null;
  }
  const HINTS = { near: 'Lại gần camera hơn', far: 'Lùi ra xa một chút', center: 'Đưa mặt vào giữa khung' };

  const api = { ovalFor, fitHint, HINTS };
  root.Guide = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
