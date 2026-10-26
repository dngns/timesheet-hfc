# QA: nhận diện khuôn mặt

Có hai lớp kiểm tra:

1. **Test tự động** (`npm test`): kiểm tra quy tắc xác minh và đăng ký góc mặt bằng dữ liệu giả lập. Chạy tự động trước mỗi lần `npm run deploy`; test hỏng thì không deploy được.
2. **Test tay với camera thật** (checklist bên dưới): kiểm tra những gì dữ liệu giả lập không thay được, như khuôn mặt thật, ánh sáng, điện thoại thật và độ chính xác của mô hình face-api.

## 1. Test tự động

```bash
npm test
```

- File test: `test/face-logic.test.js`.
- Code được test: `public/face-logic.js`. App dùng đúng file này, không có bản sao logic riêng; có test kiểm tra điều đó.
- Các test có tên bắt đầu bằng **"Lỗi đã gặp"** tái hiện đúng lỗi người dùng đã báo. **Không được xoá hay nới lỏng.**

### Các lỗi đã gặp và test tương ứng

| Lỗi | Test bắt lỗi |
|---|---|
| Người khác vẫn được nhận là nhân viên 1 | Người khác hẳn không bao giờ được xác nhận; người khác chỉ lệch 0.43–0.55 không được xác nhận; mô phỏng 300 người lạ đều bị từ chối |
| Người khác bước vào sau khi chính chủ đã xác nhận vẫn bấm được | Một khung hình người lạ là khoá chấm công ngay; 2 khung hình thì báo "không khớp" |
| Mẫu chụp nghiêng làm sai phép so sánh | Mẫu chụp nghiêng không kéo độ lệch của chính chủ vượt ngưỡng |
| Đăng ký: chưa quay mặt đã được tính xong | Đứng yên nhìn thẳng 60 giây chỉ chụp được 1 mẫu; quay chưa đủ góc thì không chụp |
| Đăng ký: quay hoặc cúi cùng một chiều hai lần vẫn được tính | Quay cùng một bên hai lần không được tính; cúi cùng chiều với lúc ngẩng không được tính |
| Đăng ký: lẫn khuôn mặt nhiều người | Có hai người trong khung hình thì không chụp; người khác thế chỗ giữa chừng thì chụp lại từ đầu |

### Đã kiểm chứng bộ test bắt được lỗi

Ngày 2026-10-26, mình cố tình đưa lại từng lỗi cũ vào một bản sao của code và chạy test. Lần nào cũng có test báo hỏng:

| Lỗi đưa lại | Số test hỏng |
|---|---|
| Ngưỡng cũ 0.5 | 1 |
| Chỉ cần 2 khung hình để xác nhận | 3 |
| Không bắt nhìn thẳng | 2 |
| Lấy trung bình mọi mẫu như FaceMatcher | 2 |
| Không kiểm tra góc mặt khi đăng ký | 7 |
| Cho phép hai người trong khung | 1 |
| Không kiểm tra cùng một người khi đăng ký | 1 |
| Không cần giữ đúng góc | 1 |
| Quay cùng bên vẫn được tính | 2 |
| App bỏ kiểm tra xác minh còn mới khi chấm công | 1 |
| Người lạ vẫn bấm được trong 1 khung hình | 2 |
| Mặt quay nghiêng bị chặn vì bộ phát hiện chấm thấp | 1 |

### Giới hạn của test tự động

Dữ liệu khuôn mặt là giả lập, nên test chỉ chứng minh **quy tắc quyết định** đúng. Test không đo được mô hình face-api phân biệt khuôn mặt thật tốt đến đâu. Phần đó cần checklist bên dưới.

## 2. QA với mô hình face-api thật và ảnh khuôn mặt thật (2026-10-26)

Do trình duyệt trong Claude chặn camera, lần QA này dùng một **camera giả phát ảnh thật** vào **app thật**: toàn bộ luồng (phát hiện mặt, 68 điểm mốc, vector khuôn mặt, quy tắc xác minh, giao diện) chạy như với webcam.

- **Ảnh:** bộ ảnh mẫu công khai của dự án face-api (8 người, 5 ảnh mỗi người, 150×150 điểm ảnh), đặt vào khung 640×480 như ảnh webcam. Ảnh chỉ dùng khi thử, không lưu vào project.
- **Giới hạn:** ảnh nhỏ và mờ hơn webcam thật; **không có khuôn mặt người Đông Á**.

### Độ lệch đo được (mô hình thật)

| | Ít nhất | Trung vị | Nhiều nhất |
|---|---|---|---|
| Cùng một người, ảnh khác nhau | 0.32 | 0.40 | 0.52 |
| Hai người khác nhau | 0.64 | 0.81 | 1.01 |

Ở ngưỡng 0.42:
- **Người lạ được chấp nhận: 0/217.**
- Chính chủ được chấp nhận: 18/31. Ảnh chụp khác ngày, khác ánh sáng hay lệch 0.44–0.52.

### Kết quả trên app thật

| Kịch bản | Kết quả |
|---|---|
| Khung trống | Nút khoá ✅ |
| Chính chủ, ảnh đã dùng để đăng ký | Xác minh sau khoảng 2 giây, độ lệch 0.26 ✅ |
| Chính chủ đang được xác minh, người khác bước vào | Khoá sau 0,32 giây (1 lần quét) ✅ |
| 4 người lạ, mỗi người 5 giây | Không lần nào mở, độ lệch 0.69–0.82 ✅ |
| Chính chủ, ảnh khác ngày chưa dùng để đăng ký | **Bị từ chối**, độ lệch 0.44–0.46 ⚠️ |
| Đăng ký: chỉ nhìn thẳng 8 giây | Đứng ở 1 mẫu ✅ |
| Đăng ký: quay nghiêng | Trước khi sửa: kẹt, báo nhầm "đủ ánh sáng" ❌. Sau khi sửa: chụp được ✅ |
| Đăng ký: quay cùng bên lần hai | Không chụp, sau 5 giây đổi lời nhắc ✅ |
| Đăng ký: người khác thế chỗ giữa chừng | Chụp lại từ đầu ✅ |
| Đăng ký: bước ngẩng/cúi | Không kiểm được: bộ ảnh không có ảnh ngẩng hoặc cúi |
| Ảnh mặt chiếm gần hết khung (ảnh cắt sát) | Bộ phát hiện không thấy mặt ⚠️ Người dùng đưa mặt quá sát camera có thể gặp tình huống này |

### Kết luận

- Phần chặn người lạ hoạt động với mô hình thật, có khoảng cách an toàn rộng (người lạ gần nhất 0.64, ngưỡng 0.42).
- Rủi ro lớn hơn ở chiều ngược lại: **chính chủ bị từ chối** khi điều kiện khác lúc đăng ký. Ngưỡng 0.42 có thể quá khắt khe.
- Chưa chốt được ngưỡng vì bộ ảnh không có người Đông Á. Cần số đo từ camera thật theo mục 3.

## 3. QA với camera thật trên Brave (2026-10-26)

Claude điều khiển Brave của người dùng (tiện ích Claude in Chrome). Người dùng ngồi trước webcam MacBook và làm theo hướng dẫn trên màn hình. Server thử chạy trên máy, Telegram giả lập.

### Đã chạy tốt

| Kịch bản | Kết quả |
|---|---|
| Mở camera, tải bộ nhận diện | ✅ Phát hiện mặt với độ chắc chắn 0.89–0.97 |
| Chính chủ nhìn thẳng sau khi đăng ký | ✅ Độ lệch **0.17–0.38** (ngưỡng 0.42), xác minh ngay khi đăng nhập |
| Hai khung hình liên tiếp của chính chủ | Lệch nhau 0.09 (ổn định) |
| Check-in thật | ✅ Có con dấu "Đã vào", ghi lượt chấm, nút chuyển "Đã chấm công" |
| Đăng ký lại cùng người dưới mã khác | ✅ Cảnh báo trùng khuôn mặt (độ lệch 0.24) |

### Lỗi tìm ra và đã sửa (mỗi lỗi có test "Lỗi đã gặp")

| Lỗi | Số đo thật | Cách sửa |
|---|---|---|
| Bước "ngẩng lên" gần như không thể qua | Cách đo cũ chỉ lệch 0.00–0.045 khi ngẩng (cần 0.06) | Đo góc cúi bằng khoảng mũi–mắt chia khoảng cách hai mắt; mức yêu cầu 0.04 |
| Quay về một phía khó đạt yêu cầu | Nhìn thẳng đã lệch -0.03; quay trái chỉ đạt -0.09..-0.13 trong 23 giây | Tính góc so với lúc nhìn thẳng; mức yêu cầu 0.08 |
| Lời nhắc "Quay sang phía ngược lại với lúc nãy" khó hiểu | Người dùng quay sai phía gần 40 giây | Nhắc theo tư thế lúc đó: "Bạn đang quay cùng phía… Hãy quay sang phải", "Quay thêm một chút" |
| Mẫu nhìn thẳng bị chụp xấu, làm app tự chụp lại từ đầu | Mẫu đầu lệch 0.49–0.54 với các mẫu còn lại của chính chủ | Mẫu nhìn thẳng lấy trung bình các khung hình giữ yên; 3 lần không khớp liên tiếp mới chụp lại |
| Chữ viết tắt ảnh đại diện ra "B(" | Tên "Bạn (QA)" | Chỉ lấy các từ bắt đầu bằng chữ cái |

### So sánh trước và sau khi sửa

| | Trước | Sau |
|---|---|---|
| Thời gian đăng ký đủ 5 góc | 102 giây, 1 lần tự chụp lại | **40 giây**, không lần nào chụp lại |
| Độ lệch giữa các mẫu của cùng người | 0.16–0.60 | 0.20–0.42 |

### Chưa kiểm được

- **Người khác ngồi trước máy của chính chủ:** cần một người thứ hai. Đây là kiểm tra quan trọng nhất còn lại.
- **Giơ ảnh hoặc màn hình điện thoại có mặt chính chủ:** chưa xác định được trong lần ghi 66 giây.
- iPhone, Android.

## 4. Test tay với camera thật

Chuẩn bị:
- Ít nhất **3 người thật**, gồm 2 người có nét mặt khá giống nhau (cùng giới, cùng độ tuổi, cùng kiểu tóc hoặc kính).
- Một điện thoại Android, một iPhone, một máy tính có webcam.
- Tài khoản quản trị để thấy dòng **độ lệch** ở góc camera.

Gọi chủ tài khoản là **A**, hai người còn lại là **B** và **C**. Ghi kết quả vào cột cuối: Đạt / Không đạt, kèm độ lệch hiện trên camera.

### Đăng ký khuôn mặt (tab Quản trị → Thêm nhân viên → Chụp khuôn mặt)

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| D1 | A đứng yên nhìn thẳng, không làm gì thêm trong 20 giây | Chỉ 1 vạch sáng; dòng nhắc "Quay mặt sang trái" đứng yên | |
| D2 | A quay mặt rất ít (khoảng 5°) | Không chụp thêm | |
| D3 | A quay trái rõ ràng và giữ yên | Hiện "Giữ yên", rồi chụp; vạch thứ 2 sáng | |
| D4 | Ở bước "Quay mặt sang phải", A quay trái lần nữa | Không chụp; sau 5 giây đổi lời nhắc "Quay sang phía ngược lại với lúc nãy" | |
| D5 | A quay phải | Chụp; vạch thứ 3 sáng | |
| D6 | Ở bước ngẩng lên, A quay ngang và ngẩng cùng lúc | Không chụp | |
| D7 | A ngẩng lên, rồi ở bước cuối ngẩng tiếp | Bước cuối không chụp | |
| D8 | A cúi xuống | Đủ 5 vạch, hiện "Đã chụp đủ 5 góc" | |
| D9 | Bắt đầu chụp lại, B đứng cạnh A trong khung hình | Hiện "Chỉ để một người trong khung hình", không chụp | |
| D10 | A chụp xong 2 bước, B thế chỗ A | Thông báo "Khuôn mặt thay đổi giữa chừng", chụp lại từ đầu | |
| D11 | Đăng ký B trong khi A đã có trong hệ thống | Không cảnh báo trùng (nếu cảnh báo, ghi lại độ lệch) | |
| D12 | Đăng ký lại chính A dưới một mã mới | Cảnh báo "Khuôn mặt này rất giống A" | |

### Chấm công (máy đã kích hoạt bằng mã của A)

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| X1 | A nhìn thẳng, đủ sáng | Khoảng 1 giây sau: viền xanh, "Đã xác minh", nút mở. Ghi độ lệch | |
| X2 | A làm X1 10 lần, ở các thời điểm khác nhau trong ngày | Cả 10 lần đều xác minh được. Ghi độ lệch lớn nhất | |
| X3 | B đứng trước camera 30 giây | Không lần nào xác minh, nút luôn khoá. Ghi độ lệch nhỏ nhất | |
| X4 | C (người giống A nhất) đứng trước camera 30 giây | Như X3. Ghi độ lệch nhỏ nhất | |
| X5 | A đã được xác minh, B bước vào thay chỗ | Nút khoá gần như ngay lập tức | |
| X6 | A quay ngang hoặc nghiêng đầu nhiều | "Nhìn thẳng vào camera", nút khoá | |
| X7 | Giơ ảnh chụp hoặc màn hình điện thoại có mặt A trước camera | **Ghi lại kết quả.** Đây là giới hạn đã biết: face-api không phân biệt được ảnh với người thật | |
| X8 | A đeo khẩu trang | Không xác minh được (đúng như mong đợi) | |
| X9 | A đeo hoặc bỏ kính so với lúc đăng ký | Ghi độ lệch. Nếu vượt ngưỡng, nên đăng ký thêm mẫu | |
| X10 | Phòng tối, hoặc ngược sáng (cửa sổ phía sau) | Ghi độ lệch. Có thể không xác minh được | |
| X11 | Lặp X1–X5 trên Android, iPhone và máy tính | Kết quả giống nhau trên cả 3 máy | |

### Chỉnh ngưỡng từ kết quả đo

Từ X2, lấy **độ lệch lớn nhất của chính chủ**. Từ X3 và X4, lấy **độ lệch nhỏ nhất của người khác**.

- Ngưỡng `MATCH_THRESHOLD` (trong `public/face-logic.js`, hiện là 0.42) phải nằm **giữa** hai số đó, nghiêng về phía người khác.
  - Ví dụ: chính chủ lớn nhất 0.33, người khác nhỏ nhất 0.47, thì ngưỡng 0.42 là hợp lý.
- Nếu hai vùng chồng lên nhau (chính chủ có lúc lệch hơn người khác), mô hình hiện tại **không đủ chính xác** để tách hai người này. Khi đó cần cân nhắc:
  - Đăng ký lại trong điều kiện ánh sáng tốt hơn.
  - Đổi sang bộ phát hiện mặt `ssdMobilenetv1`: chính xác hơn, nặng thêm khoảng 5,6MB.
  - Thêm bước chống giả mạo (ví dụ yêu cầu chớp mắt) nếu X7 là rủi ro thật.

Mỗi lần đổi ngưỡng: sửa `CONFIG.MATCH_THRESHOLD`, chạy `npm test`, ghi vào `CHANGELOG.md`, rồi deploy.

## 5. QA các tính năng còn lại (2026-10-26)

### Test tự động backend (`test/api.test.js`, 33 test)

Chạy Worker thật trong Node với KV trong bộ nhớ và Telegram giả lập. Phủ:
- **Kích hoạt và phân quyền:** mã sai, định dạng mã, nhập mã viết thường hoặc không gạch, không lộ hash, nhân viên bị chặn ở 7 chức năng quản trị, chuẩn hoá quyền, đổi mã, quản trị viên tự bảo vệ, xoá nhân viên.
- **Chấm công:** quản trị gốc không chấm công, luôn ghi cho người đăng nhập, thứ tự vào/ra, gửi trùng, đi muộn, gửi trễ, giờ chụp bất thường, ranh giới ngày theo giờ Việt Nam, thoát HTML trong chú thích ảnh.
- **Lịch sử:** phân quyền xem, giới hạn 62 ngày, nhiều ngày.
- **Bot:** mã bí mật webhook, `/chatid`, `/homnay`, chat lạ, cập nhật không có tin nhắn, kết nối bot.
- **Lịch tự động:** nhắc 09:00, tổng hợp 18:30, gửi tổng hợp giữa ngày.

Đã kiểm chứng bằng cách đưa lại 6 lỗi (không kiểm lượt trùng, không kiểm dữ liệu khuôn mặt, tổng hợp giữa ngày kiểu cuối ngày, không chuẩn hoá mã, nhân viên xem lịch sử người khác, chấm hộ bằng mã NV gửi kèm): lần nào cũng có test báo hỏng.

### QA giao diện trên Brave

| Phần | Kết quả |
|---|---|
| Bảng công hôm nay: danh sách, bộ lọc, tìm kiếm | ✅ (đã sửa lỗi tìm không dấu) |
| Tên chứa mã HTML `<img src=x onerror=…>` | ✅ Hiện đúng chữ, không chạy mã |
| Lịch sử: chọn nhanh khoảng ngày, câu tổng kết, nhóm theo ngày | ✅ |
| Xuất Excel: BOM UTF-8, tên file, khoảng ngày trống | ✅ (đã sửa lỗi chèn công thức) |
| Ảnh thu nhỏ, xem ảnh lớn, đóng bằng Esc | ✅ |
| Quản trị: chặn lưu khi thiếu mặt hoặc trùng mã, sửa giữ mẫu, đổi mã, xoá | ✅ |
| Nút Kết nối bot, Gửi tổng hợp ngay | ✅ |
| Nhân viên: chỉ thấy Chấm công, gõ `#admin` bị đưa về, chỉ thấy lượt của mình, xem ảnh bị chặn | ✅ |
| Đổi người đăng nhập khi còn lượt chờ gửi | ✅ Ghi đúng người (đã sửa lỗi) |
| Quản trị đổi mã của người đang dùng máy | ✅ Máy tự về màn kích hoạt, có lời giải thích |
| Service worker, manifest, icon | ✅ (đã sửa lỗi thiếu `face-api.js` khi offline) |

### Chưa kiểm được

- **Chạy thật khi mất mạng:** đã kiểm các file được lưu sẵn, nhưng chưa ngắt mạng thật để thử.
- **Nút "Cài app" (sự kiện cài đặt của trình duyệt)** và giao diện khi chạy như app đã cài.
- **Gửi ảnh vào group Telegram thật và lịch nhắc thật trên Cloudflare:** chỉ kiểm với Telegram giả lập, để không gửi tin thử vào group của bạn.
- iPhone (Safari) và Android.
- Người thứ hai ngồi trước máy của chính chủ (mục 3).

## 6. Rủi ro đã chấp nhận

- **`ADMIN_KEY` và `WEBHOOK_SECRET` từng được dán dạng chữ trong group Telegram chấm công** (2026-10-26). Chủ dự án quản lý group và chấp nhận rủi ro, không đổi mã. Nếu thêm người khác vào group, cần xoá các tin nhắn đó trước hoặc đổi mã (`npx wrangler secret put ADMIN_KEY`, `npx wrangler secret put WEBHOOK_SECRET`, rồi bấm Kết nối bot).
- **Bước quay nhẹ đầu không chặn được video quay sẵn** cảnh chính chủ quay đầu. Ảnh mọi lượt chấm vẫn gửi vào group để quản lý xem lại.

