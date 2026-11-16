# Windows RAW batch — phiên bản 3.1.0

Áp dụng cho danh sách DataFeed 1–2.500 tag, bao gồm EPC HEX, qua Windows RAW/USB.

## Luồng xử lý

1. Chốt template, cấu hình và thứ tự dòng tại lúc nhận batch.
2. Connector tạo batch ID và giữ thứ tự nhận cho queue đã chọn.
3. App render từng chunk theo template hiện tại; connector lưu dữ liệu và checkpoint trên đĩa. Chưa tạo Windows print job trong giai đoạn này.
4. Commit chỉ sau khi nhận đủ số dòng, chunk và byte đã khai báo. Connector sở hữu thao tác spool độc lập với HTTP.
5. Tạo một Windows RAW document cho toàn batch, ghi tuần tự buffer 512 KiB, xử lý short write đến khi đủ byte rồi EndDocPrinter.
6. Lưu Windows job ID và hiển thị trạng thái. “Accepted by Windows” không phải xác nhận số nhãn đã in vật lý.

Ví dụ 2.500 dòng có thể được chuẩn bị bằng hàng trăm chunk nhưng chỉ tạo **một Windows job ID**. Không thêm delay cố định giữa chunk; driver/spooler cung cấp backpressure. Buffer 512 KiB giới hạn bộ nhớ của vòng ghi, không phải thông số dung lượng buffer của printer.

## Cấu hình Windows cần có

Trong Printer properties → Advanced của đúng queue Zebra:

- bật **Spool print documents so program finishes printing faster**;
- chọn **Start printing after last page is spooled**;
- không chọn **Print directly to the printer**;
- trong Ports, không bật printer pooling cho queue cần giữ đúng một máy.

Chỉ dùng một đường gửi cho máy khi thứ tự là yêu cầu sản xuất; không đồng thời gửi trực tiếp TCP/COM hoặc qua queue khác đến cùng printer. App kiểm tra cấu hình queue và trả lỗi hướng dẫn; không tự thay đổi thiết lập Windows.

## Trạng thái và thao tác của operator

| Trạng thái | Ý nghĩa |
| --- | --- |
| Preparing labels | Payload đang được lưu; chưa gửi spooler |
| Waiting to submit | Payload hoàn chỉnh đang đợi thứ tự |
| Submitting to Windows | Worker đang ghi cùng một document vào spooler |
| Accepted by Windows | Windows đã nhận hết document; có job ID |
| Submission failed | Có lỗi được xác định trước khi gửi dữ liệu hoặc commit không hoàn tất |
| Needs reconciliation | Kết quả chưa rõ; không tự gửi lại và giữ luồng chờ đối soát |
| Closed without reprinting | Batch đã được hủy hoặc operator đóng sau đối soát; không đánh dấu là đã in đủ |

Trong bảng **Windows print batches**, dùng Check status để đọc trạng thái Windows. Discard unsent batch hủy staging/queued hoặc đóng batch failed chưa gửi. Với batch phục hồi đã chuẩn bị đủ nhưng chưa gửi, Submit saved batch là thao tác chủ động giao file đã lưu cho spooler. Với kết quả uncertain, kiểm tra nhãn thực tế và giải quyết job cũ trong Windows/printer trước khi xác nhận Close without reprinting. Không suy ra nhãn đã in từ số byte hoặc chunk đã ghi.

## Phục hồi và lưu trữ

Manifest/payload được lưu trong `raw-spool-batches` cạnh file paired-origins.json của connector. Desktop mặc định dùng `%APPDATA%\ZbrePrinter\connector`. Thư mục này là dữ liệu vận hành, không thuộc installer hoặc source Git.

- Append cùng batch ID + sequence + payload được nhận lại mà không nhân đôi dữ liệu.
- Commit cùng ID không tạo thêm Windows print job.
- Batch đang spooling khi restart chuyển thành uncertain; không tự in lại.
- Batch chưa gửi được giữ lại để operator xử lý; không âm thầm bỏ qua để batch sau vượt trước.
- Client mất response vẫn truy vấn cùng batch ID. Không tự biến timeout thành một batch mới.

Giới hạn lưu trữ: tối đa 1 GiB cho một batch, 2 GiB payload đang chờ (có thể cần gấp đôi dung lượng đĩa lúc ghép file), 64 batch chưa xử lý xong và 1.000 bản ghi chi tiết chưa archive. **Archive history** ẩn lịch sử đã kết thúc nhưng vẫn giữ ID để ngăn in lại cùng batch. Không xóa thư mục trạng thái để bỏ qua batch uncertain.

Nếu mất kết nối ngay lúc bắt đầu và chỉ còn yêu cầu cục bộ, **Verify and discard local request** kiểm tra lại connector; chỉ xóa yêu cầu cục bộ khi connector đang hoạt động và xác nhận batch không tồn tại. Lỗi mạng không được coi là xác nhận chưa gửi.

Thứ tự dòng trong từng batch được giữ nguyên. Thứ tự giữa các batch theo lúc connector tiếp nhận `begin`; các client gửi HTTP đồng thời phải tự định nghĩa thứ tự nghiệp vụ. Với native integration API, dùng lại `batchId`/`Idempotency-Key` khi retry; browser-listener API cần truy vấn job ID đã nhận thay vì POST lại để tạo yêu cầu mới.

Windows có thể tiếp tục job đã spool sau khi app đóng. Quit guard giữ app mở khi vẫn chuẩn bị/submit hoặc có trạng thái chưa rõ; force exit có thể làm batch cần phục hồi.

## Nghiệm thu phần cứng

Kiểm tra các lô 1, 1.000 và 2.500 dòng có số thứ tự và EPC HEX tương ứng, bao gồm mã có số 0 đầu. Xác nhận chỉ một Windows job cho một batch và thứ tự nhãn không bị đảo tại ranh giới chunk. Thử lỗi dữ liệu ở dòng cuối để xác nhận không tạo job; thử hết giấy, pause/resume, rút USB và restart để kiểm tra trạng thái và không tạo bản in trùng tự động.

Các test phần mềm dùng spooler giả không thay thế kiểm tra trên ZT610R/ZD621R thật. Đọc Windows status hoặc thấy job biến mất khỏi queue không tự chứng minh toàn bộ tag đã encode/in thành công.

## Kiểm chứng phần mềm ngày 13/09/2026

- Go: 57 test cấp cao nhất đạt, gồm FIFO, restart, mất HTTP response, checkpoint, short write, trạng thái uncertain và archive; `go vet` đạt.
- Desktop: 10 test đạt; TypeScript, lint các file thay đổi, build và kiểm tra bundle đạt.
- Giao diện đóng gói: 2.500 mã HEX được chuẩn bị thành 250 chunk, 1.440.300 byte, tạo đúng một Windows job giả; đối chiếu toàn bộ mã và thứ tự, bao gồm số 0 đầu.
- Kiểm tra giao diện sáng/tối và đóng batch lỗi đã archive nhưng còn pending trong trình duyệt đạt; thao tác phục hồi không tạo job mới.
- Connector 0.5.0 chạy thực tế trên Windows với thư mục trạng thái riêng, health/capability và kiểm tra quyền truy cập đạt. Không gửi lệnh đến phần cứng.
