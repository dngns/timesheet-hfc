# Timesheet — Chấm công bằng nhận diện khuôn mặt

Ứng dụng web cài được như app (PWA) để chấm công. Nhân viên đứng trước camera, ứng dụng tự nhận ra là ai, bấm **Check-in / Check-out** là ảnh kèm ngày giờ được gửi thẳng vào **group Telegram**. Bot trong group tự tổng hợp ai đã vào/ra và cảnh báo người quên chấm công.

**Chi phí vận hành: 0 đồng.** Chỉ dùng gói miễn phí của Cloudflare Workers và Telegram Bot.

## Kiến trúc

```
 Thiết bị chấm công (PWA)                Cloudflare Worker (miễn phí)            Telegram
 ┌──────────────────────────┐   ảnh    ┌──────────────────────────────┐ sendPhoto ┌───────────┐
 │ camera + nhận diện khuôn │ ───────▶ │ /api/punch  kiểm tra vào/ra  │ ────────▶ │  Group    │
 │ mặt ngay trên máy        │          │ KV: nhân viên + chỉ mục      │           │  chấm công│
 │ (face-api.js)            │ ◀─────── │ cron nhắc theo ca            │ ────────▶ │           │
 │ hàng đợi offline         │   dữ liệu│ cron tổng hợp cuối ca        │           │ /homnay   │
 └──────────────────────────┘          │ webhook lệnh bot             │ ◀──────── │           │
                                       └──────────────────────────────┘           └───────────┘
```

- **Nhận diện khuôn mặt** chạy ngay trên trình duyệt (face-api.js). Ảnh khuôn mặt mẫu **không** được gửi đi, chỉ lưu “vân khuôn mặt” (dãy 128 số).
- **Ảnh chấm công lưu trên Telegram.** Mỗi lượt là một tin nhắn ảnh trong group, kèm tên, giờ và cờ đi muộn.
- **Cloudflare KV** chỉ giữ danh sách nhân viên và chỉ mục (ai, mấy giờ, id ảnh trên Telegram) để bot tổng hợp. Bot API của Telegram không cho bot đọc lại lịch sử group, nên cần chỉ mục này.
- **Token bot nằm trong Worker**, không lộ ra trình duyệt.
- **Mất mạng** thì ảnh được giữ trên máy và tự gửi lại khi có mạng (vẫn đúng giờ chụp).

## Tính năng

| | |
|---|---|
| Nhận diện khuôn mặt | Mỗi máy chỉ xác minh người đã kích hoạt; cần quay nhẹ đầu một lần để chặn ảnh giơ trước camera |
| Chọn ca | **Ca sáng 08:00–17:00** hoặc **Ca tối 22:00–06:00 hôm sau**, chọn trước khi check-in (app gợi ý theo giờ) |
| Check-in / out | Ảnh gửi vào group Telegram kèm **thời gian dd/mm/yyyy hh:mm, mã NV, họ tên, ca, vị trí** |
| Vị trí | GPS của máy (có link Google Maps); không có GPS thì dùng vị trí ước lượng theo mạng |
| Ca qua nửa đêm | Ra lúc 06:00 vẫn tính cho ngày bắt đầu ca tối |
| Bot `/homnay` | Ai đã vào, ai đang làm, ai chưa đến, cho cả hai ca |
| Tự động | 09:00 nhắc ca sáng, 18:30 tổng hợp ca sáng, 23:00 nhắc ca tối, 07:00 tổng hợp ca tối hôm trước |
| Đi muộn | Check-in sau giờ bắt đầu ca + `LATE_GRACE_MIN` phút |
| Nhập danh sách | Dán từ Excel hoặc chọn file CSV; app tạo mã kích hoạt cho từng người, tải về được |
| Khuôn mặt từ ảnh | Đăng ký bằng ảnh tải lên thay cho chụp trực tiếp; ảnh chỉ đọc trên máy, server lưu 128 số và ảnh đại diện ~2–8KB |
| Bảng công | Theo ngày hoặc khoảng ngày, sắp xếp, xem ảnh, vị trí, xuất Excel (CSV) |
| PWA | Cài lên màn hình chính điện thoại / máy tính bảng, chạy toàn màn hình, dùng được khi mạng chập chờn |

## Cấu trúc

```
public/            giao diện PWA (Worker phục vụ luôn)
  index.html
  app.js           nhận diện khuôn mặt, chấm công, lịch sử, quản trị
  sw.js            service worker (offline, cache mô hình ~8MB)
  manifest.webmanifest
  icons/
src/worker.js      API + gửi Telegram + bot + lịch tự động
wrangler.toml      cấu hình Cloudflare (giờ nhắc, giờ làm, chat id)
.dev.vars.example  mẫu biến bí mật khi chạy thử trên máy
```

## Triển khai (khoảng 15 phút)

### 1. Tạo bot và group Telegram

1. Chat với **@BotFather** → `/newbot` → lưu lại **token**.
2. Tạo group chấm công và thêm bot vào group.

### 2. Cài đặt và đăng nhập Cloudflare (tài khoản miễn phí)

```bash
npm install
```

```bash
npx wrangler login
```

### 3. Tạo kho KV

```bash
npx wrangler kv namespace create KV
```

Dán `id` vừa nhận vào `wrangler.toml`, thay cho `REPLACE_WITH_KV_ID`.

### 4. Đặt các mã bí mật

Chạy từng lệnh và nhập giá trị khi được hỏi:

```bash
npx wrangler secret put BOT_TOKEN
```

```bash
npx wrangler secret put ADMIN_KEY
```

```bash
npx wrangler secret put WEBHOOK_SECRET
```

- `ADMIN_KEY`: mã của **tài khoản quản trị gốc**, dùng lần đầu để tạo quản trị viên và nhân viên. Tài khoản này không chấm công. Giữ kín.
- `WEBHOOK_SECRET`: một chuỗi ngẫu nhiên bất kỳ (chỉ chữ, số, `_`, `-`).

### 5. Đưa lên mạng

```bash
npm run deploy
```

Bạn sẽ nhận được địa chỉ dạng `https://timesheet.<tên-bạn>.workers.dev`.

### 6. Kết nối bot với group

1. Mở địa chỉ trên, nhập `ADMIN_KEY` ở màn kích hoạt → tab **Quản trị** → bấm **Kết nối bot**.
2. Trong group Telegram gõ `/chatid` → chép số (dạng `-100…`) vào `TELEGRAM_CHAT_ID` trong `wrangler.toml`.
3. Chạy lại `npm run deploy`.

### 7. Tạo tài khoản và đăng ký khuôn mặt

**Nhập nhiều người một lần:** tab **Quản trị** → **Nhập danh sách**. Trong Excel, chọn vùng dữ liệu kể cả dòng tiêu đề (Mã NV, Họ tên, Quyền, Ca, Telegram) rồi dán vào, hoặc lưu thành *CSV UTF-8* rồi chọn file. Bấm **Tải file mẫu** để xem đúng định dạng. Nhập xong, tải **danh sách mã kích hoạt** về và gửi riêng cho từng người. Sau đó đăng ký khuôn mặt cho từng người như bên dưới.

**Đăng ký khuôn mặt bằng ảnh:** trong form nhân viên bấm **Tải ảnh lên**, chọn 3–5 ảnh chụp rõ mặt (mỗi ảnh một người). App báo từng ảnh dùng được hay không. Ảnh không được gửi lên server.

**Từng người một:**

Tab **Quản trị** → **Thêm nhân viên**: nhập mã NV, họ tên, chọn **Quyền**, username Telegram (để bot tag) → bấm **Chụp khuôn mặt**, người đó nhìn vào camera và làm theo hướng dẫn (máy tự chụp 5 góc) → **Lưu nhân viên**.

Lưu xong, app hiện **mã kích hoạt** riêng của người đó (dạng `K7PM-3QXD`). Mã chỉ hiện một lần: gửi riêng cho họ. Làm mất thì vào **Sửa** → **Tạo mã kích hoạt mới**; mã cũ hết hiệu lực ngay.

| Quyền | Lưu dạng | Được dùng |
|---|---|---|
| Quản trị | `role: 1` | Chấm công, Bảng công, Quản trị |
| Nhân viên | `role: 2` | Chỉ chấm công cho chính mình |

Nên tạo ít nhất một quản trị viên thật (role 1) cho mình, rồi dùng mã đó thay cho `ADMIN_KEY`.

### 8. Cài app trên thiết bị chấm công

- **Android / Chrome / Edge:** bấm nút **Cài đặt ứng dụng** trên trang, hoặc menu ⋮ → *Cài đặt ứng dụng*.
- **iPhone / iPad (Safari):** nút Chia sẻ → *Thêm vào MH chính*.

Lần đầu mở app, nhập **mã kích hoạt** của mình. Máy chỉ xác minh khuôn mặt của người đã kích hoạt, nên người khác không chấm công hộ được. Muốn đổi người dùng trên máy, bấm nút đăng xuất ở góc trên bên phải.

## Tuỳ chỉnh

Trong `wrangler.toml`:

- `LATE_GRACE_MIN`: số phút ân hạn sau giờ bắt đầu ca (08:00 hoặc 22:00) mới tính đi muộn. Mặc định 30.
- `crons`: giờ nhắc và giờ tổng hợp (theo **UTC**, giờ VN = UTC + 7), xem chú thích trong file. Mặc định thứ 2–6. Muốn thêm thứ 7: đổi `1-5` thành `1-6` và `2-6` thành `2-7`.
- Giờ các ca: sửa `SHIFTS` ở **cả hai nơi** `src/worker.js` và `public/shifts.js` (có test kiểm tra hai nơi giống nhau).
- `TZ_OFFSET`: múi giờ.
- `HOLIDAYS`: ngày lễ không nhắc và không tổng hợp, cách nhau dấu phẩy, ví dụ `"2026-09-02,2027-01-01"`.

Trong `public/app.js`:

- Trong `public/face-logic.js`, `CONFIG.MATCH_THRESHOLD` (mặc định 0.42): giảm nếu hay nhận nhầm người, tăng nếu hay không nhận ra chính chủ. `CONFIG.LIVENESS`: bật/tắt bước quay nhẹ đầu để chặn ảnh giơ trước camera.

## Chạy thử trên máy

```bash
cp .dev.vars.example .dev.vars
```

Sửa `.dev.vars` rồi chạy:

```bash
npm run dev
```

Mở `http://localhost:8787`. Thêm `--test-scheduled` vào lệnh dev để thử cron qua `http://localhost:8787/__scheduled`.

## Giới hạn gói miễn phí

- **Cloudflare Workers:** 100.000 lượt gọi/ngày.
- **Cloudflare KV:** 1.000 lượt ghi/ngày, tức khoảng 450 nhân viên nếu mỗi người vào + ra một lần.
- **Telegram:** không giới hạn dung lượng ảnh. Bot gửi tối đa khoảng 20 tin/phút vào một group.

Công ty dưới vài trăm người dùng thoải mái.

## Lưu ý

- **Chống gian lận:** face-api.js không phân biệt được người thật với ảnh chụp giơ trước camera. Ảnh luôn được gửi vào group nên quản lý xem lại được. Nên đặt máy chấm công ở chỗ có người qua lại.
- **Ngày lễ:** bot vẫn nhắc vào ngày lễ rơi vào thứ 2–6. Có thể tạm tắt cron trên trang quản trị Cloudflare.
- **Chỉ mục:** KV giữ chỉ mục 120 ngày, ảnh vẫn còn mãi trên Telegram. Nên xuất CSV hằng tháng để lưu bảng công.
- **Lần mở đầu tiên:** cần mạng để tải mô hình nhận diện (~8MB). Từ lần sau, mô hình được lưu trên máy.
