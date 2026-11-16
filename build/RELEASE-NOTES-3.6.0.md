# ZbrePrinter 3.6.0

Desktop/web 3.6.0, connector 0.10.0. Đóng cuộn và bắt đầu lô mới độc lập với xuất CSV.

## Chuyển lô

- Khi mở màn hình in, hồ sơ cuộn cũ được hiển thị với thời gian, template và máy in. Người vận hành chọn tiếp tục cuộn cũ hoặc đóng cuộn để bắt đầu lô mới.
- Đóng cuộn không yêu cầu xuất CSV hoặc điền Job ID/người vận hành. Không gửi lệnh in, reset counter hoặc điều khiển máy in khi đóng hồ sơ.
- Lần in tiếp theo có bật lưu dữ liệu tạo hồ sơ cuộn riêng. Lô cũ giữ nguyên dữ liệu RFID gốc và các lần in; không bị xóa hoặc ghép vào lô mới.
- Không đóng cuộn khi còn phiên in đang hoạt động. Trạng thái mất kết nối, lỗi máy hoặc số đếm chưa xác minh vẫn được giữ; đóng hồ sơ không tự xác nhận buffer máy đã rỗng hoặc chất lượng tem.

## Xuất và lưu lịch sử

- Cuộn đã đóng vẫn có thể xem và xuất CSV từ lịch sử. Thông tin người vận hành, Job ID và thứ tự cuộn được nhập khi xuất lần đầu.
- CSV đã xuất được lưu nguyên bản; tải lại giữ tên và byte dữ liệu. Các báo cáo đã xuất bằng phiên bản cũ được giữ lại.
- Job ID nghiệp vụ không dùng làm khóa chặn chuyển lô; mỗi cuộn có mã nội bộ riêng.
- Nâng cấp tiếp tục dùng thư mục dữ liệu hiện có. Không xóa lịch sử và không tự đóng hồ sơ chỉ vì hồ sơ đã cũ hoặc counter máy đã reset.

## Thông báo lỗi

Lệnh bị từ chối trước khi gửi do hồ sơ cuộn chưa đóng được phân loại là `not_sent`, với hướng dẫn tiếp tục hoặc đóng cuộn. Không còn báo kết quả không xác định cho nhánh từ chối này. Các lỗi thực sự có thể đã gửi dữ liệu vẫn giữ cảnh báo đối soát.

## Kiểm thử và bộ cài

Đã kiểm thử thành công:

- Bộ kiểm thử Go gồm 140 test cấp cao nhất cùng các subtest; `go vet` đạt.
- TypeScript và ESLint cho các thành phần giao diện thay đổi đạt.
- 13 test desktop; 23 test TCP streaming/cancel/drain; các test client TCP, vòng đời cuộn, RFID capture, ZPL RFID, phạm vi dòng và chia lô đạt.
- Kiểm thử giao diện trên bản đóng gói 3.6.0 với connector 0.10.0 và máy in TCP mô phỏng: 2.518 lượt tem, 5 lần tải CSV chủ động, 0 lần reset counter.
- Cuộn cũ được giả lập từ một tuần trước: phát hiện khi tắt lưu dữ liệu, yêu cầu chọn tiếp tục rõ ràng, đóng không phát lệnh máy in và không xuất CSV. Lô mới bắt đầu trước khi xuất CSV cũ, kể cả dùng lại Job ID nghiệp vụ.
- Dữ liệu RFID cũ giữ nguyên SHA-256; lịch sử cuộn đã đóng còn sau tải lại; xuất CSV sau khi đóng và tải lại giữ nguyên byte. Thay đổi số tem loại chưa lưu ngăn đóng cuộn.
- Cuộn bị đóng từ phiên khác được báo “Chưa gửi lệnh in”; không báo kết quả không xác định khi chưa truyền dữ liệu.
- Kiểm tra bundle và runtime đóng gói đạt. Bộ cài được tạo từ đúng thư mục đóng gói đã vượt qua kiểm thử giao diện.

Kết quả chi tiết: `build/production-roll-qa/run-qUKulA/result.json`. Ảnh đối chứng trong cùng thư mục: `old-roll-capture-off.png`, `closed-without-export.png`, `stale-selection-not-sent.png`, `export-ready.png`, `write-export-ready.png`, `fault-reconciled.png`.

Chưa kiểm thử trên máy in vật lý. Các lần in kiểm thử dùng máy mô phỏng và thư mục dữ liệu riêng; không tác động lịch sử đang dùng của người vận hành. Đây là bộ cài thử chưa có chữ ký số.

Bộ cài Windows x64: `ZbrePrinter-App-Setup-3.6.0-x64.exe` — 137.383.067 byte.

SHA-256 bộ cài:

```text
bfe325667eed60585b8ab99b68be8d87605778515bebe35e79afdc8d42d61392
```

SHA-256 connector Windows x64 đã kiểm thử và đóng gói:

```text
35f6b7bc656348d093f51204b8210331e57638c010acbd3ec580f7974a2ff5ed
```

Để kiểm tra: thoát ứng dụng đang chạy, cài nâng cấp 3.6.0, mở màn hình in và chọn “Đóng cuộn / bắt đầu lô mới” cho cuộn cũ. Khi bật lưu dữ liệu, lần in tiếp theo tạo cuộn mới. CSV cũ có thể xuất sau trong “Lịch sử cuộn / xuất CSV”.
