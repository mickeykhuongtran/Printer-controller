# ZbrePrinter 3.5.0 — giám sát nền và kiểm soát dữ liệu cuộn

Desktop 3.5.0 đi kèm connector 0.9.0. Bộ cài yêu cầu đúng phiên bản và các khả năng mới của connector trước khi mở giao diện.

## Giám sát lỗi ở dịch vụ nền

Sau khi nhận dữ liệu in đầu tiên, connector tự hỏi trạng thái máy khoảng 500 ms/lần qua cùng kết nối được điều phối với lệnh in và dữ liệu RFID. Một bộ đọc duy nhất tách dữ liệu RFID khỏi phản hồi trạng thái. Khi phát hiện mở đầu in, hết giấy hoặc hết mực, connector ghi nhận sự cố, gửi pause/hủy phần còn lại một lần, lưu dữ liệu đã nhận và đóng lần in. Lần in mới chỉ được nhận sau khi kiểm tra máy hết lỗi và hàng đợi rỗng. Không gửi lại payload cũ.

Giám sát hoạt động khi giao diện tải lại hoặc ngừng hỏi trạng thái, miễn connector còn chạy. Việc tạo và gửi các chunk chưa gửi vẫn do giao diện đảm nhiệm; đây không phải chế độ tiếp tục toàn bộ lệnh khi đóng ứng dụng. Hết hạn phiên điều khiển hoặc thoát connector có kiểm soát sẽ cố gắng pause/hủy trước khi đóng kết nối. Mất điện, kill process hoặc mất mạng không thể bảo đảm gửi được lệnh hủy.

Chu kỳ 500 ms là lịch hỏi, không phải cam kết phản ứng tức thời: việc gửi/nhận hiện tại phải kết thúc, mỗi truy vấn có timeout. Một sự kiện mở/đóng đầu in giữa hai lần quan sát vẫn có thể bị bỏ lỡ. Khi cần chủ động chỉnh máy, dừng/hủy lần in trước khi thao tác. VOID đơn lẻ không làm monitor hủy lệnh; pause thông thường vẫn có thể tiếp tục nếu không xảy ra lỗi cơ khí.

## Bốn số đếm và thao tác loại tem

- **VALID máy:** chênh lệch bộ đếm máy trong các lần in của cuộn; không lấy số EPC thay cho counter bị thiếu.
- **EPC đã lưu:** số phản hồi EPC hợp lệ; ở chế độ ghi, chỉ tính phản hồi khớp dữ liệu dự kiến. Template đọc TID hiển thị TID đã lưu.
- **GOOD còn lại:** với đọc, VALID trừ tổng số tem VALID đã loại. Với ghi, dùng số nhỏ hơn giữa VALID và số phản hồi ghi khớp, rồi trừ số đã loại. Đây là số lượng dựa trên bằng chứng và khai báo loại tem, không thay thế kiểm tra chữ/QR hay chứng minh EPC nào còn trên cuộn.
- **VOID:** chênh lệch counter VOID. Thiếu số đo hoặc kết quả cuối chưa xác định được thể hiện là số tạm.

Mục **Có loại tem VALID khỏi cuộn** chỉ dùng khi cần: nhập tổng cộng cả cuộn rồi lưu. Không xác nhận sau mỗi lần in. Dữ liệu EPC gốc không bị xóa. Nếu loại tem trong số đã ghi nhưng chưa có phản hồi, GOOD của chế độ ghi có thể là ước lượng thận trọng; cần đối chiếu thực tế.

## Chống trộn cuộn

Cuộn đang mở được gắn với máy/cổng, nội dung template, chế độ đọc/ghi và bank. Đổi số lượng hoặc chọn dòng để in bù vẫn dùng cùng cuộn; thay template, máy hoặc chế độ bị chặn trước khi gửi dữ liệu. Trở lại cấu hình của cuộn để tiếp tục hoặc xuất cuộn trước khi bắt đầu công việc khác. Không tự tách file.

Cuộn cũ được giữ lại. Khi có đủ fingerprint và endpoint phù hợp, thông tin định danh được bổ sung cho lần in mới; lịch sử cũ không được tuyên bố đã xác minh ngược. Alias hostname/IP khác nhau có thể được xem là hai địa chỉ; dùng một địa chỉ ổn định cho mỗi máy. Bảo vệ này áp dụng các lệnh qua connector, không quản lý lệnh do một phần mềm ngoài gửi thẳng đến máy.

## Đọc và ghi EPC

Template ghi EPC có thể bật cùng lựa chọn lưu CSV, kể cả khi không bật đọc để in nội dung. Ứng dụng thêm đọc lại đúng vùng nhớ vừa ghi, so sánh toàn bộ byte dự kiến và lưu `WRITE_OK`, `WRITE_MISMATCH`, `WRITE_UNVERIFIED` hoặc lỗi đọc tương ứng. Trường đọc phục vụ nội dung tem vẫn giữ riêng, nên in TID không thay thế bằng chứng ghi EPC.

Không tự ghi lại EPC thất bại. Với danh sách EPC/serial riêng, chọn đúng dòng dữ liệu để in bù; nhập thêm số lượng không tự xác định những bản ghi còn thiếu. ASCII trong chế độ kiểm chứng phải là ký tự ASCII in được, vừa độ dài cấu hình và không có dấu lệnh ZPL; dữ liệu byte khác dùng HEX.

## CSV và nghiệm thu

Giữ CSV thuần, không mật khẩu, ba trường nhập cuối cùng và thời gian máy tính tự ghi. Bảng vẫn có:

`ordinal,host_time,bank,value,result,received_time,detail`

Phần đầu thêm mã hồ sơ cuộn tự sinh, số EPC, số đã loại, GOOD và trạng thái bằng chứng. Cảnh báo trùng/sai thứ tự được giữ trong `result`. Với ghi, `detail` có thao tác, dòng nguồn và giá trị dự kiến khi cần đối chiếu. `VOID_TOTAL` là số tổng hợp, không phải một tem bổ sung. `host_time` và `received_time` cùng nguồn thời điểm máy tính nhận dữ liệu, biểu diễn giờ địa phương và UTC.

Nghiệm thu trên máy thật: in 2.500 lượt có VOID đầu/giữa/cuối; in bù; mở đầu in/hết mực; tải lại giao diện; đối chiếu tem thực, counter, EPC và CSV. Thử riêng template chỉ ghi và ghi+đọc với EPC đã biết, tem không ghi được và in bù đúng dòng. Kiểm tra upload hệ thống. Không mở rồi lưu lại CSV bằng Excel trước upload.

RFID tuning, vị trí encode và công suất không tự thay đổi. Kết quả kiểm thử phần mềm được ghi trong báo cáo build; vẫn cần nghiệm thu model, firmware và vật tư thực tế.

## Kết quả build và kiểm thử — 18/10/2026

- Bộ cài: `dist/ZbrePrinter-App-Setup-3.5.0-x64.exe` (137.311.481 byte), desktop/web 3.5.0 và connector 0.9.0.
- SHA-256: `C4321BF62F3E3C9F4F3EC7230084EB022F34371A94D315C11870F4BF32756AFE`.
- Đã qua toàn bộ Go tests ở lần build connector cuối, Go vet, TypeScript typecheck, ESLint cho các file sửa, các bài kiểm tra RFID/ZPL/dữ liệu in/roll/TCP và 12 bài kiểm tra desktop. Build Next, NSIS và kiểm tra bundle/packed runtime đều thành công. Không chạy được Go race detector do môi trường thiếu GCC/CGO phù hợp.
- Kiểm thử ứng dụng đã đóng gói với connector thật và máy in TCP mô phỏng: 2.500 lượt, hai VOID, thiếu một phản hồi EPC, khai báo loại một VALID rồi in bù ba lượt trong cùng cuộn. Kết quả: VALID 2.501, EPC đã lưu 2.500, đã loại 1, GOOD 2.500, VOID 2 và cảnh báo thiếu một EPC.
- Template chỉ ghi: ba lượt có hai EPC khớp và một EPC sai; VALID 3, EPC xác minh 2, GOOD 2 tạm, CSV có hai `WRITE_OK` và một `WRITE_MISMATCH` kèm dòng nguồn/giá trị dự kiến. Đổi template hoặc chế độ bị chặn trước khi gửi thêm dữ liệu.
- Đã kiểm tra tải lại giao diện trước/sau khi xuất, in bù không cần bước xác nhận, bảy cột CSV, chỉ xuất khi bấm nút và tải lại cùng báo cáo có nội dung không đổi. Không gửi lệnh reset counter RFID.
- Bằng chứng: [result.json](production-roll-qa/run-uiXhFk/result.json), [màn hình đọc](production-roll-qa/run-uiXhFk/export-ready.png), [màn hình ghi](production-roll-qa/run-uiXhFk/write-export-ready.png), [CSV đọc](production-roll-qa/run-uiXhFk/roll-export.csv), [CSV ghi](production-roll-qa/run-uiXhFk/write-export.csv).

Chưa kiểm thử máy in vật lý. Các kết quả mô phỏng không xác nhận tốc độ, cơ chế VOID hoặc việc khắc phục hiện tượng dừng sau 19 tem trên firmware/máy thực tế.
