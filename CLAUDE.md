# Timesheet

- Mỗi lần thay đổi code hoặc cấu hình, ghi vào `CHANGELOG.md` (mới nhất ở trên, chia Thêm / Thay đổi / Bỏ / Sửa lỗi). Nếu đã deploy, ghi kèm Version ID của Cloudflare.
- Viết tài liệu và giao diện bằng tiếng Việt.
- Logic xác minh và đăng ký khuôn mặt chỉ nằm trong `public/face-logic.js`; `app.js` không được tự định nghĩa lại ngưỡng hay cách so khớp.
- Chạy `npm test` sau mỗi thay đổi (test nhận diện `test/face-logic.test.js` và test backend `test/api.test.js`). Không xoá hay nới lỏng các test "Lỗi đã gặp"; lỗi mới tìm ra thì thêm test tái hiện trước khi sửa.
- Deploy bằng `npm run deploy` (tự chạy test trước), không gọi thẳng `wrangler deploy`.
