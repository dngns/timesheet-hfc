# Nhật ký thay đổi

Mỗi lần thay đổi đều ghi vào đây, mới nhất ở trên. Ghi kèm phiên bản Cloudflare nếu đã deploy.

## 2026-10-26: Check-in 1 lần, check-out kết thúc ca, tăng ca, thiếu công

Đã deploy: phiên bản `ab1a647e-074f-4481-9e98-349b843d7cc5` (2026-10-26).

### Sửa lỗi
- **Đã check-in rồi mà app vẫn hiện nút Check-in.**
  - Nguyên nhân: trạng thái ca được dựng từ lệnh liệt kê của KV, mà lệnh này có thể chậm tới ~60 giây mới thấy lượt vừa ghi. App hỏi trạng thái ngay sau khi check-in nên nhận "chưa vào ca". Cùng nguyên nhân đó, server có thể **cho check-in trùng** trong khoảng chậm này.
  - Cách sửa: mỗi người có một bản ghi trạng thái riêng `state:<mã NV>` trong KV (ca, giờ vào, các lần ra). Server đọc thẳng key này, thấy ngay giá trị vừa ghi. App cũng không để kết quả cũ từ server đè lên lượt vừa chấm trong 2 phút. Người chấm từ bản cũ được dựng lại trạng thái một lần từ lịch sử.

### Thay đổi
- **Mỗi ca chỉ check-in 1 lần.** Check-in lại cùng ca bị từ chối; ở bước chọn ca, ca đã chấm hiện "Đã chấm ca này" và không chọn được.
- **Check-out là kết thúc ca.** Sau đó nút chính là **"Check-out tăng ca (lần 2/3)"** cho người làm thêm; tối đa 3 lần check-out, giờ làm tính tới lần check-out cuối (Bảng công, Excel, bot). Có lựa chọn **"Vào ca khác"** để check-in ca còn lại ngay, không phải đợi.
- **Sang ngày công mới thì quay về Check-in:** ca sáng lúc 00:00 hôm sau, ca tối lúc 12:00 trưa hôm sau (ca tối check-out 06:00 và tăng ca buổi sáng vẫn thuộc ca đêm trước).
- **Thiếu công:** đã check-in mà tới mốc trên vẫn chưa check-out thì không check-out bù được nữa, ngày đó **không được tính công**. Bảng công ghi "thiếu công: quên check-out"; câu tổng kết đếm số ngày thiếu công; file Excel thêm cột "Tính công" (Có / Không (quên check-out) / Đang làm). Tin tổng hợp cuối ca của bot nhắc rõ hạn check-out để còn được tính công.
- Ảnh Telegram và Bảng công ghi số lần check-out ("CHECK-OUT (lần 2/3)"). `GET /api/status` trả thêm `outs`, `lastOut` và `last` (ca đã check-in gần nhất).
- Mỗi lượt chấm tốn thêm 1 lần ghi KV (bản ghi trạng thái); 30 người vẫn dưới giới hạn 1.000 lần ghi/ngày.
- Bộ test lên 164 test, có test giả lập lệnh liệt kê KV chậm. Service worker lên `v12`.

## 2026-10-26: Ca làm việc, vị trí, nhập danh sách, khuôn mặt từ ảnh

Đã deploy: phiên bản `a29805fd-71a9-417d-b69d-0c75cb787ecc` (2026-10-26).

### Thêm
- **Chọn ca trước khi check-in:** Ca sáng 08:00–17:00 hoặc Ca tối 22:00–06:00 hôm sau. App gợi ý ca theo giờ hiện tại (04:00–13:59 ca sáng, 18:00–03:59 ca tối, giờ khác theo ca thường làm). Đang trong ca thì chỉ hiện ca đó và nút Check-out.
- **Ca qua nửa đêm:** công tính theo ngày bắt đầu ca. Ra lúc 06:00 sáng 27/10 thuộc Ca tối 26/10; đến ca tối sau nửa đêm vẫn tính ngày hôm trước. Lượt vào chưa ra quá 20 giờ coi như quên check-out. API mới `GET /api/status` trả ca đang mở.
- **Thông tin mỗi lượt chấm công** (ảnh trong group): ca, thời gian `dd/mm/yyyy hh:mm`, mã NV, họ tên, vị trí. Vị trí lấy từ GPS (link Google Maps, sai số); không có GPS thì dùng vị trí ước lượng theo mạng của Cloudflare và ghi rõ "không có GPS". Ảnh chụp cũng in ca và tọa độ.
- **Ca thường làm** cho từng nhân viên (quản trị đặt, mặc định Ca sáng) để bot nhắc đúng người. Lịch tự động mới: 07:00 tổng hợp ca tối hôm trước, 09:00 nhắc ca sáng, 18:30 tổng hợp ca sáng, 23:00 nhắc ca tối. `/homnay` hiện cả hai ca.
- **Nhập danh sách nhân viên:** dán từ Excel hoặc chọn file CSV (hiểu tiêu đề có dấu hoặc không dấu, tab, dấu phẩy, chấm phẩy). Xem trước từng dòng và báo dòng lỗi; tuỳ chọn cập nhật người đã có. Nhập xong hiện mã kích hoạt của từng người và tải về được. Có file mẫu. Cả danh sách chỉ tốn 1 lần ghi KV. API mới `POST /api/employees/import`.
- **Đăng ký khuôn mặt bằng ảnh tải lên:** ảnh được thu nhỏ còn tối đa 800px và đọc ngay trên máy, không gửi lên server. Từng ảnh được kiểm tra: đúng một người, mặt đủ lớn, đủ rõ, cùng người với ảnh đầu tiên.
- **Ảnh đại diện:** cắt quanh khuôn mặt 160×160, nén WebP (JPEG trên Safari) còn khoảng 2–8KB, tối đa 40KB; hiện trong danh sách nhân viên, bảng công và màn chấm công. API mới `GET /api/avatar`.
- Bảng công: hiện ca và vị trí từng lượt; giờ ra sau nửa đêm có dấu `+1`; "quên check-out" tính theo giờ kết thúc của từng ca. File Excel có thêm cột Ca, Vị trí vào, Vị trí ra; giờ vào/ra ghi đủ ngày giờ.
- Bộ test lên 145 test: ca qua nửa đêm, vị trí, metadata KV dưới 1024 byte, nhập danh sách, ảnh đại diện, nhắc theo ca, đọc CSV, kiểm tra ảnh tải lên, và test bảo đảm `app.js` đã nối đủ các phần.

### Thay đổi
- Mẫu khuôn mặt được làm tròn 4 chữ số thập phân, danh sách nhân viên trong KV nhỏ đi khoảng một nửa (độ lệch khuôn mặt đổi dưới 0.001).
- `WORK_START` thay bằng `LATE_GRACE_MIN = "30"` (đi muộn khi check-in sau giờ bắt đầu ca + 30 phút, giữ đúng quy tắc 08:30 cũ cho ca sáng).
- `wrangler.toml` có 4 lịch tự động (trước là 2). Service worker lên `v10`.

### Sửa lỗi
- Trạng thái ca đang mở không tính lượt chấm đúng cùng thời điểm hỏi (tìm ra khi viết test).

## 2026-10-26: Sửa lỗi theo mức độ, sắp xếp Bảng công

Đã deploy: phiên bản `37df71fd-f809-4a6f-b814-fa541d737b9f` (2026-10-26).

### Thêm
- **Sắp xếp trong Bảng công** (Hôm nay và Theo khoảng ngày), **mặc định Mã NV giảm dần**. Các lựa chọn khác: Mã NV tăng dần, Họ tên A→Z, Giờ vào sớm/muộn trước, Số giờ làm. Mã NV so theo số (NV10 sau NV9), tên theo thứ tự tiếng Việt. App nhớ lựa chọn cho lần mở sau. File Excel xếp theo cùng thứ tự. Logic nằm trong `public/sort.js`, test `test/sort.test.js`.
- **Kiểm tra người thật khi chấm công (M4):** nhận ra mặt xong, app yêu cầu quay nhẹ đầu một lần mới mở nút, để chặn ảnh in hoặc màn hình điện thoại giơ trước camera. Đã xác nhận thì giữ nguyên tới khi rời camera hoặc người khác bước vào. Tắt được bằng `CONFIG.LIVENESS` trong `public/face-logic.js`.
- Biến `HOLIDAYS` trong `wrangler.toml`: danh sách ngày lễ không nhắc, không tổng hợp.

### Sửa lỗi
- 🔴 **Chấm công lùi giờ (C2):** chỉnh giờ máy rồi tắt mạng để gửi lượt với giờ giả. Lượt chụp hơn 24 giờ trước giờ bị từ chối. Lượt gửi trễ được đánh dấu "gửi trễ, nhận lúc …" trong Bảng công, kèm cột "Gửi trễ" trong file Excel.
- 🟠 **Vượt giới hạn 1.000 lệnh liệt kê KV/ngày (M5):** bảng công và tin tổng hợp đọc qua Cache API (ngày hiện tại giữ 60 giây, xoá ngay khi có lượt chấm mới; ngày đã qua giữ 1 giờ). Bước kiểm tra thứ tự vào/ra vẫn luôn đọc dữ liệu mới. App chỉ tự làm mới khi đang mở trên màn hình, 5 phút một lần.
- 🟠 **Telegram giới hạn tốc độ (M6):** khi bị báo 429, server chờ đúng số giây yêu cầu rồi gửi lại (tối đa 2 lần) thay vì đẩy lượt vào hàng chờ.
- 🟢 **Rời camera mà nút vẫn mở thêm 1,5 giây (L5):** giờ mất mặt 2 khung hình liền là khoá.
- 🟢 **Bot nhắc check-in vào ngày lễ (L6).**
- **Biểu tượng người lệch xuống dưới trong ô ảnh đại diện:** class `empty` của ô ảnh đại diện trùng với khung "danh sách trống" (có khoảng đệm 28px). Đổi thành `blank`.
- Thanh điều hướng bị xuống dòng ở bề ngang 761–1100px.

### Thay đổi
- `npm test` chạy 108 test. Service worker lên `v9` (thêm `sort.js`).

## 2026-10-26: QA các tính năng còn lại

Đã deploy: phiên bản `37df71fd-f809-4a6f-b814-fa541d737b9f` (2026-10-26).

### Thêm
- Bộ test backend `test/api.test.js` (33 test): kích hoạt và phân quyền, chấm công, lịch sử, bot Telegram, lịch nhắc tự động. Chạy Worker thật trong Node với KV và Telegram giả lập. `npm test` giờ chạy 82 test.

### Sửa lỗi
- **Gửi lại cùng một lượt tạo hai ảnh trong group.** Khi mạng chập chờn, app gửi lại lượt mà server đã nhận nhưng server không nhận ra là trùng. Giờ trả OK và không gửi ảnh lần hai.
- **Hàng đợi offline ghi công nhầm người.** Lượt chờ gửi của người đã đăng xuất được gửi bằng mã của người đang đăng nhập, nên bị ghi cho người đó. Giờ mỗi lượt mang mã của chính người chấm. Mã đã bị đổi thì lượt bị bỏ kèm thông báo, không kẹt trong hàng đợi và không làm đăng xuất người đang dùng máy.
- **"Gửi tổng hợp ngay" giữa ngày ghi người đang làm là "quên check-out".** Giờ dùng mẫu "Đang làm việc".
- **Không chạy được nhận diện khi mất mạng.** `face-api.js` tải ở chế độ không CORS nên service worker không lưu được. Giờ tải có CORS, và thư viện cùng mô hình được lưu sẵn ngay khi cài app.
- **Tìm nhân viên phải gõ có dấu.** Giờ "bich" tìm ra "Bích", "duc" tìm ra "Đức".
- **Quản trị viên mở link `#report` hoặc `#admin` lần đầu bị đưa về Chấm công.**
- **Server nhận dữ liệu khuôn mặt sai dạng.** Có thể làm hỏng nhận diện trên máy nhân viên; giờ bị từ chối (400).
- **File Excel có thể bị chèn công thức qua tên nhân viên** (ví dụ `=HYPERLINK(...)`). Giờ ô bắt đầu bằng `= + - @` được thêm dấu `'`.

### Thay đổi
- Service worker lên `v7`.

## 2026-10-26: QA với camera thật trên Brave

Đã deploy: phiên bản `2a4bc745-e52c-43f0-a0a2-8dd1e1b95f7c` (2026-10-26).

### Sửa lỗi
- Đăng ký: bước "ngẩng lên" gần như không thể qua. Cách đo cũ (mũi–mắt chia mắt–cằm) gần như không đổi khi ngẩng; giờ chia cho khoảng cách hai mắt, mức yêu cầu 0.04.
- Đăng ký: quay về một phía khó đạt yêu cầu khi camera đặt lệch. Góc quay và góc cúi giờ tính so với lúc nhìn thẳng, mức quay tối thiểu 0.08.
- Đăng ký: lời nhắc "Quay sang phía ngược lại với lúc nãy" khó hiểu. Giờ nhắc theo tư thế lúc đó ("Bạn đang quay cùng phía với lúc nãy. Hãy quay sang phải", "Quay thêm một chút", "Bạn đang ngẩng lên. Hãy cúi xuống"…).
- Đăng ký: một khung hình nhiễu làm hỏng mẫu nhìn thẳng và khiến app tự chụp lại từ đầu. Mẫu nhìn thẳng giờ là trung bình các khung hình giữ yên; phải 3 lần liền không khớp mới chụp lại, và không lưu mẫu nào lúc không khớp.
- Chữ viết tắt ảnh đại diện ra "B(" với tên có dấu ngoặc.

### Thay đổi
- Dòng số đo khi đăng ký hiện góc quay và góc cúi so với lúc nhìn thẳng.
- Bộ test lên 49 test. Service worker lên `v6`.

## 2026-10-26: QA bằng mô hình face-api thật

Đã deploy: phiên bản `2a4bc745-e52c-43f0-a0a2-8dd1e1b95f7c` (2026-10-26).

### Sửa lỗi
- Đăng ký: khi quay nghiêng, bộ phát hiện mặt chấm thấp hơn 0.7 nên app không chụp và báo nhầm "Giữ yên, đủ ánh sáng". Giờ bước quay/cúi chấp nhận từ 0.5 (ảnh nhìn thẳng vẫn cần 0.7), lời nhắc đổi thành "Quay ít lại một chút, giữ mặt rõ trong khung". Có test riêng.

### Thêm
- `QA-NHAN-DIEN.md` mục 2: kết quả QA với ảnh khuôn mặt thật chạy qua mô hình face-api và app thật. Người lạ bị chặn 0/217; chính chủ có thể bị từ chối ở ngưỡng 0.42 khi điều kiện khác lúc đăng ký.

## 2026-10-26: Báo rõ lý do không mở được camera

Đã deploy: phiên bản `2a4bc745-e52c-43f0-a0a2-8dd1e1b95f7c` (2026-10-26).

### Thay đổi
- Màn "Không mở được camera" giờ ghi đúng nguyên nhân và cách sửa, kèm mã lỗi gốc của trình duyệt và trạng thái quyền của trang. Có tách riêng trường hợp trang đã được cho phép nhưng macOS hoặc hệ điều hành chặn camera của trình duyệt.
- Camera không nhận yêu cầu độ phân giải thì tự thử lại với yêu cầu tối thiểu.

## 2026-10-26: QA nhận diện khuôn mặt

Đã deploy: phiên bản `2a4bc745-e52c-43f0-a0a2-8dd1e1b95f7c` (2026-10-26).

### Thêm
- Bộ test tự động `test/face-logic.test.js` (39 test, chạy bằng `npm test`). Mỗi lỗi đã gặp có test riêng, tên bắt đầu bằng "Lỗi đã gặp".
- `npm run deploy` chạy test trước; test hỏng thì không deploy.
- `QA-NHAN-DIEN.md`: danh sách lỗi và test tương ứng, kết quả kiểm chứng bộ test, checklist test tay với camera thật, cách chỉnh ngưỡng từ số đo thực tế.

### Thay đổi
- Tách logic xác minh và đăng ký góc mặt sang `public/face-logic.js`. App và bộ test dùng chung file này, nên test kiểm tra đúng code đang chạy.
- Service worker lên `v5` (thêm `face-logic.js` vào bộ nhớ offline).

### Sửa lỗi
- Sau khi chính chủ đã được xác nhận, người khác bước vào vẫn bấm chấm công được trong khoảng 0,2 giây (1 khung hình). Giờ chỉ cần một khung hình không khớp là khoá nút ngay.

## 2026-10-26: Sửa lỗi nhận nhầm khuôn mặt

Đã deploy: phiên bản `2a4bc745-e52c-43f0-a0a2-8dd1e1b95f7c` (2026-10-26).

### Sửa lỗi
- **Người khác vẫn được xác nhận là chủ tài khoản.**
  - Nguyên nhân: ngưỡng 0.5 quá dễ (mô hình face-api kém phân biệt khuôn mặt châu Á); chỉ cần 2 khung hình; FaceMatcher lấy trung bình mọi góc chụp.
  - Cách sửa:
    - Ngưỡng mới 0.42. Độ lệch tính bằng trung bình 2 mẫu gần nhất.
    - Cần 4 trong 5 khung hình gần nhất khớp mới xác nhận. Huỷ xác nhận ngay khi 2 khung hình liền nhau không khớp.
    - Chỉ xét khi nhìn gần thẳng. Bấm chấm công phải có lần xác minh trong 1,5 giây trước đó.
- **Khi đăng ký, chưa quay hay cúi mặt đã được tính là xong.**
  - Nguyên nhân: app hiện hướng dẫn nhưng cứ 0,9 giây là tự chụp, không kiểm tra góc mặt.
  - Cách sửa: đo góc quay và góc cúi thật từ 68 điểm mốc trên mặt. Chỉ chụp khi giữ đúng góc 2 khung hình liền nhau. Bước quay hoặc cúi thứ hai phải ngược chiều bước trước.
- **Khi đăng ký, các mẫu có thể lẫn khuôn mặt nhiều người.**
  - Cách sửa: mỗi mẫu phải cùng người với mẫu đầu tiên, nếu không thì chụp lại từ đầu. Không chụp khi có hơn một người trong khung hình.

### Thêm
- Quản trị viên thấy độ lệch khuôn mặt và góc mặt thực tế ở góc camera, để chỉnh `MATCH_THRESHOLD` trong `public/app.js` theo khuôn mặt thật.

### Thay đổi
- Bộ phát hiện khuôn mặt dùng ảnh đầu vào 416px (trước là 320px) để rõ hơn.
- Bỏ hiển thị "khớp %" vì con số này dễ gây hiểu nhầm.
- Service worker lên `v4`.

### Cần làm sau khi deploy
- Đăng ký lại khuôn mặt cho mọi người. Các mẫu cũ được chụp khi chưa kiểm tra góc mặt nên kém chính xác.

## 2026-10-26: Phân quyền và mã kích hoạt riêng

Đã deploy: phiên bản `bde366fb-1019-4c13-84ed-1fd934bff4ee` tại https://timesheet.duc040301.workers.dev

### Thêm
- Phân quyền theo `role`: `1` = quản trị, `2` = nhân viên.
  - Quản trị: chấm công, Bảng công, Quản trị.
  - Nhân viên: chỉ chấm công cho chính mình. Menu Bảng công và Quản trị bị ẩn, server cũng từ chối.
- Mã kích hoạt riêng cho từng người, dạng `K7PM-3QXD`.
  - Quản trị viên thêm nhân viên thì app tự sinh mã và hiện một lần.
  - Server chỉ lưu hash của mã.
  - **Sửa → Tạo mã kích hoạt mới** để đổi mã; mã cũ hết hiệu lực ngay.
- Màn **Kích hoạt Timesheet** khi mở app lần đầu, thay cho nhập mã thiết bị.
- Nút đăng xuất khỏi máy và tên người đang dùng ở góc trên bên phải.
- Chọn quyền khi tạo hoặc sửa nhân viên.
- API mới: `GET /api/me`, `POST /api/employees/code`.
- `TOI-UU-CHI-PHI.md`: ghi chú các điểm có thể vượt giới hạn miễn phí và cách sửa (chưa làm).

### Thay đổi
- Mỗi máy chỉ xác minh khuôn mặt của người đã kích hoạt; server luôn ghi lượt chấm công cho chính chủ mã.
- Nhân viên chỉ xem được lượt chấm công của mình. Xem ảnh chấm công chỉ dành cho quản trị.
- `ADMIN_KEY` thành tài khoản quản trị gốc: dùng để tạo người đầu tiên và không chấm công.
- Quản trị viên không thể tự hạ quyền, tự xoá hay tự đổi mã của chính mình.

### Bỏ
- `DEVICE_KEY` (mã thiết bị dùng chung). Secret này vẫn còn trên Cloudflare nhưng không còn dùng.
- Phần thống kê (đang làm / đã ra / chưa vào) và danh sách lượt gần đây ở màn chấm công.
- Màn khoá quản trị bằng `ADMIN_KEY`.

### Sửa lỗi
- Khi đăng xuất rồi đăng nhập người khác, trạng thái "đã xác minh khuôn mặt" của người trước vẫn còn giữ.

### Cần làm sau khi deploy
- Nhân viên cũ chưa có mã kích hoạt. Quản trị viên vào **Sửa → Tạo mã kích hoạt** cho từng người.

## 2026-10-23: Giao diện mới

### Thay đổi
- Làm lại toàn bộ giao diện theo chủ đề máy chấm công và sổ công.
  - Một nút chấm công thông minh, tự đổi Check-in hoặc Check-out.
  - Con dấu thời gian khi chấm xong, kèm âm báo và rung.
  - Khung oval hướng dẫn vị trí khuôn mặt.
- Bảng công: chọn nhanh khoảng ngày, câu tổng kết, ảnh thu nhỏ của từng lượt.
- Đăng ký khuôn mặt tự chụp 5 góc theo hướng dẫn và cảnh báo khi trùng khuôn mặt với người khác.
- Giao diện điện thoại có thanh điều hướng ở đáy.

## 2026-10-23: Nhận diện khuôn mặt, Telegram, PWA

### Thêm
- Nhận diện khuôn mặt ngay trên trình duyệt (face-api.js).
- Backend Cloudflare Worker (gói miễn phí): gửi ảnh chấm công vào group Telegram, lưu chỉ mục trong KV.
- Bot Telegram: lệnh `/homnay`, `/chatid`; tự nhắc check-in lúc 09:00, tổng hợp và cảnh báo quên check-out lúc 18:30.
- Hàng đợi offline: mất mạng thì giữ ảnh trên máy và tự gửi lại, vẫn đúng giờ chụp.
- PWA: cài được lên màn hình chính.

## 2026-10-23: Bản đầu tiên

### Thêm
- Một file HTML chạy trên trình duyệt: chụp ảnh check-in/out kèm ngày giờ, lưu trên máy, xuất CSV.
