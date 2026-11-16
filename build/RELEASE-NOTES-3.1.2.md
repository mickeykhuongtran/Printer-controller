# ZbrePrinter App 3.1.2

Hỗ trợ in DataFeed theo cả hai chiều trong Print → From–To. Nhập From `2350`,
To `1750` để in **601 nhãn**, bao gồm hai đầu, theo thứ tự `2350, 2349, …, 1750`.
From và To là số thứ tự dòng DataFeed tính từ 1, không phải giá trị của một cột.

- Tính số lượng bằng khoảng cách giữa hai đầu cộng 1; tự chọn chiều tăng/giảm.
- Preview một nhãn, danh sách dòng và Roll preview theo cùng thứ tự in.
- Giữ nguyên DataFeed, mã HEX và số 0 đầu. Công thức `ROW()` và serial vẫn tính
  theo vị trí gốc của dòng, không đánh số lại theo thứ tự in.
- Áp dụng chiều đã chọn cho tạo payload, kiểm tra HEX trước in, đóng chunk,
  Windows RAW, TCP/COM, tải ZPL và trang browser/PDF.
- Giữ cơ chế Connector 0.5.0: chuẩn bị đủ batch rồi commit một Windows RAW job.
- Giữ bản sửa hiệu năng Edit với DataFeed lớn của 3.1.1. QZ chưa được tích hợp.

## Kiểm chứng

Kiểm thử UI chạy trên renderer production đã đóng gói, profile riêng, chỉ cho
phép connector giả lập; không gửi lệnh tới máy in thật.

| Trường hợp | Kết quả |
| --- | --- |
| 2.500 dòng, From 2350 → To 1750 | Đủ 601 mã HEX đúng thứ tự, 61 chunk chuẩn bị, 347.127 byte, một mock Windows job |
| 2.500 dòng, All | Đủ 2.500 mã HEX tăng dần, 250 chunk chuẩn bị, 1.440.300 byte, một mock Windows job |
| Preview giảm dần | Bắt đầu dòng 2350; chọn dòng khác đúng nhãn; Roll đúng thứ tự |
| Tải ZPL 2350 → 1750 | Toàn bộ HEX trùng thứ tự payload gửi connector |
| Browser/PDF 5 → 3 | Nội dung trang lần lượt Tag 5, Tag 4, Tag 3 |
| Print → Edit, copies = 2.500 | Kéo object 2 mm khoảng 12,9–14,8 ms; sửa QR 12,1 ms; sửa text 13,2 ms; dời text 8,6 ms |

Số đo hiệu năng là mẫu trên máy build, không phải cam kết cho mọi máy/template.
Browser/PDF vẫn có giới hạn 250 nhãn và không ghi RFID như trước; batch 601 nhãn
ở trên được kiểm chứng bằng đường ZPL/Windows RAW.

- Qua test range hai chiều, toàn bộ 2.500 dòng, một dòng, giới hạn đầu/cuối,
  công thức/serial theo dòng gốc và xác định dòng HEX lỗi theo chiều in.
- Qua các test print-batch-data, raw-spool-batch, print-calibration, 10 desktop
  unit tests, TypeScript, production build và lint (0 lỗi, 6 cảnh báo có sẵn).
- Qua hồi quy Edit: preview dòng cuối, undo/redo, DataFeed giữ nguyên tham chiếu
  và nội dung. Qua kiểm tra lịch sử/khôi phục batch không tạo job trùng.
- Qua bundle/packed runtime và health check Connector 0.5.0.
- Kiểm tra archive installer bằng 7-Zip: `Everything is Ok`; có cảnh báo phần
  dữ liệu nằm sau archive nhúng trong EXE tự giải nén.

## Source và bộ cài

- Source web: `../ZbrePrinter`, commit `b3c4c9140cf7f2ea9f9cb2586ca4e5eea054f500`.
- Manifest: web `3.1.2`, `sourceDirty: false`, Connector `0.5.0`.
- Tái sử dụng binary connector đã kiểm tra SHA-256; bản này không thay đổi Go connector.
- Bộ cài: `dist/ZbrePrinter-App-Setup-3.1.2-x64.exe`.
- Dung lượng: 136.880.555 byte.
- SHA-256: `ceb7851d9a424a5ad58186937ba62e22ee2702d0d7dccae538c26e6410d3031b`.

Đóng ZbrePrinter rồi chạy bộ cài 3.1.2 vào vị trí cài đặt hiện tại để cập nhật.
Đợt kiểm chứng này chưa cài đè lên app người dùng và chưa in thử trên máy Zebra thật.
