# ZbrePrinter 3.4.0 — in liên tục và một file cho mỗi cuộn

## Quy trình vận hành

1. Bật **Lưu dữ liệu / xuất CSV**, nhập số lượng và in. Không cần tạo Job/cuộn hay điền thông tin trước khi in.
2. RFID đọc lỗi: máy đánh VOID và chuyển sang tem kế tiếp. Số lượng yêu cầu là số lượt tem, không tự bù cho đủ VALID. Ví dụ 2.500 lượt có 2 VOID thì đối chiếu 2.498 VALID và tự in thêm 2 lượt.
3. Khi hết mực, hết giấy hoặc mở đầu in, phần lệnh còn lại bị hủy. Sau khi sửa máy và xác nhận buffer đã rỗng, nhập số lượng còn thiếu rồi in tiếp. Dữ liệu vẫn nằm trong cuộn đang mở.
4. Hoàn tất cuộn: nhập **Tên người vận hành**, **Job ID**, **Thứ tự cuộn** rồi bấm **Xuất CSV**. Ngày giờ lấy từ đồng hồ máy tính tại lúc xuất.
5. Chỉ sau khi xuất thành công cuộn mới đóng. Lần in tiếp theo mới mở cuộn mới. Có thể tải lại bản xuất đã lưu.

Không còn xác nhận từng lượt in, loại thủ công từng EPC, nhập mã cuộn nguyên liệu/lô vật tư, chốt QC hay khóa vì chưa đủ 2.500. Dữ liệu được lưu liên tục ở connector, độc lập với thao tác tải file.

## Nội dung file

Phần đầu: người vận hành, thời gian xuất, job_id, thứ tự cuộn và Total / Valid / VOID. Bảng chi tiết chỉ có:

`Total` là tổng số lượt RFID đã ghi nhận = Valid + VOID. Ví dụ in 2.500 lượt có 2 VOID rồi bù 2 VALID: Total = 2.502, Valid = 2.500, VOID = 2.

`ordinal,host_time,bank,value,result,received_time,detail`

`host_time` là thời gian máy tính nhận dữ liệu, có ngày tháng và mili giây; `received_time` lưu thời điểm UTC để truy xuất giữa hệ thống. `detail` mô tả thao tác đọc/ghi. Không suy diễn EPC hay vị trí vật lý của tem VOID nếu máy in chỉ cung cấp bộ đếm tổng. Khi chỉ có số VOID tổng, báo cáo ghi rõ tổng; thiếu bằng chứng không được biến thành số 0.

## File CSV và bản gốc

Theo yêu cầu đã chốt, bản này xuất **CSV thuần, không mật khẩu**, để upload trực tiếp lên hệ thống. UTF-8 BOM giúp Excel hiển thị tiếng Việt.

Connector giữ bản gốc và SHA-256 để kiểm tra khi tải lại. File đã tải ra vẫn có thể sửa như CSV thông thường; không có khóa mật khẩu hay cơ chế chống sửa tại hệ thống nhận.

## Sửa nguyên nhân dừng sau VOID

- Chế độ đọc RFID dùng `^RS...1,N`: một lượt tem cho mỗi format, VOID rồi bỏ format lỗi và chuyển tiếp. Các template cũ có lựa chọn dừng P/E cũng được xử lý cho luồng đọc liên tục.
- Bỏ điều kiện dừng gửi chỉ vì thiếu/không hợp lệ/khác thứ tự phản hồi EPC. Các dữ liệu đó vẫn được lưu để truy xuất.
- Hoàn tất lệnh in không bắt buộc số EPC hợp lệ phải bằng số lượng yêu cầu; kiểm tra số lượt bằng VALID + VOID khi có đủ bằng chứng bộ đếm.
- Buffer có giới hạn số format chờ để điều tiết truyền. Việc chạy thêm khoảng 19 tem phù hợp với các format đã nằm trong buffer khi phần mềm ngừng gửi; không phải giới hạn tổng số tem của máy.
- Lỗi lưu đĩa, mất kết nối và lỗi cơ khí vẫn được xử lý riêng. Không gửi lại mù những lệnh có thể đã in.

Tham chiếu: [Zebra ^RS](https://cpws.zebra.com/cpws/docs/zpl/RS_Command.pdf).

## Nghiệm thu trên máy thật

Đã kiểm thử: toàn bộ Go tests và Go vet; các suite ZPL/RFID/TCP/cancel/streaming; TypeScript; build installer và xác minh bundle. Kiểm thử giao diện trên bản đóng gói với connector thật + máy in mô phỏng đạt 2.500 lượt (2.498 VALID, 2 VOID), in bù 2 VALID, phục hồi cuộn sau reload, nhập đúng 3 trường xuất, xuất CSV 7 cột và tải lại đúng bản gốc. Không gửi lệnh đến máy in thật. Kết quả mô phỏng: `build/production-roll-qa/run-bSsF3z/result.json`; ảnh giao diện: `export-ready.png`; file mẫu: `roll-export.csv` trong cùng thư mục.

Chạy 2.500 lượt với 2 tem lỗi RFID, xác minh máy đi tiếp đến hết và hiển thị 2.498 VALID / 2 VOID; in bù 2 VALID rồi xuất đúng một file. Tiếp theo thử hết mực/mở đầu in, sửa máy, in phần thiếu và xác minh dữ liệu trước/sau lỗi vẫn trong cùng cuộn. Kiểm tra upload CSV trên hệ thống đích.

Kiểm thử phần mềm và mô phỏng không thay thế nghiệm thu trên firmware, vật tư và cấu hình RFID của máy thực tế. Bản này không thay đổi công suất RF, vị trí encode hay hiệu chuẩn vật tư.

Desktop 3.4.0 yêu cầu connector 0.8.0. Build connector dùng Go 1.22 trở lên (toolchain có sẵn trong workspace).

Khi nâng từ 3.3.0, nếu template chưa lưu lựa chọn capture, bật **Lưu dữ liệu / xuất CSV** một lần để ứng dụng tìm lại cuộn đang mở. Dữ liệu cũ vẫn nằm trong connector; không cần tạo lại cuộn.
