// Thông báo kiểu Sonner: thẻ nhỏ có biểu tượng theo loại, xếp chồng (mới nhất ở trước, 2 cái cũ ló mép phía sau),
// rê chuột / chạm thì xoè ra, tự tắt sau vài giây (dừng đếm khi đang xoè hoặc app chạy nền), vuốt để tắt.
// Máy tính: góc dưới bên phải. Điện thoại: giữa phía trên.
(function (root) {
  const GAP = 14;        // khoảng cách giữa các thông báo khi xoè
  const PEEK = 14;       // phần mép cái cũ ló ra phía sau khi gộp
  const VISIBLE = 3;     // gộp thì chỉ thấy 3 cái mới nhất
  const SCALE = 0.05;    // mỗi lớp phía sau nhỏ đi 5%
  const DURATION = 4000;
  const SWIPE = 45;      // vuốt từ chừng này (px) trở lên thì tắt (giống Sonner)
  const FLICK = 0.11;    // hoặc vuốt nhanh hơn chừng này (px/ms)

  // Vị trí của từng thông báo trong chồng. heights: chiều cao thật, mới nhất trước (i = 0).
  // y: khoảng cách từ mép màn (px); h: chiều cao hiển thị (gộp thì các lớp sau cao bằng lớp trước).
  function stackLayout(heights, expanded) {
    let before = 0;
    return heights.map((h, i) => {
      const y = expanded ? before + i * GAP : i * PEEK;
      before += h;
      return { y, h: expanded || i === 0 ? h : heights[0], scale: expanded ? 1 : Math.max(0, 1 - i * SCALE), visible: i < VISIBLE };
    });
  }

  // Vuốt như Sonner: hướng được phép tắt lấy theo vị trí (góc dưới phải: xuống, phải; giữa phía trên: lên).
  // Hướng đó thì thẻ đi theo tay; hướng khác bị cản (đi tối đa ~20px) rồi bật về.
  const swipeDirs = edge => edge === 'bottom' ? ['bottom', 'right'] : ['top'];
  const dampen = d => d * (1 / (1.5 + Math.abs(d) / 20));
  // axis: 'x' | 'y' (khoá theo chiều kéo đầu tiên); delta: px kéo được trên trục đó
  function swipeOffset(axis, delta, dirs) {
    const [neg, pos] = axis === 'y' ? ['top', 'bottom'] : ['left', 'right'];
    if (!dirs.includes(neg) && !dirs.includes(pos)) return 0;   // trục không có hướng nào để tắt: đứng yên
    if ((dirs.includes(neg) && delta < 0) || (dirs.includes(pos) && delta > 0)) return delta;
    const d = dampen(delta);
    return Math.abs(d) < Math.abs(delta) ? d : delta;
  }
  const shouldDismiss = (amount, ms) => Math.abs(amount) >= SWIPE || Math.abs(amount) / Math.max(1, ms) > FLICK;

  const ICONS = {
    ok: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"/><path d="m8.5 12.2 2.4 2.4 4.8-5"/>',
    err: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
    warn: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
    info: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"/><path d="M12 11v5M12 8h.01"/>',
  };

  function create(list, { phone = () => false } = {}) {
    const items = [];   // mới nhất trước: { el, left, timer, since }
    let expanded = false;
    const edge = () => phone() ? 'top' : 'bottom';

    function layout() {
      list.dataset.edge = edge();
      const live = items.filter(t => !t.removed);
      const box = stackLayout(live.map(t => t.full), expanded);
      live.forEach((t, i) => {
        const b = box[i];
        Object.assign(t.el.dataset, { front: i === 0, visible: b.visible });
        t.el.style.setProperty('--y', b.y + 'px');
        t.el.style.setProperty('--s', b.scale);
        t.el.style.height = b.h + 'px';
        t.el.style.zIndex = live.length - i;   // mới nhất nằm trên cùng (trong DOM nó đứng đầu, sẽ bị cái sau vẽ đè)
      });
      list.dataset.expanded = expanded;
      list.style.height = live.length ? (expanded ? box.at(-1).y + live.at(-1).full : live[0].full + PEEK * (Math.min(live.length, VISIBLE) - 1)) + 'px' : '0';
    }
    // đếm giờ tự tắt: dừng khi đang xoè hoặc app chạy nền
    const paused = () => expanded || document.hidden;
    function tick(t) {
      clearTimeout(t.timer);
      if (t.removed) return;
      if (paused()) { t.left -= t.since ? Date.now() - t.since : 0; t.since = 0; return; }
      t.since = Date.now();
      t.timer = setTimeout(() => dismiss(t), Math.max(0, t.left));
    }
    const retickAll = () => items.forEach(t => { if (t.since) t.left -= Date.now() - t.since; t.since = 0; tick(t); });
    function dismiss(t) {
      if (t.removed) return;
      t.removed = true; clearTimeout(t.timer);
      t.el.dataset.removed = 'true';
      setTimeout(() => { t.el.remove(); items.splice(items.indexOf(t), 1); if (!items.length) setExpanded(false); layout(); }, 200);
      layout();
    }
    function setExpanded(v) { if (expanded === v) return; expanded = v; layout(); retickAll(); }

    list.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') setExpanded(true); });
    list.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') setExpanded(false); });
    document.addEventListener('visibilitychange', retickAll);
    // điện thoại: chạm ra ngoài chồng thông báo thì gộp lại
    document.addEventListener('pointerdown', e => { if (expanded && e.pointerType !== 'mouse' && !list.contains(e.target)) setExpanded(false); });
    matchMedia('(max-width:760px)').addEventListener('change', layout);

    function show(msg, type = 'info', ms = DURATION) {
      if (!ICONS[type]) type = 'info';
      const el = document.createElement('li');
      el.className = 'toast';
      el.dataset.type = type;
      el.setAttribute('role', type === 'err' ? 'alert' : 'status');
      el.innerHTML = `<svg class="t-ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[type]}</svg><span class="t-msg"></span><button type="button" class="t-x" aria-label="Đóng thông báo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button>`;
      el.querySelector('.t-msg').textContent = msg;
      const t = { el, left: ms, since: 0, full: 0 };
      el.querySelector('.t-x').onclick = () => dismiss(t);
      // vuốt để tắt, như Sonner: khoá trục theo chiều kéo đầu tiên, hướng được phép thì đi theo tay, hướng khác bị cản
      let drag = null;   // { x, y, at, axis, amount }
      const setSwipe = (x, y) => { el.style.setProperty('--swipe-x', x + 'px'); el.style.setProperty('--swipe-y', y + 'px'); };
      const reset = () => { drag = null; delete el.dataset.swiping; delete el.dataset.swiped; setSwipe(0, 0); };
      el.addEventListener('pointerdown', e => {
        if (e.button === 2 || t.removed) return;
        try { el.setPointerCapture(e.pointerId); } catch {}   // giữ nhận sự kiện khi tay kéo ra ngoài thẻ
        if (e.target.closest('button')) return;   // bấm nút thì không vuốt
        drag = { x: e.clientX, y: e.clientY, at: Date.now(), axis: null, amount: 0 };
        el.dataset.swiping = 'true';
      });
      el.addEventListener('pointermove', e => {
        if (!drag || getSelection()?.toString()) return;   // đang bôi đen chữ thì không vuốt
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.axis && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (!drag.axis) return;
        drag.amount = swipeOffset(drag.axis, drag.axis === 'x' ? dx : dy, swipeDirs(edge()));
        if (drag.amount) el.dataset.swiped = 'true';
        setSwipe(drag.axis === 'x' ? drag.amount : 0, drag.axis === 'y' ? drag.amount : 0);
      });
      el.addEventListener('pointerup', e => {
        if (!drag) return;
        const { axis, amount, at } = drag;
        if (axis && shouldDismiss(amount, Date.now() - at)) {
          drag = null; delete el.dataset.swiping;
          el.dataset.swipeOut = axis === 'x' ? (amount > 0 ? 'right' : 'left') : (amount > 0 ? 'down' : 'up');
          return dismiss(t);
        }
        const tapped = !axis && e.pointerType !== 'mouse';
        reset();
        if (tapped) setExpanded(!expanded);   // chạm (không vuốt): xoè / gộp
      });
      el.addEventListener('pointercancel', reset);

      list.prepend(el);
      t.full = el.getBoundingClientRect().height;
      items.unshift(t);
      layout();
      requestAnimationFrame(() => requestAnimationFrame(() => { el.dataset.mounted = 'true'; }));   // trượt vào từ mép màn
      // quá nhiều thì bỏ bớt cái cũ nhất (không còn thấy được)
      items.filter(x => !x.removed).slice(VISIBLE + 2).forEach(dismiss);
      tick(t);
      return () => dismiss(t);
    }
    return { show };
  }

  const api = { GAP, PEEK, VISIBLE, SCALE, DURATION, SWIPE, FLICK, stackLayout, swipeDirs, dampen, swipeOffset, shouldDismiss, create };
  root.Toaster = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
