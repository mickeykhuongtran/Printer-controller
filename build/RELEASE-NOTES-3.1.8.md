# ZbrePrinter App 3.1.8 — RFID Text suffix compatibility

## Hiện tượng và thay đổi

Người dùng báo ZT610R chạy Link-OS 7.6.2 đọc đủ EPC 24 ký tự nhưng Text
"Last N characters = 6" chỉ in ký tự cuối. Ví dụ EPC
`E280F30200000001744AC695` cần in `4AC695`, nhưng tem chỉ in `5`.

3.1.7 dùng `#1,b,1,6#`. Ví dụ trong [tài liệu Zebra ^FE](https://docs.zebra.com/us/en/printers/software/zpl-pg/zpl-commands/%5Efe.html)
mô tả một đoạn cắt từ cuối, nhưng ảnh kết quả phù hợp với cách firmware
hiểu `b` là vị trí bắt đầu tính từ cuối rồi lấy ký tự theo chiều tiến.
Đây là chẩn đoán từ source và ảnh; chưa có ZPL gốc hoặc phép đo trên máy in.

3.1.8 thay đoạn cắt bằng các tham chiếu một ký tự:

```zpl
^FE#^FD#1,b,6,1##1,b,5,1##1,b,4,1##1,b,3,1##1,b,2,1##1,b,1,1#^FS
```

Với độ dài 1, hai cách hiểu của đoạn cắt cho cùng ký tự. Ghép từ vị trí
thứ N tính từ cuối đến vị trí cuối giữ đúng thứ tự và số 0 đầu. Cách này
không giả định EPC luôn dài 24 ký tự và không thêm lượt đọc thẻ.

## Phạm vi

- Chỉ đổi ZPL của Text đã bật Last N characters và lấy dữ liệu trực tiếp từ máy in.
- Data Matrix, QR, barcode và Text All characters giữ dữ liệu RFID đầy đủ.
- Preview/host-resolved data, nội dung thẻ, encode, calibration, transport,
  batch, Pause/Resume/Cancel giữ logic hiện tại.
- Template 3.1.7 mở lại được, không cần tạo lại. Desktop/web lên 3.1.8,
  connector giữ 0.5.2.

## Kiểm tra trên máy in

1. Cài 3.1.8, mở template đang dùng.
2. Read RFID: Bank EPC, From PC bits, Template field `rfid_read`.
3. Data Matrix: Data `{rfid_read}`; Text: `{rfid_read}`, Last N characters = 6.
4. Có thể mở `RFID-Matrix24-Text6-check.nwl` kèm bản build. Mẫu có Data Matrix,
   dòng EPC đầy đủ và dòng 6 ký tự để đối chiếu cùng tem. Mẫu 60 × 40 mm,
   mặc định ZT610R / 300 dpi: chỉnh kích thước, model và DPI đúng máy thực tế.
5. In 1–3 tem, quét Data Matrix ở chế độ hiển thị dữ liệu thô. Chuỗi quét phải
   trùng dòng EPC đầy đủ (24 ký tự cho thẻ 96 bit); dòng LAST 6 phải trùng
   6 ký tự cuối của chính chuỗi trên cùng tem. Các tem có thể có EPC khác nhau.

Ví dụ: `E280F30200000001744AC695` → `4AC695`;
`E280F30200000001744AC696` → `4AC696`.

Không dùng kết quả nút READ EPC ở thời điểm khác để đối chiếu tem đã tiến khỏi
anten: đó có thể là một thẻ khác. Đối chiếu mã và chữ trên cùng tem.

Nếu còn lỗi: Print → More actions → Download .zpl để lấy lệnh chẩn đoán.
Gửi file .zpl hoặc template .nwl cùng ảnh tem và bản in cấu hình máy.

## Xác minh

- Đạt TypeScript, ESLint, build production, verify bundle và verify packed.
- Kiểm thử phần trích chuỗi đánh giá ZPL được tạo với cả hai cách hiểu `b`;
  có EPC người dùng cung cấp, số 0 đầu, N=1/3/6/24/30/128, chuỗi ngắn/rỗng,
  hai model và đường in native/bitmap overlay. Đây là mô hình tham chiếu,
  không phải trình giả lập firmware; hành vi ngoài độ dài EPC cần nghiệm thu
  thêm nếu sử dụng N lớn hơn chiều dài dữ liệu thực tế.
- Đạt kiểm thử ZPL/RFID, Z64, DPI, DataFeed/batch, Data Matrix và 10 test desktop.
- 40 cấu hình tắt tính năng giữ nguyên ZPL, bitmap overlay, preview và preflight.
- Giao diện đóng gói: chọn N, undo, sửa Text gốc, lưu lại, preview, hai dòng
  browser/PDF và Data Matrix giữ tham chiếu đầy đủ.
- Xuất .zpl từ giao diện app đóng gói với chính mẫu kèm theo: Data Matrix
  `^FN1`, Text gồm sáu tham chiếu `b,k,1`, một lần `^RFR`, không có encode
  hoặc EPC mẫu được gán cứng trong lệnh in.

Kiểm thử mô hình chuỗi không thay thế kiểm thử firmware thật. Cổng
`192.168.50.50:9100` không truy cập được từ môi trường build trong lần kiểm tra,
nên bản này cần nghiệm thu in trên ZT610R và ZD621R trước khi chạy lô.
