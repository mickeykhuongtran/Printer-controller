# ZbrePrinter 3.8.0

Desktop/web 3.8.0; connector 0.11.0.

## Sửa bổ sung trong cùng bản 3.8.0

- **Text margin (mm)** trong thuộc tính Text đặt lề bên trong cả bốn cạnh khung. Text mới và mẫu cũ mặc định **0,25 mm**. Giá trị 0 khôi phục vị trí chữ sát mép. Lề lưu theo từng text trong template và file `.nwl`.
- Lề được làm tròn lên theo dot của máy in, tương ứng 2 / 3 / 6 dot cho 0,25 mm ở 203 / 300 / 600 DPI. Editor, nhập text, bitmap và trường ZPL đọc EPC dùng cùng lề khi xoay. Thuộc tính Text hiển thị diện tích còn lại để đặt chữ.
- Với khung 35,47 × 3 mm và font 2,5 mm của mẫu tem 56 × 34 mm ở 300 DPI, phần chữ còn 420 × 30 dot. Ở 180°, điểm neo EPC dịch từ (628,354) đến (625,351). Khung chọn và cỡ chữ giữ nguyên.

- Dòng ZPL căn trái, không ngắt dòng, chế độ Clip (ví dụ `EPC: {rfid_read}`) lại in trực tiếp như 3.7. Bản 3.8 trước đó thêm `^FB` một dòng, có thể làm firmware ngắt dòng và in đè khi dữ liệu vượt chiều rộng khung. Ở 90°, 180° và 270°, ứng dụng xoay điểm neo đường cơ sở của ký tự đầu. Đã đối chiếu lệnh in với bộ cài 3.7 và kiểm tra đủ bốn góc trên mẫu 56 × 34 mm, 300 DPI. Kết quả nét in vật lý cần kiểm tra trên ZT610R.

- Sửa thanh phân cách bị lệch so với logo khi xoay: đường kẻ có khung rộng hơn nét mực nay xoay cả vị trí nét bên trong khung. Editor, bitmap và ZPL native dùng chung hình học nét theo dot máy in.
- Template/phiên đã lưu bằng bản 3.8.0 trước khi sửa được khôi phục mép nét theo góc template khi mở lại. Không cần xoay lại thủ công. Đường mới thêm trong template đang xoay giữ vị trí qua lần lưu sau.
- Xoay hoàn toàn trong phần mềm: giữ nội dung, kích thước và bố cục tương đối của thiết kế. Không gửi `^PON`/`^POI` để thay đổi chế độ hướng in trên máy; người vận hành quản lý chế độ máy in.
- 180° trong app xoay nội dung nhìn thấy trên nhãn, không thay đổi chiều chạy giấy, vị trí anten RFID hay thứ tự đọc/ghi EPC. `{rfid_read}` được máy thay bằng giá trị đọc thực tế rồi in theo hướng của trường text/Data Matrix.
- Kiểm thử bổ sung mô phỏng thanh đứng khung 3 mm, nét 0,25 mm: sau xoay 180°, nét giữ đúng khoảng cách với logo. 168 ca raster ở 203/300/600 DPI, gồm nét ngang/dọc và khung lớn hơn nét; các ca đường kẻ khớp chính xác từng pixel.

## Clear lịch sử cuộn

- Trong **Print → Dữ liệu cuộn → Lịch sử cuộn / xuất CSV**, chọn **Clear cuộn đã chọn** hoặc **Clear toàn bộ cuộn đã đóng**.
- Clear dọn danh sách và lưu trạng thái tại connector, giữ qua lần mở lại app. Cuộn đang mở không thể clear.
- **Hiện cuộn đã clear** cho phép xem, tải EPC/CSV và **Khôi phục cuộn đã chọn**. Clear không xóa vĩnh viễn file dữ liệu.
- Metadata hiển thị được lưu riêng; số đếm, dữ liệu EPC và bản CSV đã xuất giữ nguyên. Không gửi lệnh đến máy in khi clear/khôi phục.
- Giữ desktop/web 3.8.0; connector 0.11.0 được build lại kèm khả năng clear lịch sử.

## Xoay template

- Trong Edit, mở panel Label và chọn **Template rotation → 0° / 90° / 180° / 270°**.
- Góc là hướng tuyệt đối. Chọn lại cùng góc không xoay thêm. Trở về 0° khôi phục hướng bố cục ban đầu.
- Xoay toàn bộ text, QR, Data Matrix, barcode, ảnh/icon, bảng, đường và hình chữ nhật, kể cả phần tử đã khóa. ID, dữ liệu liên kết, kích thước font và tỷ lệ nội dung được giữ nguyên.
- Chuyển một phần tư vòng đổi chiều rộng/cao nhãn và khung phần tử. Ví dụ 60 × 40 mm thành 40 × 60 mm. Gap, DPI và cấu hình máy in giữ nguyên; nhãn thực tế phải phù hợp kích thước mới.
- Undo/Redo, lưu template, xuất/nhập `.nwl` và mở lại phiên làm việc giữ được hướng đã chọn.

## Text và khung

- Chữ và textarea dùng cùng hệ tọa độ xoay với khung vật lý. Không còn chữ xoay quanh góc trên trái rồi chạy ra ngoài khung chọn.
- Xoay từng phần tử đổi chiều W/H của khung ở 90°/270°, giữ cách xuống dòng và kích thước chữ.
- Wrap, shrink, căn trái/giữa/phải tính trong hệ tọa độ của nội dung; text được giới hạn trong khung trên editor và bitmap.
- Ảnh giữ tỷ lệ nguồn. Bảng giữ hàng/cột và hỗ trợ chỉnh ô, kéo đường phân cách, đổi kích thước sau xoay.
- Preview, bitmap ZPL và browser/PDF dùng hình học đã xoay. Text RFID native và Data Matrix RFID phát hướng N/R/I/B tương ứng.

## Giới hạn QR lấy dữ liệu trực tiếp từ máy in

QR có dữ liệu tĩnh hoặc DataFeed được raster và xoay đủ bốn góc. QR chứa giá trị RFID chỉ biết sau khi máy in đọc chip vẫn phải dùng native `^BQ`, vốn chỉ hỗ trợ hướng normal và không nhận xoay qua `^FW`. Ứng dụng tiếp tục báo lỗi rõ ràng nếu trường hợp này yêu cầu góc khác 0°, tránh in một hướng khác preview. Text và Data Matrix đọc cùng EPC có thể xoay.

Tham chiếu: [Zebra Programming Guide, ^BQ / ^BX / ^FO](https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/guide/software/zpl-zbi2-pg-en.pdf), trang 128, 144 và 201.

## Kiểm chứng

- TypeScript, ESLint trên các file thay đổi; các kiểm thử hiện có về RFID suffix, Data Matrix, Symbol Config, DataFeed và calibration.
- Kiểm thử hình học, chuyển góc tuyệt đối, không tích lũy sai số sau 400 lượt xoay, phần tử khóa, Undo/Redo, serialization, chỉnh bảng và ZPL RFID bốn góc.
- 192 ca Chromium ở bốn góc và ba mức DPI, gồm text EPC với lề mặc định, text với lề tùy chỉnh, ảnh, bảng, mã và đường kẻ. Kiểm tra từng pixel trong lề và đối chiếu riêng nét E với khung rộng ở cả 12 tổ hợp góc/DPI.
- Kiểm thử renderer trong bản đóng gói: nút xoay, khung text/textarea, kéo/resize, lưu/mở lại, preview, xuất ZPL và browser/PDF. Kết quả ở `build/rotation-qa/`.

Chưa nghiệm thu bằng máy in vật lý trong lần build này. Khi đưa vào vận hành, in thử một tem ở từng góc với đúng khổ nhãn, DPI và cấu hình RFID hiện dùng.
