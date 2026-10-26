# Nhật ký thay đổi

Mỗi lần thay đổi đều ghi vào đây, mới nhất ở trên. Ghi kèm phiên bản Cloudflare nếu đã deploy.

## 2026-10-27: Màn Chấm công: camera tràn màn, tự check-in, bớt phần thừa, blueprint Trước/Sau

Chưa deploy. Làm trên nhánh `feature/dang-nhap-theo-may`, sau commit `20fde5c`.

### Sửa lỗi
- **Kéo thông báo thì nó đi theo tay tới tận thanh trên.** Bản đầu cho thẻ đi theo tay mọi hướng, không giới hạn. Giờ hướng không dùng để tắt bị cản như Sonner (xem mục Thông báo bên dưới). Có test "Lỗi đã gặp".
- **Màn điện thoại thấp phải cuộn mới tới nút chấm công, mà cuộn thì camera trôi khỏi màn: không thấy khuôn mặt đã xác minh chưa.**
  - Nguyên nhân: camera cao cố định 48% màn hình, dưới nó là khối tên, ô chọn ca, nút, dòng vị trí và đồng hồ. Ở 375×667 trang dài 812px; nút dính đáy (`position:sticky`) nên đè lên nhãn "2. Check-in".
  - Cách sửa: **camera tràn kín cửa sổ** như app camera, trên mọi cỡ màn (điện thoại, máy tính bảng, máy tính), và màn không bao giờ cuộn. Thanh trên (ảnh, tên, đăng xuất), ô chọn ca, nút chấm công và cảnh báo vị trí nổi trên video; cụm nút ở đáy có lớp nền tối mờ cho dễ đọc. Màn rộng thì cụm nút ở giữa, rộng tối đa 560px. Thanh điều hướng của quản trị cũng nằm trên video.
  - Oval canh giữa phần video còn thấy được, giữa dòng trạng thái và cụm nút. Cụm nút cao lên (ví dụ khi hiện cảnh báo vị trí) thì oval tự nhỏ lại: app đo chiều cao cụm nút bằng `ResizeObserver` và báo cho CSS qua `--dock`.
  - Oval giữ cỡ cũ theo loại màn: máy tính rộng tối đa 36% khung (ngồi trước webcam), điện thoại 50% (cầm gần).
  - Đã đo: 1920×1000, 1440×900, 768×1024, 390×844, 375×667 và 360×520 không cuộn; nút nằm trọn trong màn; oval không bị dòng trạng thái hay cụm nút che, kể cả khi có cảnh báo vị trí (ở 360×520 lúc đó oval rộng 98px).
  - Đổi test "Lỗi đã gặp" về lỗi này sang kiểm tra cách sửa mới: màn cao `100svh` và không cuộn, camera phủ kín màn, cụm nút ghim ở đáy màn hình, camera không đặt cứng chiều cao. Test cũ kiểm tra nút `position:sticky`, mà chính cách đó vẫn phải cuộn trên màn thấp.
- **Bản gộp làm ô "Ca sáng / Mở lúc 06:00" bị xuống dòng trên điện thoại** (ô chọn ca gọn một hàng không đủ chỗ cho chữ "Mở lúc"). Ô khoá giờ ghi gọn "Mở 06:00", "Đã chấm"; đã đo ở 360px không tràn.

- **Bấm Esc hai lần thì hộp thoại "Kích hoạt Timesheet" đóng hẳn, không còn chỗ nào để nhập mã** (trên web). App chặn Esc ở sự kiện `cancel`, nhưng Chrome/Brave chỉ cho chặn một lần; lần thứ hai hộp thoại vẫn đóng. Giờ hộp thoại đóng khi máy chưa kích hoạt thì mở lại ngay. Đã thử: Esc ba lần liên tiếp vẫn còn hộp thoại, con trỏ ở ô nhập mã. Có test "Lỗi đã gặp".
- **Nút "Kích hoạt" bấm được khi chưa nhập mã; nhập sai mã thì ô nhập bị xoá trắng.** Giờ ô trống thì nút khoá; nhập sai thì giữ nguyên mã và bôi đen sẵn để sửa. Có test "Lỗi đã gặp".
- **Khó nhập mã kích hoạt trên iPhone.** Mấy nguyên nhân cộng lại:
  - Bàn phím iOS bật lên che nửa dưới hộp thoại (ô nhập và nút Kích hoạt) mà trang không cuộn được, vì màn chấm công khoá cuộn. Giờ trên điện thoại hộp thoại neo lên trên và không cao quá phần màn còn thấy (app đo bằng `visualViewport`, báo cho CSS qua `--vvh`); phần dư cuộn được trong hộp thoại.
  - iOS có thể tự sửa mã (autocorrect) hoặc chèn dấu cách khi chạm gợi ý: tắt `autocorrect`.
  - Phải đổi sang bàn phím số mới gõ được dấu gạch, trong khi server đã tự bỏ dấu gạch và tự viết hoa. Mã mẫu trong ô đổi thành "VD: K7PM3QXD" (không dấu gạch).
  - Phím Return ghi "Đi" (`enterkeyhint="go"`) để gửi luôn, không phải tìm nút Kích hoạt.
  - Đã thử ở khung 375×360 (giống lúc bàn phím bật): ô nhập không bị che, hộp thoại cuộn tới nút Kích hoạt được. Chưa thử trên iPhone thật. Có test "Lỗi đã gặp".
- **Công tắc "Máy mượn" bật lên thì trắng tinh ở chế độ tối**: nền công tắc dùng màu mực, ở chế độ tối là gần trắng, trùng nút gạt trắng. Giờ bật là nền xanh (màu "đang vào ca" của app) cả ở chế độ sáng lẫn tối. Có test "Lỗi đã gặp".
- **Màn "Không mở được camera" lộn xộn trên điện thoại.** Nội dung đè lên oval nét đứt phía sau; nút "Mở lại camera" chữ trắng trên nền sáng gần như không đọc được và bị ô chọn ca che một phần; mã lỗi kỹ thuật nằm ngay trong câu hướng dẫn; biểu tượng camera không hiện.
  - Giờ là một thẻ gọn canh giữa phần màn giữa thanh trên và cụm nút: hình báo lỗi, tiêu đề, một câu hướng dẫn, nút "Mở lại camera" nền trắng chữ tối. Mã lỗi gốc tách thành một dòng nhỏ mờ bên dưới để báo lại cho quản trị viên. Lúc đang báo lỗi hay đang tải thì ẩn oval và dòng trạng thái.
  - Hình báo lỗi thay cho biểu tượng camera gạch chéo: khung quét mặt của logo, khuôn mặt mờ bên trong, khung thở nhẹ (tắt khi máy bật giảm chuyển động). Huy hiệu ở góc cho biết nguyên nhân: ổ khoá (bị chặn quyền, trang không chạy https), máy quay có gạch chéo (không tìm thấy camera; không dùng dấu hỏi vì dễ bị tưởng là ảnh không tải được), đồng hồ (app khác đang dùng camera), dấu chấm than (lỗi khác, kể cả không tải được bộ nhận diện).
  - Trình duyệt chặn camera: hướng dẫn bật lại theo từng loại máy (iPhone: Cài đặt → Safari → Camera; Android: biểu tượng đầu thanh địa chỉ → Quyền → Camera; máy tính: biểu tượng ổ khoá ở thanh địa chỉ).
- **Dòng trạng thái ("Đã xác minh", "Khuôn mặt không khớp"…) lơ lửng cách xa oval.** Dòng này ghim ở đỉnh màn, còn oval canh giữa phần video, nên giữa hai thứ có khoảng trống lớn. Giờ dòng trạng thái gắn ngay trên đỉnh oval (cách 11px) và đi theo oval khi oval đổi cỡ.
- **Chấm trạng thái mạng ở góc ảnh đại diện bị cắt mất một phần**: luật cắt tên dài thành "…" trúng cả khung bọc ảnh. Giờ luật đó chỉ áp cho tên.

### Thêm
- **Tự check-in sau khi xác minh khuôn mặt.** Xác minh xong (cả bước quay nhẹ đầu), một vòng sáng chạy quanh oval trong 3 giây rồi tự ghi lượt check-in; dòng dưới nút ghi "Tự ghi sau 3 giây". Cạnh nút có nút **Huỷ**; bấm nút chấm công (hoặc phím Space) thì ghi ngay.
  - Chỉ tự check-in, không bao giờ tự check-out: mở app giữa ca để xem giờ không được ghi ra ca.
  - Mỗi lần xác minh chỉ tự chấm một lần: đã Huỷ, đã bấm tay, hoặc lần tự chấm bị từ chối thì không tự thử lại. Mất mặt khỏi khung (hoặc người khác vào) thì dừng đếm ngay; lần xác minh sau được tự chấm lại.
  - Không tự chấm khi đang mở hộp thoại, đang đăng ký khuôn mặt hay app chạy nền; đổi ca trong lúc đếm thì đếm lại từ đầu.
  - Vẫn qua đúng hàm chấm công cũ, nên vẫn kiểm tra xác minh còn mới, khung giờ ca, chặn bấm lặp.
  - Luật nằm trong `public/autopunch.js`, có test (`test/autopunch.test.js`). Đã thử trên trình duyệt (thay hàm gửi bằng hàm giả): đếm, Huỷ, tự chấm đúng một lần, mất mặt rồi xác minh lại thì đếm lại.

### Thêm
- **Đo Core Web Vitals của người dùng thật** (`public/vitals.js`, thư viện `web-vitals` 6.2.3 của Google bản attribution, tự host ở `public/vendor/` kèm giấy phép Apache-2.0):
  - Đo TTFB, FCP, LCP, CLS, INP kèm nguyên nhân: phần tử LCP và các giai đoạn (chờ server, chờ tải, chờ vẽ); phần tử gây dịch chuyển lớn nhất; ba phần của INP (input delay, processing, presentation delay) và đoạn script chạy lâu nhất.
  - Gửi một gói lúc rời trang bằng `fetchLater()` (Chrome 135+; trình duyệt khác dùng bản thay thế: `fetch` keepalive / `sendBeacon` khi trang bị ẩn).
  - Server: `POST /api/vitals` không cần đăng nhập (gói gửi lúc rời trang không ký được), giới hạn 4KB, chỉ giữ đúng các trường đã biết, ghi một dòng log `web-vitals` để xem ở Workers → Observability. Không ghi KV nên không tốn hạn mức ghi. Có test (`test/api.test.js`).
  - Đã thử trên trình duyệt: rời trang thì server nhận đủ TTFB, FCP, LCP, CLS, INP.

### Thay đổi
- **Tải trang nhanh hơn** (theo hướng dẫn hiệu năng của web.dev):
  - Font Google không còn chặn hiển thị: nạp bằng `preload` rồi đổi sang stylesheet khi tải xong (có `<noscript>` dự phòng). Trước đây trình duyệt phải chờ tải xong CSS từ `fonts.googleapis.com` mới vẽ được gì. Bỏ weight 600 của Big Shoulders Display (không dùng).
  - Bộ nhận diện `face-api.js` (~1,3MB) không còn chặn mã của app: tải trước bằng `<link rel="preload" as="script">` rồi app tự nạp sau khi đã dựng giao diện. Trước đây hộp kích hoạt và các nút chưa phản hồi cho tới khi trình duyệt chạy xong file này. Mô hình (~4,3MB) vì thế cũng bắt đầu tải sau giao diện, bớt tranh băng thông với font.
- **Giữ dịch chuyển bố cục (CLS) lúc mở app ở ~0,04** (đo trên khung 375×667, máy chặn quyền vị trí; ngưỡng tốt là 0,1). Trang vẽ lần đầu sớm hơn (font không chặn) làm các lần xô lệch vốn có trước lần vẽ đầu bị tính vào CLS (lên ~0,15); đã gỡ các nguồn đó nên CLS về lại ngang trước khi sửa:
  - Thanh trên không còn xô lệch khi app chạy: đoạn script nhỏ ngay sau thanh trên dựng sẵn ảnh, tên, ẩn chữ Timesheet từ lần dùng trước (`ts.who` trong bộ nhớ máy), trước lần vẽ đầu.
  - Cảnh báo vị trí nổi ngay trên cụm nút thay vì nằm trong cụm, nên hiện ra không đẩy chọn ca và nút lên.
  - Thẻ báo trên khung camera ("Đang tải…", "Không mở được camera") có bề ngang cố định và neo theo mép trên; vòng xoay và hình báo lỗi cùng một ô 96px, nên đổi trạng thái không làm thẻ co giãn.
  - Còn lại: ô chọn ca hiện ra lúc app chạy làm vùng nền của cụm nút cao lên (~0,026; nút không dời chỗ), và chữ trong thẻ báo đổi độ dài (~0,01).
- Số đo trên máy chạy thử (server trên máy, font và thư viện đã có trong cache, CPU Mac) không thấy khác biệt: trước FCP 64ms / LCP 84ms, sau FCP 44–60ms / LCP 84–108ms. Lợi ích của hai thay đổi trên chỉ hiện ra khi mạng chậm và máy yếu; số thật lấy từ log `web-vitals` sau khi deploy.
- **Lighthouse, chế độ điện thoại** (4G chậm: độ trễ 150ms, 1,6Mbps; CPU chậm 4 lần; 5 lần mỗi bản, lấy trung vị; Lighthouse 12.8.2 trên Brave headless; trang tĩnh không có server, máy mới nên hiện hộp kích hoạt, không có camera):

  | | Trước | Sau |
  |---|---|---|
  | Điểm hiệu năng | 78 (dao động 43–98) | 98 (98–100) |
  | FCP | 1,74s | 1,06s |
  | LCP | 5,55s (dao động 1,7–26s) | 2,28s (1,5–2,3s) |
  | Speed Index | 1,83s | 1,13s |
  | TBT | 67ms | 69ms |
  | CLS | 0,070 | 0,027 |

  Bản trước có lần LCP lên 5,5s và 26s vì thư viện nhận diện (~1,3MB) tải đồng bộ chặn cả trang; bản sau không còn tài nguyên chặn hiển thị nên ổn định. Phần tử LCP của bản sau là dòng chữ báo lỗi camera, xuất hiện khi app chạy xong; ngoài đời có camera thì phần tử LCP khác. TBT không đổi vì việc nặng (nhận diện) chạy sau khi tải trang.
- **Hộp xác nhận của app thay cho `confirm()` của trình duyệt** (trước đây hiện "localhost cho biết…", nút OK/Cancel tiếng Anh, không sửa giao diện được). Dùng cho đăng xuất, xoá nhân viên, tạo mã kích hoạt mới, đăng xuất mọi máy, và lưu khi khuôn mặt giống người khác.
  - Máy tính: hộp giữa màn. Điện thoại: trượt lên từ đáy màn, nút to xếp chồng, nút huỷ ở dưới cùng như iOS.
  - Nút an toàn ("Ở lại", "Huỷ") được chọn sẵn; nút xoá / đăng xuất màu đỏ; bấm ra ngoài hoặc Esc là huỷ.
  - Hộp đăng xuất có thẻ tài khoản (ảnh, tên, mã NV), và báo nếu còn lượt chấm công chưa gửi ("App vẫn tự gửi sau khi đăng xuất").
- **Thông báo (toast) làm lại theo kiểu Sonner** (`public/toast.js`, có test `test/toast.test.js`):
  - Thẻ nền sáng, bo góc, viền mảnh, bóng nhẹ; biểu tượng theo loại ở bên trái: dấu tích xanh (xong), dấu × đỏ (lỗi), tam giác vàng (cảnh báo), chữ i (thông tin). Trước đây là hộp tối có viền màu bên trái.
  - Xếp chồng: thông báo mới nằm trước, 2 cái cũ ló mép phía sau và nhỏ dần; rê chuột (máy tính) hoặc chạm (điện thoại) thì xoè ra đọc đủ.
  - Tự tắt sau 4 giây (hoặc thời gian riêng của từng thông báo); đang xoè hoặc app chạy nền thì dừng đếm.
  - Trượt vào từ mép màn, mờ dần khi tắt. Máy tính có nút × nhỏ ở góc khi rê chuột.
  - Vuốt để tắt theo đúng cách của Sonner 2.0.7 (đọc từ mã nguồn): khoá trục theo chiều kéo đầu tiên; hướng được phép tắt (góc dưới phải: xuống hoặc sang phải; giữa phía trên: lên) thì thẻ đi theo tay; hướng khác bị cản, đi tối đa ~20px rồi bật về. Tắt khi kéo từ 45px hoặc hất nhanh hơn 0,11 px/ms; lúc tắt thẻ trượt tiếp một thân theo hướng vuốt rồi mờ đi (200ms). Bấm nút hay đang bôi đen chữ thì không vuốt.
  - Vị trí: máy tính góc dưới bên phải, điện thoại giữa phía trên (dưới tai thỏ). Trước đây ở giữa đáy màn trên mọi cỡ.
  - Thông báo lỗi đọc ngay cho trình đọc màn hình (`role="alert"`), loại khác đọc khi rảnh (`role="status"`).
- **Hộp thoại kích hoạt.** Ô nhập mã có nút × xoá nhanh (hiện khi ô có chữ). Lựa chọn "Máy mượn" đổi từ ô đánh dấu trần thành một hàng có tiêu đề, mô tả ("Tự đăng xuất ngay sau khi chấm công xong") và công tắc gạt; bấm cả hàng được, bật thì hàng có viền xanh.
- **Màu focus** của ô nhập và vòng focus bàn phím đổi từ tím (`#4a3db0`, không có ở chỗ nào khác trong app) sang màu mực của nút chính, áp cho toàn app.
- **Chọn ca gọn.** Bỏ nhãn "1. Chọn ca / 2. Check-in"; mỗi ô một dòng (tên ca bên trái, giờ hoặc giờ mở bên phải), cao 50px thay vì 74px. Phần chọn ca từ 136px còn 50px. Không có ca nào để check-in thì nút khoá và ghi lý do cùng giờ mở ("Chưa tới giờ check-in. Ca sáng mở lúc 06:00, Ca tối mở lúc 20:00", hoặc "Đã chấm ca sáng hôm nay. …").
  - Test "Lỗi đã gặp: đang tối vẫn chọn được ca sáng" tìm chữ "Mở lúc" trên ô ca. Đổi sang kiểm tra: ô ca ngoài khung giờ bị khoá và ghi giờ mở (`Mở ${opensAt(k)}`), app chỉ tự chọn ca đang mở, không có ca đang mở thì không check-in được.
- **Giờ trên nút chấm công.** Dòng dưới nút luôn bắt đầu bằng giờ hiện tại, cũng là giờ sẽ ghi vào lượt chấm ("07:52 · Ca sáng 08:00–17:00"), cập nhật mỗi khi đổi phút. Bỏ đồng hồ lớn (trước đây ở điện thoại bị cắt ở đáy màn hình).
- **Một chỗ báo trạng thái khuôn mặt.** Trước đây cùng một ý hiện ba lần: trên camera, dưới tên và dưới nút. Giờ chỉ khung camera báo trạng thái khuôn mặt; nút luôn ghi giờ và ca, chỉ mờ đi khi chưa xác minh. Dòng dưới nút chỉ đổi khi camera không nói được lý do: chưa kích hoạt, tài khoản quản trị gốc, chưa đăng ký khuôn mặt.
- **Tên lên thanh trên, chấm mạng ở góc ảnh.** Trước đây tên hiện hai lần: trên camera ("Đã xác minh Trần Thị Bình") và ở khối tên dưới camera. Giờ bỏ khối tên, và dòng trên camera chỉ ghi "Đã xác minh". Ảnh đại diện và tên nằm trên thanh trên (máy đăng nhập theo người, nên tên hiện cả lúc chưa xác minh); điện thoại của nhân viên bỏ chữ "Timesheet" cạnh biểu tượng để đủ chỗ. Chấm trạng thái mạng gộp thành huy hiệu ở góc ảnh đại diện: xanh khi trực tuyến, đỏ khi mất mạng. Di chuột vào tên thấy mã NV và trạng thái mạng. Tài khoản quản trị gốc (không có ảnh) vẫn có chấm mạng riêng.
- **Vị trí chỉ hiện khi có vấn đề.** Dòng "Đã xác định vị trí, sai số khoảng 12 m" và "Đang lấy vị trí…" không còn hiện; chỉ hiện cảnh báo khi bị chặn quyền hoặc không lấy được GPS.
- Nhân viên (không phải quản trị) không còn thanh điều hướng một mục "Chấm công" trên máy tính; điện thoại đã bỏ từ trước.
- Đang trong ca thì bỏ dòng "Đang trong Ca sáng …, vào lúc …" vì nút đã ghi ca và giờ vào. Sau khi check-out vẫn có dòng chọn "Vào ca khác".
- Service worker giữ `v16` (bản `v16` của nhánh chưa deploy), thêm `autopunch.js`, `toast.js`, `vitals.js` và `vendor/web-vitals.attribution.js` vào danh sách lưu offline.
- `.claude/launch.json`: server chạy thử `timesheet-qa` dùng thư mục dữ liệu riêng (`.wrangler/state-qa`). Chạy cùng lúc với `npm run dev` thì hai server dùng chung `.wrangler/state` và dừng vì lỗi khoá SQLite mỗi lần tự tải lại.
- `design/blueprint-cham-cong/`: hoạt hình blueprint Trước/Sau của màn Chấm công trên điện thoại 375×667 (giao diện sáng), 6 bước theo các thay đổi trên, dài 60 giây, chạy lặp. Không deploy (nằm ngoài `public/`).
  - Giao diện thật là `stage-0.html` (Trước, commit `20fde5c`) đến `stage-6.html` (Sau, đang đếm tự check-in), dựng từ đúng HTML/CSS của app bằng `make-snapshot.mjs`. Các khung blueprint đo thẳng từ DOM của từng màn lúc mở trang. Sửa giao diện app thì chạy lại script.
  - `animations-v3.jsx` là bộ chạy thay cho starter của Claude Design; có nút nhảy tới từng cảnh, nút "Trước" và "Sau" để xem nhanh hai màn.
  - Mở: chạy cấu hình `blueprint` trong `.claude/launch.json` rồi vào `http://localhost:8790/`. `?t=12.5` mở ở giây 12.5.

## 2026-10-26: Bổ sung CLAUDE.md

Chưa deploy (chỉ đổi tài liệu).

### Thay đổi
- `CLAUDE.md`: thêm lệnh hay dùng (chạy một file test, lọc test theo tên, mô phỏng tải), kiến trúc Worker và các khoá KV, ràng buộc hạn mức gói miễn phí, quy tắc tăng `VERSION` service worker và giữ `SHIFTS` giống nhau ở hai nơi.

## 2026-10-26: Oval cỡ vừa phải, lời nhắc lại gần / lùi xa, khung giờ mở ca

Chưa deploy.

### Sửa lỗi
- **Oval to hơn hẳn khuôn mặt trên máy tính** (bản `258135c6`).
  - Nguyên nhân: cỡ oval đặt theo ước đoán (rộng 59% khung trên điện thoại, 49% trên máy tính), không theo cỡ mặt thật. Ngồi trước webcam, mặt chỉ chiếm khoảng 30–35% bề ngang khung.
  - Cách sửa: oval đứng yên giữa khung làm khung hướng dẫn, người dùng đưa mặt vào. Máy tính: rộng 36% khung. Điện thoại: rộng 50% khung (cầm máy nên mặt gần camera hơn). Tỉ lệ 3:4.
  - Thêm lời nhắc trên khung camera, tính từ khung mặt bộ nhận diện đo được (có tính phần video bị cắt và hình lật như gương): **"Lại gần camera hơn"** khi mặt nhỏ hơn 75% oval, **"Lùi ra xa một chút"** khi to hơn 125%, **"Đưa mặt vào giữa khung"** khi lệch quá 1/4 oval. Đã xác minh xong hoặc đang đăng ký khuôn mặt thì không nhắc.
  - Cách tính nằm trong `public/guide.js`, có test (`test/guide.test.js`).
  - Sửa test "Lỗi đã gặp" về oval: test cũ bắt oval rộng ít nhất 55% khung, dựa trên ước đoán sai. Test mới kiểm tra oval co theo khung camera, máy tính 32–42%, điện thoại 45–56%, và oval không chạy theo mặt.

- **Đang tối vẫn chọn và check-in được ca sáng.**
  - Nguyên nhân: hai ca luôn chọn được bất kể giờ; app chỉ chọn sẵn ca theo giờ, server không kiểm tra giờ.
  - Cách sửa: mỗi ca chỉ mở check-in từ **2 giờ trước giờ vào tới hết ca**: ca sáng 06:00–17:00, ca tối 20:00–06:00 hôm sau. Ngoài khung, ô ca mờ đi kèm chữ "Mở lúc 06:00"; app tự chọn ca đang mở và tự mở khoá khi tới giờ. Từ 17:00 đến 20:00 chưa ca nào mở: nút chấm công ghi rõ giờ mở của từng ca. Server cũng từ chối check-in ngoài khung ("Ca sáng chỉ check-in từ 06:00 đến 17:00."), kể cả lượt gửi trễ (tính theo giờ chụp). Check-out không bị giới hạn (tăng ca).
  - Test "ca sáng 00:01 thuộc ngày mới" đổi thành 06:00 vì 00:01 giờ đã ngoài khung ca sáng.
- **Chuyển qua lại giữa các tab thì Bảng công tải lại cùng dữ liệu.**
  - "Hôm nay": mỗi lần quay về Bảng công đều gọi `/api/logs` lại. Giờ dữ liệu tải trong 60 giây thì dùng lại; sau khi tự chấm công, gửi được lượt chờ hoặc bấm "Thử lại" thì vẫn tải mới ngay.
  - "Theo khoảng ngày": app chỉ nhớ khoảng vừa xem, chọn khoảng khác rồi quay lại khoảng cũ thì tải lại. Giờ nhớ từng khoảng ngày trong 60 giây. Đăng xuất thì xoá hết.
  - Đo trên bản chạy trên máy (đăng nhập quản trị): ở Chấm công 0 lần gọi; mở Bảng công 1 lần; chuyển Chấm công / Quản trị rồi quay lại 0 lần; tháng này → 7 ngày qua → tháng này: 2 lần (trước đây 3).

- **Lỗi API chỉ có `error`, không có status, mã lỗi hay mã tra cứu; lỗi nội bộ lộ nguyên thông báo kỹ thuật** (vd `KV put() limit exceeded`).
  - Giờ mọi lỗi có dạng `{ error, code, status, requestId }` kèm header `X-Request-Id`; bị giới hạn tần suất thì thêm `retryAfter` và header `Retry-After: 60`. `requestId` là `cf-ray` của request trên Cloudflare.
  - Lỗi ngoài dự kiến trả `500 INTERNAL_ERROR` với câu báo chung; chi tiết ghi vào log kèm `requestId` để tra trong Observability. JSON hỏng trả `400 INVALID_REQUEST` thay vì 500.
  - App kèm mã tra cứu vào câu báo lỗi máy chủ để người dùng gửi cho quản trị viên. Bảng mã lỗi ghi trong README (mục "Lỗi trả về từ API").

- **Mở F12 là thấy mã kích hoạt, chép sang máy khác dùng được.** Mã nằm trong `localStorage`, trong từng lượt chờ gửi (IndexedDB) và trong header `X-Access-Code` của mọi request.
  - Cách sửa: **đăng nhập theo máy**. Mã kích hoạt chỉ gửi một lần lúc kích hoạt (`POST /api/devices`), không lưu trên máy. Máy tạo cặp khoá ECDSA P-256, khoá bí mật không xuất ra được; mọi request ký bằng khoá đó (`X-Device`, `X-Timestamp`, `X-Signature`, hiệu lực 5 phút, gắn với đường dẫn). Đồng hồ máy lệch thì app lấy giờ server, ký lại một lần.
  - Không giới hạn số máy (mượn điện thoại để tự chấm công). Thêm lựa chọn **"Máy mượn"** lúc kích hoạt: chấm công xong thì máy tự đăng xuất, quá 24 giờ thì hết hạn.
  - Đăng xuất thì server thu hồi máy đó. Quản trị viên có nút **"Đăng xuất mọi máy (n)"**; danh sách nhân viên ghi số máy đang đăng nhập. Tạo mã kích hoạt mới cũng đăng xuất mọi máy.
  - Máy đang dùng bản cũ tự chuyển sang cách mới ở lần mở app đầu tiên, kể cả lượt chờ gửi đang lưu mã; mất mạng thì để lần sau. Một máy giữ khoá của nhiều người để lượt chờ gửi của người đã đăng xuất vẫn gửi đúng tên, gửi xong thì thu hồi.
  - Chi phí: mỗi lần kích hoạt / đăng xuất 1 lần ghi KV; máy mượn thêm 1 lần ghi khi chấm công. Không thêm lượt đọc (máy nằm trong bản ghi nhân viên; quản trị gốc đọc thêm 1 key).
  - Đã thử trên trình duyệt với dữ liệu thử: chuyển máy cũ (mã bị xoá khỏi localStorage, khoá báo `InvalidAccessError` khi xuất), request chỉ còn 3 header chữ ký, đăng xuất thu hồi trên server, kích hoạt lại qua form, "Đăng xuất mọi máy" đưa máy về màn kích hoạt.

### Thay đổi
- Service worker lên `v16`.

## 2026-10-26: Chống spam, chống gửi ảnh lặp, báo lỗi rõ ràng

Đã deploy: phiên bản `258135c6-aa9f-4fe8-86fa-d1488cc164cb` (2026-10-26).

### Sửa lỗi
- **Ghi KV lỗi sau khi đã gửi ảnh thì group nhận ảnh lặp mãi.**
  - Nguyên nhân: server gửi ảnh lên Telegram trước rồi mới ghi KV. Ghi lỗi (vd hết 1.000 lần ghi/ngày) thì trả 500, app gửi lại mỗi 30 giây, mỗi lần thêm một ảnh.
  - Cách sửa: ghi trạng thái ca **trước** khi gửi ảnh; ghi lỗi thì dừng, chưa có ảnh nào. Gửi ảnh lỗi thì trả lại trạng thái cũ. Lượt đã ghi trạng thái mà thiếu bản ghi (lỗi giữa chừng) thì lần gửi lại bổ sung bản ghi, sau đó không gửi thêm ảnh.
- **Lỗi server bị báo là mất mạng.** App hiện "sẽ gửi khi có mạng" dù mạng bình thường. Giờ báo "Server đang lỗi. … đã lưu trên máy, sẽ tự gửi lại; không cần bấm lại."
- **Hàng đợi thử lại 30 giây/lần mãi mãi, và bỏ lượt khi bị 429.** Giờ thử lại giãn dần: 30 giây, 1, 2, 4, 8 phút, tối đa 15 phút; có mạng lại thì thử ngay. Bị giới hạn tần suất (429) thì giữ lượt. Ô "lượt chờ gửi" ghi lý do lỗi và giờ thử lại.
- **Không tải được trạng thái ca thì app im lặng**, có thể hiện sai nút Check-in/Check-out. Giờ hiện cảnh báo ngay trên nút chấm công, kèm nút "Thử lại".
- **Các nút gửi lên server bấm nhiều lần thì gửi nhiều lần** (Gửi tổng hợp ngay, Kết nối bot, Tạo mã mới, Xoá nhân viên, Kích hoạt). Giờ nút bị khoá và hiện "Đang gửi…" trong lúc chờ.
- **Còn lượt chờ gửi mà chấm tiếp thì lượt mới tới server trước lượt cũ và bị từ chối (409).** Ví dụ check-in nằm trong hàng đợi chờ giờ thử lại, app hiện Check-out, bấm thì lượt ra tới trước lượt vào. Giờ app gửi các lượt chờ trước; lượt cũ vẫn chưa gửi được thì lượt mới xếp hàng sau và tự gửi theo đúng thứ tự.
- **Máy quản trị tải bảng công 5 phút/lần cả khi không mở Bảng công.** 3 máy quản trị mở app cả ngày tốn khoảng 90% hạn mức list KV (đo bằng mô phỏng). Giờ chỉ tải khi đang mở Bảng công → Hôm nay; ngày hôm qua chỉ tải trước 12:00 (lúc ca tối hôm qua còn mở). 3 máy mở Bảng công cả ngày còn khoảng 60–66%.

- **Màn chấm công trên điện thoại phải cuộn mới thấy nút chấm công**, và nhân viên có thanh điều hướng đáy chỉ một mục "Chấm công" chiếm chỗ.
  - Nhân viên: bỏ thanh điều hướng đáy (quản trị vẫn giữ).
  - Khung camera cao khoảng 48% màn hình thay vì theo tỉ lệ 4:3 toàn chiều ngang.
  - Nút chấm công dính sát đáy màn hình (trong tầm ngón cái), không cần cuộn tìm.
  - Thu gọn khối tên người và ô chọn ca. Đã xem ở khung 390×760 và 390×600 (giống iPhone có thanh Safari).
- **Khung oval nhỏ hơn khuôn mặt thật khi cầm điện thoại chụp.**
  - Nguyên nhân: oval là hình cố định trong SVG 400×300, chỉ rộng 38% khung, nên mặt người tràn ra ngoài.
  - Cách sửa: oval co theo kích thước khung camera (container query), tỉ lệ 3:4. Trên iPhone (390×664) oval rộng 59%, cao 88% khung; trên máy tính rộng 49%, cao 88%. Viền và vùng tối quanh oval vẫn đổi màu theo trạng thái như cũ.
- Lời nhắc "quay nhẹ đầu" không còn lặp hai chỗ (đã hiện trên khung camera). Trên điện thoại, nhân viên không còn tên trên thanh tiêu đề vì tên đã hiện ngay dưới camera.

### Thêm
- **Giới hạn tần suất bằng Workers Rate Limiting** (miễn phí, không tốn KV; khai báo trong `wrangler.toml`). Vượt mức thì trả 429 kèm câu báo phải chờ 1 phút.
  - Mọi yêu cầu `/api` từ một IP: 300/phút (văn phòng dùng chung IP nên để rộng).
  - Nhập sai mã kích hoạt: 10 lần/phút mỗi IP. Chỉ đếm lần sai, người dùng mã đúng cùng mạng vẫn vào được.
  - Chấm công: 6 lần/phút mỗi mã NV.
  - Gửi tổng hợp ngay, kết nối bot: 1 lần/phút.
- `public/retry.js`: cách thử lại và cách báo lỗi dùng chung, có test (`test/retry.test.js`).
- **Mô phỏng dùng thật** `test/simulate.mjs` (`npm run simulate -- <số người> <số ngày> <số máy quản trị>`): chạy Worker thật với KV và Telegram giả lập, theo đúng nhịp của app (giờ đến cao điểm 07:40–08:10, tan ca, tăng ca, ca tối, cron, bot, máy quản trị mở Bảng công cả ngày). In số request, đọc/ghi/list KV theo ngày UTC so với hạn mức, số tin Telegram cao nhất mỗi phút, mức cao nhất của từng giới hạn tần suất, số ảnh gửi lặp và lượt kẹt. Đọc giới hạn tần suất thẳng từ `wrangler.toml`. Có thể chạy với bản worker cũ và nhịp app cũ để so sánh, và giả lập sự cố hết hạn mức ghi/list giữa giờ cao điểm.
- `test/capacity.test.js`: chặn việc vượt hạn mức quay lại. 30 người với 2 máy quản trị: mọi hạn mức dưới 50%. 100 người: dưới 70%. Hết hạn mức ghi KV lúc 07:58–08:30: không ảnh lặp, không mất lượt, không lượt bị từ chối. Hết hạn mức list cả buổi sáng: chấm công vẫn chạy.

### Thay đổi
- Service worker lên `v15`.

## 2026-10-26: Hết hạn mức lệnh list KV (1.000 lần/ngày)

Đã deploy: phiên bản `258135c6-aa9f-4fe8-86fa-d1488cc164cb` (2026-10-26).

### Sửa lỗi
- **App tải lại bảng công mỗi 30 giây, làm cạn hạn mức list KV sau khoảng 3 giờ.**
  - Nguyên nhân: `flushQueue` (gửi lại lượt chấm công offline, chạy 30 giây/lần) luôn gọi `loadToday()`, kể cả khi hàng đợi trống và tab bị ẩn. Với quản trị viên, mỗi lần là một request `/api/logs`, tốn 2 lệnh list. Log Observability ngày 26/10: 461/1.000 request là `/api/logs` từ một máy, đều 3 request/phút.
  - Cách sửa: chỉ làm mới khi gửi được ít nhất một lượt.
- **Hết hạn mức list thì người chưa có bản ghi trạng thái không chấm công được** (`/api/status` và `/api/punch` lỗi 500).
  - Nguyên nhân: `loadState` dựng lại trạng thái từ lịch sử bằng list, list lỗi thì cả request lỗi.
  - Cách sửa: list lỗi thì coi như chưa vào ca và vẫn cho chấm công; lần sau thử dựng lại.
- **Xem bảng công một tháng tốn khoảng 30 lệnh list, và cache không giúp được** vì Cache API không có tác dụng trên `*.workers.dev`.
  - Cách sửa: ngày công đã khoá (12:00 trưa hôm sau, cộng 24 giờ cho lượt gửi trễ) được lưu thành một key `day:<ngày>` và đọc bằng `get`. Ngày đã khoá chưa có key này thì list theo tháng (`log:YYYY-MM-`, 1 lệnh cho tới 1.000 lượt) thay vì từng ngày.
  - Kết quả: bảng công một tháng tốn 1–2 lệnh list lần đầu, 0 lệnh những lần sau. Mỗi ngày tốn thêm 1 lần ghi KV khi lưu.
  - Ngày còn mở (hôm nay, hôm qua) vẫn list như cũ, nên lượt chấm mới hiện ngay.

### Thay đổi
- Service worker lên `v13` để máy tải lại `app.js` mới.
- `TOI-UU-CHI-PHI.md`: ghi lại số đo và cách sửa.

## 2026-10-26: Lịch sử chấm công chỉ dành cho quản trị (bảo mật)

Đã deploy: phiên bản `258135c6-aa9f-4fe8-86fa-d1488cc164cb` (2026-10-26).

### Sửa lỗi
- **Nhân viên có thể làm cạn hạn mức KV miễn phí trong ngày.**
  - Nguyên nhân: `GET /api/logs` cho mọi người đã kích hoạt gọi, mỗi lần tới 62 ngày, mỗi ngày tốn một lệnh liệt kê KV (gói free 1.000 lần/ngày). App chạy trên `*.workers.dev`, nơi Cache API không có tác dụng, nên gọi thẳng API khoảng 17 lần là hết hạn mức; Bảng công, tin tổng hợp của bot và trạng thái ca đều lỗi tới hết ngày.
  - Cách sửa: `/api/logs` chỉ cho quản trị viên, nhân viên nhận 403. App không bị ảnh hưởng vì chỉ dùng API này ở Bảng công (đã chỉ dành cho quản trị). Có test "Lỗi đã gặp" tái hiện.

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
