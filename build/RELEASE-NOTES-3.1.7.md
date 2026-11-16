# ZbrePrinter App 3.1.7 — RFID Text: last N characters

## Cách dùng

1. Bật **Read RFID**, chọn **Bank: EPC**, **EPC length: From PC bits**.
2. Giữ **Template field: rfid_read** (hoặc tên trường đọc đang dùng).
3. Trong Edit, chọn Text có nội dung `{rfid_read}` hoặc liên kết với trường đó.
4. Chọn **RFID text output → Last N characters**, nhập **6** ở **Number of HEX characters**.
5. Lưu template và in qua kết nối ZPL hiện có.

Ví dụ EPC `300833B2DDD90140000000AB` → Text `0000AB`.
Text `EPC: {rfid_read}` → `EPC: 0000AB`.

## Phạm vi thay đổi

- Tùy chọn chỉ áp dụng vào dữ liệu RFID trong Text được chọn; lưu riêng theo Text trong template `.nwl`.
- Mặc định **All characters** giữ hành vi template cũ. QR, barcode, Data Matrix và EPC gốc giữ đầy đủ dữ liệu.
- N là số ký tự HEX, số nguyên 1–128. Giữ các số 0 đầu; nếu dữ liệu ngắn hơn N thì lấy toàn bộ phần có sẵn.
- Máy in cắt dữ liệu đọc của từng tem bằng `^FE#^FD#1,b,1,N#^FS`.
- Khi dữ liệu đã có trên host, Text và bitmap dùng cùng quy tắc cắt chuỗi. Preview chưa có dữ liệu dùng ký tự F để thể hiện độ dài dự kiến.
- Luồng đọc RFID, encode, hiệu chỉnh, kết nối, DataFeed, batch, Pause/Resume/Cancel không đổi.
- Desktop và web runtime tăng từ 3.1.6 lên 3.1.7; connector giữ phiên bản 0.5.2.

## Firmware

- ZT610R: `^FE` từ **Link-OS 6.8 Release 2**, `V96.21.26Z`.
- ZD621R: `^FE` từ **Link-OS 6.8 Release 2**, `V93.21.26Z`; nên dùng **Link-OS 7.0 hoặc mới hơn** vì bản 7.0 sửa lỗi in liên quan `^FE`/`^SF` trên ZD621 RFID.
- Kiểm tra **Firmware của máy in**, không phải **Reader firmware**.

Nguồn: [Zebra Link-OS release notes — bổ sung ^FE](https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/release-notes/Link-OS-v6.9-ReleaseNotes.pdf#page=13), [bản sửa lỗi ZD621 RFID](https://prod-www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/release-notes/Link-OS-v7.1-ReleaseNotes.pdf#page=22).

## Nghiệm thu phần cứng

Trước khi chạy sản xuất, in một dải tem có EPC khác nhau trên mỗi máy, bao gồm hậu tố có số 0 đầu. Đối chiếu Text với 6 ký tự cuối của EPC đọc lại. Nếu cùng tem có QR/barcode EPC đầy đủ, kiểm tra mã vẫn chứa đủ 24 ký tự. Bản build không tự nâng firmware hoặc gửi lệnh đến máy in thực tế.

## Kiểm thử phần mềm

- TypeScript, ESLint trên các file thay đổi và production build.
- Kiểm thử mới: N=1/3/6/24/30/128; số 0 đầu; chuỗi ngắn; biến đổi tên/khác hoa thường; tiền tố/hậu tố; nhiều tham chiếu trong cùng Text; template cũ; giá trị N không hợp lệ; JSON/template round trip.
- ZPL native và bitmap overlay: cả ZT610R/ZD621R, đúng một lần đọc RFID mỗi tem, QR/Text khác giữ EPC đầy đủ.
- So sánh chính xác 40 cấu hình với source 3.1.6: ZPL, bitmap ZPL, preview và preflight giữ nguyên khi không bật tính năng.
- Giao diện đóng gói: chọn chế độ, nhập N, undo/redo theo cơ chế hiện tại, lưu/mở lại, preview và browser/PDF hai dòng giữ đúng dữ liệu tương ứng.
- Hồi quy: ZPL/RFID, Z64, DPI, calibration, barcode, QR, Data Matrix, symbol migration, DataFeed và thứ tự dòng.
- Desktop runtime: 10 kiểm thử đạt. Editor 2.500 dòng, Windows spool 2.500 tem tăng dần/601 tem giảm dần, TCP Pause/Resume và Cancel đều đạt trong môi trường mô phỏng riêng.

Chạy lại kiểm thử riêng của tính năng:

```powershell
# Trong ZbrePrinter
npm run test:rfid-text-suffix

# Trong ZbrePrinter-App, sau khi pack
npm run test:rfid-text-ui
node build/compare-rfid-defaults.cjs
```
