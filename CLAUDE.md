# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Timesheet

PWA chấm công bằng nhận diện khuôn mặt, chạy hoàn toàn trên gói miễn phí Cloudflare Workers + Telegram Bot. Tổng quan và cách triển khai: `README.md`.

## Quy tắc

- Mỗi lần thay đổi code hoặc cấu hình, ghi vào `CHANGELOG.md` (mới nhất ở trên, chia Thêm / Thay đổi / Bỏ / Sửa lỗi). Nếu đã deploy, ghi kèm Version ID của Cloudflare.
- Viết tài liệu và giao diện bằng tiếng Việt.
- Logic xác minh và đăng ký khuôn mặt chỉ nằm trong `public/face-logic.js`; `app.js` không được tự định nghĩa lại ngưỡng hay cách so khớp.
- Chạy `npm test` sau mỗi thay đổi (test nhận diện `test/face-logic.test.js` và test backend `test/api.test.js`). Không xoá hay nới lỏng các test "Lỗi đã gặp"; lỗi mới tìm ra thì thêm test tái hiện trước khi sửa.
- Deploy bằng `npm run deploy` (tự chạy test trước), không gọi thẳng `wrangler deploy`.
- Sửa bất kỳ file nào trong `public/` thì tăng `VERSION` trong `public/sw.js` (máy đã cài chỉ tải lại file mới khi version đổi). Thêm file JS mới thì thêm vào `SHELL` trong `sw.js` và `<script>` trong `index.html`.
- Giờ ca (`SHIFTS`) nằm ở cả `src/worker.js` và `public/shifts.js`, phải sửa cả hai (`test/shifts-import.test.js` kiểm tra).

## Lệnh

```bash
npm test                                          # tất cả test (node --test, không cần cài gì thêm)
node --test test/api.test.js                      # một file
node --test --test-name-pattern="Lỗi đã gặp" test/*.test.js   # lọc theo tên test
npm run dev                                       # wrangler dev, cần .dev.vars (chép từ .dev.vars.example)
npm run simulate -- <số người> <số ngày> <số máy quản trị>   # mô phỏng tải, so với hạn mức gói miễn phí
```

`.claude/launch.json` có cấu hình `timesheet-qa` (cổng 8788): `ADMIN_KEY=root-admin-key`, Telegram trỏ vào địa chỉ chết, dùng để thử giao diện mà không gửi tin thật.

## Kiến trúc

- **`src/worker.js`**: một Worker duy nhất. `fetch` chia ba nhánh: `/telegram/webhook` (lệnh bot), `/api/*` (hàm `api`), còn lại phục vụ tĩnh `public/` qua `env.ASSETS`. `scheduled` chạy nhắc ca / tổng hợp theo `crons` trong `wrangler.toml` (giờ UTC, VN = UTC+7).
- **Ảnh chấm công không lưu trên server**: gửi thẳng vào group Telegram (`sendPhoto`). KV chỉ giữ chỉ mục vì bot không đọc lại được lịch sử group.
- **Khoá KV**:
  - `employees`: toàn bộ danh sách nhân viên (một JSON), gồm vân khuôn mặt 128 số.
  - `avatar:<mã>`: ảnh đại diện nhỏ.
  - `state:<mã>`: trạng thái vào/ra hiện tại; mất thì dựng lại từ log (`loadState`).
  - `log:<ngày>:<ts>:<mã>`: một lượt chấm công, dữ liệu nằm trong metadata, TTL 120 ngày.
  - `day:<ngày>`: ảnh chụp cả ngày đã khoá, đọc bằng `get` thay cho `list`.
- **Hạn mức gói miễn phí là ràng buộc thiết kế chính**: KV list và ghi chỉ 1.000 lần/ngày, đặt lại lúc 07:00 giờ VN (đúng giờ cao điểm). Thay đổi nào thêm `KV.list`/`KV.put` hoặc tăng tần suất gọi API từ app thì phải xem `TOI-UU-CHI-PHI.md` và chạy `test/capacity.test.js` / `npm run simulate`. Khi KV lỗi (hết hạn mức), chấm công vẫn phải chạy được.
- **Giới hạn tần suất**: Workers Rate Limiting (`RL_IP`, `RL_AUTH`, `RL_PUNCH`, `RL_ACTION` trong `wrangler.toml`), trả 429.
- **Xác thực**: header `X-Access-Code` mang mã kích hoạt, server so SHA-256 với `keyHash` của nhân viên (`authenticate`). `ADMIN_KEY` là tài khoản quản trị gốc, không chấm công. Quyền: `role: 1` quản trị, `role: 2` nhân viên.
- **Môi trường TEST / UAT**: cùng Worker, dữ liệu tách theo mã đăng nhập (`SPACES` trong `src/worker.js`). `authenticate` trả về `env` đã gắn môi trường: `env.KV` là KV nhìn qua tiền tố (`''` cho TEST, `uat:` cho UAT), nên code bên dưới dùng tên key như cũ. `ADMIN_KEY_UAT` là quản trị gốc UAT; mã máy `d_` TEST, `u_` UAT. Cron và bot lặp qua từng môi trường.
- **Phía app (`public/`)**: JS thuần, không build. Các module nhỏ (`face-logic.js`, `shifts.js`, `retry.js`, `sort.js`, `import.js`) viết dạng UMD: gắn vào `window` cho trình duyệt và `module.exports` cho test Node. Logic có thể test được thì đặt vào các module này, không đặt trong `app.js`. face-api.js tải từ CDN và được `sw.js` cache để chạy offline.
- **Đo hiệu năng thật (Core Web Vitals)**: `public/vitals.js` dùng `web-vitals` 6.2.3 (bản attribution, tự host ở `public/vendor/`) và `fetchLater()` gửi một gói lúc rời trang tới `POST /api/vitals`. Worker chỉ ghi một dòng log `{"type":"web-vitals",…}` (xem ở Workers → Observability, lọc "web-vitals"), không ghi KV. Trước khi tối ưu LCP/INP/CLS, xem số đo ở đó (INP có kèm đoạn script chạy lâu nhất).
- **Hàng đợi offline**: lượt chấm công lỗi mạng / 5xx / 429 được giữ trên máy và gửi lại theo thứ tự (`retry.js` quyết định lỗi nào thử lại).

## Test

- `test/api.test.js` import thẳng `src/worker.js` và chạy trong Node với `MemKV` (KV trong bộ nhớ, giả lập được hết hạn mức và độ trễ của list) và `fetch` giả lập Telegram (`TELEGRAM_API` trỏ sang host giả).
- `test/face-logic.test.js` dùng vector 128 chiều giả lập; kiểm tra quy tắc quyết định, không đo độ chính xác mô hình. Checklist test tay với camera thật: `QA-NHAN-DIEN.md`.
