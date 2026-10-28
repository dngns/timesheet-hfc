// "Chỉ lấy lần bấm cuối": bấm bộ lọc liên tục thì giao diện đổi ngay, nhưng chỉ gọi API cho lựa chọn cuối cùng
// (chờ `delay` ms không bấm thêm). Lần gọi mới huỷ request cũ còn đang chạy (AbortController); cancel() huỷ cả lần
// đang chờ lẫn request đang chạy (vd rời trang Bảng công).
(function (root) {
  function latestOnly(fn, delay = 300) {
    let timer = null, ctl = null;
    return {
      // fn(signal, ...args) chạy sau `delay` ms nếu không có lần run() mới
      run(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          ctl?.abort();
          ctl = new AbortController();
          fn(ctl.signal, ...args);
        }, delay);
      },
      cancel() {
        clearTimeout(timer); timer = null;
        ctl?.abort(); ctl = null;
      },
    };
  }

  const api = { latestOnly };
  root.Latest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
