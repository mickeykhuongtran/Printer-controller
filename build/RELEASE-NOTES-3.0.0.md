# ZbrePrinter App 3.0.0

Ngày build: 2026-09-07.

- Barcode/QR nhỏ hơn ngưỡng scanner, vượt khung hoặc barcode có phần chữ vượt chiều cao: chuyển sang cảnh báo, cho phép in thử và xuất ZPL.
- Barcode/QR chồng một phần ra ngoài nhãn: cảnh báo khả năng bị cắt, cho phép căn chỉnh bằng nhãn thực tế.
- Thêm thanh cảnh báo màu vàng ở bước Print và cập nhật cảnh báo trong bảng thuộc tính. Cảnh báo bước Print phản ánh dòng đang preview; các dòng còn lại vẫn được kiểm tra khi chuẩn bị in.
- Khi máy in đọc EPC vào field đã cấu hình, ví dụ `{read_epc}`, kích thước chỉ là ước tính theo cấu hình RFID. Có thể in test vài tag và điều chỉnh barcode dots/module hoặc QR magnification thủ công. Giá trị EPC mẫu dùng để ước tính không được đưa vào nội dung in thật.
- Giữ giá trị manual trong giới hạn lệnh hiện có. Cấu hình manual không bị sửa để ép đạt ngưỡng scanner.
- Đồng bộ phiên bản desktop/web thành 3.0.0; Local Print Connector giữ phiên bản 0.4.0.

Các lỗi dữ liệu không mã hóa được, field chưa được cấu hình/không resolve, DPI không tương thích và cấu hình RFID native không được hỗ trợ vẫn báo lỗi. QR đọc RFID trên máy cần Rotation 0°, Version Auto và magnification trong giới hạn native hiện có.

Kiểm thử: TypeScript, ESLint trên các file sửa, 8 nhóm regression web (bao gồm calibration mới), 8 desktop tests, build production, xác minh bundle và runtime đóng gói. Kiểm tra giao diện bản đóng gói dùng profile riêng; không in tag vật lý.

In test thực tế: import list, chọn First N = 1–3, kiểm tra tag và khả năng quét, rồi chỉnh manual dots/module hoặc magnification theo kết quả trước khi in cả lô.

Source chính: `../ZbrePrinter`; `bundle/web` được sinh lại khi build. Bản sao các file trước khi chỉnh nằm tại `build/v3-before-calibration`.
