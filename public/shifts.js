// Ca làm việc phía app. Giữ giống SHIFTS trong src/worker.js (test/shifts-import.test.js kiểm tra).
(function (root) {
  const SHIFTS = {
    sang: { name: 'Ca sáng', start: '08:00', end: '17:00', overnight: false },
    toi: { name: 'Ca tối', start: '22:00', end: '06:00', overnight: true },
  };
  const DEFAULT_SHIFT = 'sang';

  // Gợi ý ca theo giờ hiện tại: 04:00–13:59 là ca sáng, 18:00–03:59 là ca tối; giờ khác dùng ca thường làm
  function suggestShift(hour, fallback = DEFAULT_SHIFT) {
    if (hour >= 4 && hour < 14) return 'sang';
    if (hour >= 18 || hour < 4) return 'toi';
    return SHIFTS[fallback] ? fallback : DEFAULT_SHIFT;
  }
  const shiftLabel = k => `${SHIFTS[k].name} ${SHIFTS[k].start}–${SHIFTS[k].end}`;
  // Ngày công khi check-in ca này lúc `hour` của ngày `date` (YYYY-MM-DD): ca qua đêm vào sau nửa đêm tính ngày hôm trước
  function shiftDateFor(shift, date, hour) {
    if (!SHIFTS[shift].overnight || hour >= 12) return date;
    const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // Hết ngày công của ca (giờ máy): ca sáng 00:00 hôm sau, ca tối 12:00 trưa hôm sau. Giống dayEndTs trong src/worker.js.
  function dayEndsAt(date, shift) {
    const d = new Date(date + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    if (SHIFTS[shift]?.overnight) d.setHours(12);
    return d.getTime();
  }
  // Thiếu công: đã check-in mà tới hết ngày công của ca vẫn chưa check-out
  const isMissed = (row, now = Date.now()) => !!row.first && !row.last && now > dayEndsAt(row.date, row.shift);

  // Khung giờ check-in của ca: từ 2 giờ trước giờ vào tới hết ca (ca sáng 06:00–17:00, ca tối 20:00–06:00 hôm sau).
  // Check-out không bị giới hạn khung giờ (tăng ca). Giống isShiftOpen trong src/worker.js.
  const EARLY_MIN = 120;
  const toMin = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const openMin = shift => (toMin(SHIFTS[shift].start) - EARLY_MIN + 1440) % 1440;
  function isShiftOpen(shift, minuteOfDay) {
    if (!SHIFTS[shift]) return false;
    const from = openMin(shift), to = toMin(SHIFTS[shift].end);
    return from < to ? minuteOfDay >= from && minuteOfDay < to : minuteOfDay >= from || minuteOfDay < to;
  }
  const opensAt = shift => { const t = openMin(shift); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };

  const api = { SHIFTS, DEFAULT_SHIFT, suggestShift, shiftLabel, shiftDateFor, dayEndsAt, isMissed, isShiftOpen, opensAt };
  root.Shifts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
