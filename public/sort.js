// Sắp xếp danh sách trong Bảng công. Dùng chung cho app và bộ test (test/sort.test.js).
(function (root) {
  const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
  const code = r => r.emp?.code ?? r.code ?? '';
  const name = r => r.emp?.name ?? r.name ?? '';
  const inTs = r => r.first?.ts ?? null;
  // người chưa vào luôn xếp cuối
  const byIn = dir => (a, b) => (inTs(a) === null) - (inTs(b) === null) || dir * ((inTs(a) ?? 0) - (inTs(b) ?? 0));

  const SORTS = {
    'code-desc': { label: 'Mã NV (giảm dần)', cmp: (a, b) => collator.compare(code(b), code(a)) },
    'code-asc': { label: 'Mã NV (tăng dần)', cmp: (a, b) => collator.compare(code(a), code(b)) },
    'name': { label: 'Họ tên (A → Z)', cmp: (a, b) => collator.compare(name(a), name(b)) || collator.compare(code(a), code(b)) },
    'in-asc': { label: 'Giờ vào (sớm trước)', cmp: byIn(1) },
    'in-desc': { label: 'Giờ vào (muộn trước)', cmp: byIn(-1) },
    'hours-desc': { label: 'Số giờ làm (nhiều trước)', cmp: (a, b) => (b.ms || 0) - (a.ms || 0) || collator.compare(code(a), code(b)) },
  };
  const DEFAULT_SORT = 'code-desc';

  function sortRows(rows, key) {
    const s = SORTS[key] || SORTS[DEFAULT_SORT];
    return [...rows].sort(s.cmp);
  }

  const api = { SORTS, DEFAULT_SORT, sortRows };
  root.ReportSort = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
