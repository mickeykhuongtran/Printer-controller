# ZbrePrinter App 3.1.0

- Windows RAW chuẩn bị toàn bộ batch 1–2.500 nhãn theo thứ tự trên đĩa trước khi gửi máy.
- Một batch tạo một Windows print job; connector ghi buffer 512 KiB tuần tự và xử lý short writes.
- Local Print Connector 0.5.0 bổ sung durable staging, checkpoint chống lặp, lưu job ID, truy vấn Windows queue và phục hồi kết quả uncertain sau restart.
- Print hiển thị riêng tiến độ chuẩn bị và trạng thái spooler; có bảng xử lý batch còn dang dở.
- Desktop yêu cầu capability durable RAW spool batch, và quit guard tính cả batch staging/queued/spooling/uncertain.
- Giữ renderer template hiện tại; bổ sung kiểm tra EPC HEX trước khi commit batch Windows.
- Yêu cầu Windows queue bật spool và Start printing after last page is spooled, không bật printer pooling. Không tự thay đổi cấu hình printer.

Đây không phải xác nhận hoàn tất vật lý từ spooler; cần nghiệm thu thứ tự, số lượng và EPC trên printer thật. TCP/COM giữ cơ chế hiện có.

## Mốc source và bộ cài

- Source thiết kế template, web và connector: repo `../ZbrePrinter`, commit `e1f9b37161a87be48cbf77be779b6a8af2bf16d1`.
- Bộ cài đã kiểm thử: `ZbrePrinter-App-Setup-3.1.0-x64.exe`.
- SHA-256: `2129c4e6a7873a87a3dc0152ce62db496422bda304fdc6069f84dabbce0c56d5`.
- Kết quả kiểm thử và điều kiện vận hành: [Windows spool batch](../docs/WINDOWS-SPOOL-BATCH.md).
