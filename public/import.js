// Đọc danh sách nhân viên từ file CSV hoặc nội dung dán từ Excel. Dùng chung cho app và test.
(function (root) {
  const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();

  // Tiêu đề cột chấp nhận (không phân biệt dấu, hoa thường)
  const HEADERS = {
    code: ['ma nv', 'ma', 'ma nhan vien', 'code', 'id'],
    name: ['ho ten', 'ho va ten', 'ten', 'name', 'full name'],
    role: ['quyen', 'vai tro', 'role'],
    shift: ['ca', 'ca lam', 'ca thuong lam', 'shift'],
    tg: ['telegram', 'tg', 'username telegram'],
  };
  const TEMPLATE = 'Mã NV,Họ tên,Quyền,Ca,Telegram\r\nNV01,Nguyễn Văn An,Nhân viên,Sáng,@nguyenvanan\r\nNV02,Trần Thị Bích,Quản trị,Tối,\r\n';

  // Tách dòng/cột, hỗ trợ ô có dấu ngoặc kép, xuống dòng trong ô, dấu "" thay cho "
  function parseTable(text) {
    text = String(text).replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
    const delim = ['\t', ';', ','].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x));
  }

  const mapRole = v => ['quan tri', 'quan tri vien', 'admin', '1'].includes(fold(v)) ? 1 : 2;
  function mapShift(v) {
    const f = fold(v).replace(/^ca\s+/, '');
    if (!f) return '';
    if (['sang', 'morning', 'day'].includes(f)) return 'sang';
    if (['toi', 'dem', 'night', 'evening'].includes(f)) return 'toi';
    return v;   // để server báo lỗi đúng giá trị đã nhập
  }

  // Trả về { rows: [{ code, name, role, shift, tg }], errors: [chuỗi] }
  function parseEmployees(text) {
    const table = parseTable(text);
    if (!table.length) return { rows: [], errors: ['Không có dữ liệu'] };
    const head = table[0].map(fold);
    const col = {};
    for (const [key, names] of Object.entries(HEADERS)) {
      const i = head.findIndex(h => names.includes(h));
      if (i >= 0) col[key] = i;
    }
    let body = table.slice(1);
    if (col.code === undefined || col.name === undefined) {
      // không có dòng tiêu đề: coi thứ tự cột là Mã NV, Họ tên, Quyền, Ca, Telegram
      if (head.length >= 2 && !Object.keys(col).length) { Object.assign(col, { code: 0, name: 1, role: 2, shift: 3, tg: 4 }); body = table; }
      else return { rows: [], errors: ['Không tìm thấy cột "Mã NV" và "Họ tên" ở dòng đầu'] };
    }
    const get = (r, k) => col[k] === undefined ? '' : (r[col[k]] ?? '');
    const rows = body.map(r => ({ code: get(r, 'code'), name: get(r, 'name'), role: mapRole(get(r, 'role')), shift: mapShift(get(r, 'shift')), tg: get(r, 'tg') }));
    return { rows, errors: [] };
  }

  const api = { parseTable, parseEmployees, TEMPLATE };
  root.ImportList = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
