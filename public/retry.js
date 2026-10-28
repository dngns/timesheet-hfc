// Gửi lại lượt chấm công chờ trong hàng đợi: khi nào thử lại, lỗi nào thì giữ lượt, báo lỗi ra sao.
(function (root) {
  const BASE_MS = 30e3, MAX_MS = 15 * 60e3;
  // lần thử thứ n thất bại thì chờ: 30 giây, 1, 2, 4, 8 phút, tối đa 15 phút
  const retryDelay = tries => Math.min(BASE_MS * 2 ** Math.max(0, tries - 1), MAX_MS);
  // status 0 = mất mạng. Mất mạng, server lỗi (5xx), bị giới hạn tần suất (429): giữ lượt, thử lại sau.
  // Lỗi khác (vd 409 đã check-in) là bị từ chối thật: bỏ lượt và báo.
  const isRetryable = status => !status || status >= 500 || status === 429;
  // ref: mã tra cứu server trả về (requestId), chỉ kèm với lỗi máy chủ để quản trị viên tra trong log
  function describeError(status, msg, ref) {
    if (!status) return 'Không có mạng';
    if (status >= 500) return 'Server đang lỗi' + (msg ? `: ${msg}` : '') + (ref ? ` (mã tra cứu: ${ref})` : '');
    return msg || 'Có lỗi xảy ra';
  }

  const api = { retryDelay, isRetryable, describeError };
  root.Retry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
