# ZbrePrinter App 3.1.9 — Preserve imported image proportions

## Sửa lỗi

- Edit trước đây fit ảnh vào khung và giữ tỷ lệ, nhưng preview/bitmap ZPL kéo
  raster image đầy khung W × H. Logo có thể dãn ngang/dọc khi chuyển sang Print.
- Edit, preview, browser/PDF và bitmap ZPL nay dùng chung thuật toán contain:
  giữ toàn bộ ảnh theo tỷ lệ nguồn, căn giữa khung, để trống phần dư.
- Thay đổi W/H hoặc kéo cạnh/góc chỉ thay đổi khung; ảnh không bị kéo méo.
  Giữ Shift khi kéo góc vẫn giữ tỷ lệ khung như trước.
- Replace giữ W/H, vị trí, threshold và rotation của phần tử; ảnh mới dùng
  tỷ lệ riêng của nó, không kế thừa tỷ lệ ảnh cũ. File ảnh gốc không bị sửa.
- SVG giữ viewport gốc. SVG chỉ có viewBox được cấp kích thước theo viewBox,
  tránh lệch tỷ lệ do viewport mặc định bị làm tròn của trình duyệt.
- Template cũ dùng ngay, không cần migration. Web/desktop lên 3.1.9;
  Local Print Connector giữ phiên bản 0.5.2.

## Kiểm thử

```powershell
npm run test:image-rendering
npm run test:image-ui
```

Kiểm thử raster dùng Chromium thật, kiểm tra biên pixel của ảnh PNG/JPEG/SVG
ngang, dọc, vuông trong nhiều khung tại 203/300/600 DPI. Đối chiếu Edit, preview
và bitmap 1-bit, gồm SVG chỉ có viewBox, SVG base64/XML và ảnh có nền trong suốt.
Kiểm thử UI dùng runtime đã đóng gói, profile riêng và chặn kết nối máy in.
Kết quả được lưu trong `build/image-qa/`.

Kết quả build này: 84 trường hợp raster đạt; UI import, W/H, kéo cạnh,
Replace PNG/SVG khác tỷ lệ, undo/redo và khôi phục session đạt. Biên pixel
trong ZPL đã giải nén khớp Print preview; canvas browser/PDF khớp Edit.
TypeScript, ESLint trên các file sửa, desktop unit tests, DPI preflight,
RFID Text suffix, Z64 round trip và kiểm tra runtime đã đóng gói đều đạt.

## Nghiệm thu trên máy in

1. Mở template đang dùng, chọn logo và thay đổi W/H hoặc kéo cạnh/góc.
2. Replace bằng ảnh ngang rồi ảnh dọc: khung và vị trí giữ nguyên, hình không méo.
3. So sánh Edit và Print preview; ảnh phải cùng tỷ lệ, vị trí trong khung.
4. In thử một nhãn trên máy in thực tế ở đúng DPI. Phần dư trong khung là
   khoảng trống có chủ đích để giữ tỷ lệ; không phải nội dung bị cắt.

Chưa thực hiện in vật lý trong lần build này.
