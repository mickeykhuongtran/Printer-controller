# ZbrePrinter 3.5.1

Desktop/web 3.5.1, connector 0.9.1. Bản này rút gọn giao diện vận hành và sửa một nhánh xử lý lỗi lưu dữ liệu RFID. Giữ quy trình cuộn và định dạng CSV của 3.5.0.

## Giao diện

- Một checkbox **Lưu dữ liệu / xuất CSV**, không kèm đoạn giải thích thường trực.
- **Dữ liệu cuộn** hiển thị trạng thái, VALID máy, EPC/TID đã lưu, GOOD còn lại và VOID.
- Trạng thái chưa in: **Chưa có dữ liệu in.** Cảnh báo thiếu EPC, lỗi ghi hoặc số đếm tạm chỉ xuất hiện khi có tình trạng tương ứng.
- **Tem VALID đã loại** chỉ có tổng số đã loại trong cuộn và nút lưu; không hiển thị công thức hay hướng dẫn dài.
- **Xuất CSV của cuộn** giữ ba trường người vận hành, Job ID, thứ tự cuộn. Bỏ ghi chú về thời gian tự động.
- Rút gọn nội dung màn hình in/cấu hình; giữ thông báo lỗi và thao tác khắc phục. Không thêm bước xác nhận.
- Rút gọn ghi chú kết nối; bỏ nhãn khuyến nghị Windows printer chung vì thu dữ liệu RFID hiện yêu cầu TCP qua connector.

## Lỗi được sửa

Trước đây, một số lỗi ghi file RFID hoặc đọc counter sau khi máy đã nhận dữ liệu có thể kết thúc kết nối mà chưa gửi lệnh dừng/hủy. Máy có thể tiếp tục phần dữ liệu trong bộ đệm khi phần mềm không còn thu được lịch sử đầy đủ.

Connector 0.9.1 yêu cầu pause và xóa phần lệnh còn lại qua cùng kết nối, với thời gian chờ giới hạn, rồi giữ lần in ở trạng thái chưa xác định để đối soát. Không phát lại lệnh. Nếu đường truyền đã mất, phần mềm không tuyên bố máy đã dừng. VOID bình thường không đi vào nhánh lỗi này. Desktop yêu cầu connector tối thiểu 0.9.1 để tránh dùng lại phiên bản thiếu bản sửa.

## Đánh giá quy trình và mức sẵn sàng

Luồng một cuộn gồm nhiều lần in/in bù, xử lý sự cố rồi tiếp tục, cuối cùng nhập ba thông tin và xuất CSV phù hợp để chạy thử tại phòng in. Phần mềm tự giữ dữ liệu và kiểm soát cấu hình; người vận hành kiểm tra tem thực, khai báo tem VALID bị loại và chọn đúng dòng khi in bù EPC riêng.

GOOD là số lượng dựa trên counter/bằng chứng ghi và khai báo loại tem. Nó không chứng minh chất lượng chữ, QR hay EPC cụ thể nào còn trên cuộn. Ở chế độ đọc, GOOD có thể đủ nhưng lịch sử EPC vẫn thiếu; cảnh báo và CSV phải được kiểm tra trước khi bàn giao dữ liệu cho hệ thống.

Mức sẵn sàng: thử nghiệm có kiểm soát trên máy thật. Chưa đủ bằng chứng để xác nhận ổn định sản xuất dài hạn hoặc đã xử lý dứt điểm hiện tượng dừng sau 19 tem. Cần kiểm tra trên đúng model/firmware/vật tư: nhiều cuộn liên tiếp; VOID rải rác; mở đầu in/hết mực/giấy; mất kết nối; đọc và ghi EPC; đối chiếu counter, tem thực, CSV và upload hệ thống.

## Kiểm thử phần mềm

- Toàn bộ Go tests của connector: đạt, 39,110 giây. `go vet ./...`: đạt.
- Tám trường hợp hồi quy mới về lỗi ghi CSV, counter, đường gửi bị chặn/đóng và lỗi lưu cuối: đạt. Các bài monitor/service fault/status loss liên quan cũng đạt.
- TypeScript, ESLint các thành phần giao diện sửa đổi, production-roll helpers và 12 bài kiểm thử desktop: đạt.
- Build Next, NSIS và kiểm tra bundle/runtime đã đóng gói: đạt.
- Kiểm thử giao diện đóng gói với connector thật và máy in mô phỏng: 2.500 lượt có hai VOID và thiếu một EPC; loại một VALID, in bù ba lượt trong cùng cuộn; VALID 2.501, EPC 2.500, GOOD 2.500, VOID 2. Đã kiểm tra chặn đổi template/chế độ, tải lại giao diện, xuất CSV bảy cột và tải lại cùng file không thay đổi nội dung.
- Template chỉ ghi: hai lần ghi khớp và một lần ghi sai được phân biệt trong số đếm và CSV, kèm dòng nguồn/giá trị dự kiến. Không reset counter máy in.

Các kiểm thử trên không sử dụng máy in vật lý và không xác nhận tốc độ, chất lượng in, độ bền vận hành dài hạn hoặc tích hợp upload hệ thống.

## Bộ cài và bằng chứng

- Bộ cài: `dist/ZbrePrinter-App-Setup-3.5.1-x64.exe` — 137.307.423 byte.
- SHA-256: `C62B18441A8072E24355CB30D445E4B8E4BBBEF0A73EAB82327EF680E16B6B0B`.
- Connector 0.9.1 SHA-256: `c2fb575561fdd9fe6fa466e722d80ef1bd6683ea02fc5308718bc5f21ecf650b`.
- [Kết quả kiểm thử bản đóng gói](production-roll-qa/run-dEMjDH/result.json).
- [Giao diện trước khi in](production-roll-qa/run-dEMjDH/empty-roll.png), [xuất cuộn đọc EPC](production-roll-qa/run-dEMjDH/export-ready.png), [xuất cuộn ghi EPC](production-roll-qa/run-dEMjDH/write-export-ready.png).
- [CSV đọc](production-roll-qa/run-dEMjDH/roll-export.csv), [CSV ghi](production-roll-qa/run-dEMjDH/write-export.csv).
