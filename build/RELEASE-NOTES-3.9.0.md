# ZbrePrinter 3.9.0 — nhiều máy in và một hồ sơ cho mỗi cuộn

Phát triển từ mã nguồn 3.8.0 đang dùng. Connector 0.12.0; giữ Electron + Next.js/React + Go, không đổi sang C#.

## Thay đổi vận hành

- Thêm/chọn máy bằng IP. Mỗi máy có cấu hình kết nối và bản nháp template riêng; dữ liệu template lớn lưu trong IndexedDB.
- Chuẩn bị toàn bộ lượt in và lưu bền vững trước khi giao cho connector. Chuyển máy, chuyển sang chỉnh template hoặc tải lại giao diện không gửi lại lượt đã giao.
- Chạy nhiều máy độc lập. Mặc định 10 kết nối in đồng thời; `ZBRE_MAX_ACTIVE_PRINTERS=1..64` điều chỉnh mức đồng thời. Lượt vượt mức chờ trong hàng đợi. Đây là giới hạn tài nguyên cấu hình được, không phải cam kết số máy vật lý vô hạn.
- UI chính hiển thị IP, số lượng yêu cầu của lượt, VALID, VOID và trạng thái. VALID/VOID trên thẻ cộng phần đã có của cuộn với lượt hiện tại; chi tiết đối soát nằm trong phần mở rộng.
- 2.500 là số tem của lượt yêu cầu. Phần mềm không tự in bù cho đủ 2.500 VALID.
- Một cuộn có nhiều lượt/cấu hình. Chỉnh vị trí nội dung, tốc độ hoặc độ đậm không bắt buộc đóng cuộn. Mỗi lượt giữ fingerprint và bản cấu hình bất biến; vẫn kiểm tra đúng máy, bank và chế độ RFID.
- Ghi chú chọn dòng bằng mã bản ghi ổn định. Áp dụng lưu ngay, sau thành công mới xóa ô nhập/chọn. Ghi chú không thay đổi EPC, VALID, VOID hay kết quả đọc gốc.
- Mất tem chưa xác định EPC: dùng ghi chú sự cố; CSV có bản ghi `INCIDENT`, có thể gắn mốc dòng gần đó nhưng không khẳng định EPC của dòng ấy bị mất.
- CSV cuộn vẫn 7 cột, thêm metadata `printer_ip`; ghi chú dòng nối vào `detail`. CSV đã lưu từ phiên bản cũ được tải lại nguyên byte.

## Quy trình đề nghị

1. Gắn IP cố định cho từng máy, dán nhãn IP, thêm máy và chọn đúng template/DPI/cấu hình cho từng máy.
2. Cuộn mới: căn giấy/RFID calibration trước, reset VALID/VOID trên máy về 0, rồi gửi lượt. Connector kiểm tra baseline; phần mềm không tự reset counter.
3. Theo dõi thẻ máy. “Xong lượt” chỉ xuất hiện sau bằng chứng counter cuối và máy xử lý hết lượt; cuộn vẫn mở để đối soát hoặc in bù.
4. Chỉnh giấy ngắn: tạm dừng. Nếu mở đầu in tạo lỗi dịch vụ, lượt hiện tại dừng và yêu cầu xóa buffer/đối soát; hồ sơ cuộn được giữ.
5. Đổi template/tốc độ/độ đậm: kết thúc hoặc dừng lượt hiện tại, kiểm tra tem thực tế, chỉnh cấu hình, chọn tiếp tục cùng cuộn và nhập số lượng lượt tiếp theo. Cấu hình đã sửa không thay đổi dữ liệu của lượt đang chạy.
6. Ghi chú dòng hoặc sự cố ngay khi xử lý. Không reset counter giữa cuộn. Người vận hành quyết định số in bù.
7. Chỉ “Đóng cuộn” khi kết thúc cuộn thực tế. Nhập thông tin xuất và lấy một CSV chứa mọi lượt của cuộn.
8. Mất điện/connector khởi động lại: lượt đang chạy hoặc đã xếp hàng được giữ ở trạng thái cần kiểm tra, không tự phát lại. Kiểm tra buffer/tem trước khi xác nhận đối soát.

## Lag và READ_ERROR

Đã phát hiện các điểm gây chậm trong mã: đọc lại toàn bộ EPC để cập nhật UI, giữ khóa chung trong khi chờ máy in, đồng bộ ổ đĩa trên từng phản hồi trong một gói TCP. Đã giảm tải truyền/hiển thị dòng, tránh chờ I/O máy khác trong thống kê và đồng bộ dữ liệu theo gói nhận. Bản cấu hình lớn lưu một lần, không ghi lại trong mỗi lần cập nhật counter. Danh sách giám sát chỉ trả lượt mới nhất từng máy; lịch sử được phân trang. Trên Windows, thao tác thay file hồ sơ đã sync được thử lại có giới hạn 500 ms nếu gặp khóa đọc ngắn; lỗi kéo dài vẫn dừng để giữ bằng chứng cũ, không phát lại lệnh in.

Collector giữ phản hồi lỗi nguyên byte dưới dạng hex ở `feedback-errors.jsonl`, bên cạnh bằng chứng lượt. Khi một frame bị hỏng/mất dấu kết thúc, parser tìm lại frame kế tiếp để không làm mất luôn EPC hợp lệ sau đó. Không ghép EPC từ các tem lân cận và không suy ra EPC từ counter.

Dữ liệu lịch sử trên máy có các dòng `invalid_read` đã bị xóa nội dung phản hồi không hợp lệ. Vì vậy không thể kết luận chính xác nguyên nhân hoặc khôi phục EPC các dòng ấy chỉ từ CSV cũ. Sửa phần nhận/lưu giúp tránh lỗi parser xác định được và bổ sung bằng chứng cho lỗi còn xảy ra; cần nghiệm thu với firmware và vật tư thực tế để kết luận vấn đề READ_ERROR đã hết.

Theo [Zebra RFID Programming Guide](https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/guide/software/rfid3-pg-en.pdf), `^HV` trả nội dung trường RFID về host. Phản hồi host và counter máy là các loại bằng chứng khác nhau; tem có chữ EPC không đủ để phần mềm tự thay một phản hồi host bị lỗi thành EPC đã xác minh.

## Đánh giá triển khai

Kiến trúc phù hợp một host điều phối nhiều máy qua switch: Go giữ kết nối/thu RFID, UI chuẩn bị công việc và giám sát. Với 3 máy, tính đúng đắn của hàng đợi, lưu bằng chứng và xử lý lỗi quan trọng hơn việc đổi ngôn ngữ sang C#. Không có số đo chứng minh đổi sang C# tự giải quyết lỗi hiện tại.

Triển khai theo pilot trước khi dùng hết công suất: chạy riêng từng ZT610R/ZD621R, sau đó cả ba; dùng cuộn thật để đối chiếu VALID/VOID/EPC/CSV, thử pause, mở đầu in, điều chỉnh, in bù, ngắt mạng và khởi động lại. Giữ app/connector hoạt động và tắt chế độ sleep của host trong ca in. Đây chưa phải Windows service sống qua logoff.

Hồ sơ và spool nằm trong dữ liệu người dùng của app. Cần đủ dung lượng ổ đĩa và sao lưu thư mục dữ liệu theo quy trình nhà máy; không xóa bằng chứng của lượt chưa đối soát. Bộ cài không tự chạy lệnh in hoặc sửa CSV lịch sử.

Kết quả kiểm thử và hạn chế nghiệm thu được ghi riêng trong báo cáo QA của bản phát hành.
