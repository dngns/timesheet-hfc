# Tối ưu để chạy trong gói miễn phí

Ghi chú các điểm có thể vượt giới hạn miễn phí khi dùng thật, và cách sửa. **Chưa làm**, làm khi số người dùng tăng hoặc khi thấy lỗi.

## Ước tính cho 30 người

Giả định mỗi người check-in và check-out một lần mỗi ngày (60 lượt/ngày).

| Dịch vụ | Giới hạn gói miễn phí | Ước tính dùng | Đánh giá |
|---|---|---|---|
| Workers: số lượt gọi | 100.000 / ngày | Vài trăm đến vài nghìn | Dư |
| Workers: người dùng cùng lúc | Tự mở rộng | — | Ổn |
| KV: đọc | 100.000 / ngày | Vài nghìn | Dư |
| KV: ghi | 1.000 / ngày | 60–70 | Dư |
| **KV: liệt kê (list)** | **1.000 / ngày** | **200 đến hơn 1.000** | **Có thể vượt** |
| **Telegram: tin vào một group** | **~20 tin / phút** | **Cao điểm 8:00–8:30 có thể vượt** | **Bị chặn tạm thời** |
| Nhận diện khuôn mặt | Chạy trên máy người dùng | — | Không tốn server |

## Điểm nghẽn 1: lệnh liệt kê của KV

Server dùng `KV.list` mỗi khi cần biết hôm nay ai đã chấm công (`logsOfDay` trong `src/worker.js`). Có ba chỗ gọi:

- Mỗi lượt chấm công: 1 lần, để kiểm tra thứ tự vào/ra.
- App đang mở tự làm mới mỗi 60 giây (`setInterval(loadToday, 60000)` trong `public/app.js`). Một tab mở cả ngày tốn khoảng 500 lần.
- Quản trị viên xem bảng công một tháng: khoảng 30 lần mỗi lần xem.

**Khi vượt:** server không kiểm tra được thứ tự vào/ra, nên lượt chấm công bị lỗi. Ảnh được giữ trên máy để gửi lại, nhưng phải chờ giới hạn đặt lại lúc 0h UTC (**7h sáng giờ Việt Nam**), đúng giờ mọi người bắt đầu chấm công.

**Cách sửa:**

1. Cache kết quả `logsOfDay(date)` bằng Cache API của Workers (`caches.default`, miễn phí, không tính vào giới hạn KV) trong khoảng 60 giây.
2. Xoá cache của ngày đó ngay sau khi ghi một lượt chấm công mới, để dữ liệu luôn đúng.
3. Ngày đã qua không còn thay đổi nên có thể cache lâu hơn (vài giờ). Xem bảng công một tháng sẽ gần như không tốn lệnh liệt kê.

**Cập nhật 2026-10-26 (đo trên Observability):** hạn mức vẫn bị vượt.
- Cache API **không có tác dụng trên `*.workers.dev`** (chỉ chạy khi gắn domain riêng), nên các bước 1–3 ở trên không giảm được lệnh list nào.
- Thủ phạm chính: hàng đợi offline chạy 30 giây/lần và luôn tải lại bảng công, kể cả khi trống và tab bị ẩn. Một tab quản trị tốn khoảng 4 lệnh list/phút; 3 giờ là hết 1.000.
- Đã sửa:
  - Hàng đợi chỉ làm mới khi gửi được lượt nào.
  - Ngày đã khoá (12:00 trưa hôm sau + 24 giờ cho lượt gửi trễ) lưu thành key `day:<ngày>`, đọc bằng `get`.
  - Ngày đã khoá chưa có ảnh chụp thì list theo tháng: bảng công một tháng tốn 1–2 lệnh lần đầu, 0 lệnh những lần sau. Mỗi ngày tốn thêm 1 lần ghi khi chụp.
  - Hết hạn mức list thì vẫn chấm công được.

## Điểm nghẽn 2: tốc độ gửi tin của Telegram

Telegram cho phép bot gửi khoảng 20 tin/phút vào một group. Nếu 30 người check-in trong cùng một phút, các lượt cuối nhận lỗi `429 Too Many Requests`.

Hiện tại server báo lỗi về app, app lưu lại và thử gửi sau 30 giây. Không mất dữ liệu, giờ chấm vẫn đúng giờ chụp, nhưng người dùng thấy dấu "Đã lưu, sẽ gửi khi có mạng" dù mạng bình thường.

**Cách sửa:** trong hàm `tg()` của `src/worker.js`, khi Telegram trả `429`, đọc `parameters.retry_after` (số giây phải chờ), chờ đúng số giây đó rồi gửi lại một lần trước khi báo lỗi.

## Điểm nghẽn 3: app tự làm mới quá thường xuyên

`public/app.js` gọi `loadToday` mỗi 60 giây, kể cả khi tab đang ẩn.

**Cách sửa:**

- Chỉ làm mới khi trang đang hiện (`document.visibilityState === 'visible'`).
- Giãn thời gian làm mới lên 5 phút.
- Làm mới ngay khi người dùng quay lại app (sự kiện `visibilitychange`).

## Kết quả mong đợi sau khi sửa

- Lệnh liệt kê KV giảm từ vài trăm–hơn 1.000 xuống còn vài chục mỗi ngày.
- Không còn lượt chấm công bị đẩy vào hàng chờ vì Telegram giới hạn tốc độ.
- Gói miễn phí đủ cho vài trăm người.

## Theo dõi mức dùng

Xem số liệu thực tế trên trang quản lý Cloudflare:

- **Workers & Pages → timesheet → Metrics:** số lượt gọi, lỗi, thời gian CPU.
- **Storage & Databases → KV → (namespace của app) → Metrics:** số lần đọc, ghi, liệt kê mỗi ngày.

Nếu thấy lệnh liệt kê vượt khoảng 500 lần/ngày, nên làm các bước sửa ở trên.
