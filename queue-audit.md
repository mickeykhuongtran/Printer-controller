# Kiểm toán đồng bộ text/ảnh – EPC và hàng đợi

Ngày: 2026-09-13. Bản được kiểm tra: **3.1.4**, source web
`4d1649ec606020de696822e10e0cdd4e1badc002`, connector **0.5.2**.

Tiêu chí ưu tiên: **đúng cặp nội dung–EPC, đúng thứ tự, không tự in lại khi
chưa biết kết quả**. Tốc độ chỉ được tối ưu khi giữ được các tiêu chí này.

## Phản ánh cần kiểm chứng

Người vận hành từng gặp trên đường USB/Windows ở bản 3.0.0: đang tới 1337,
text nhảy sang 1441–1500 rồi trở về 1338, trong khi EPC tiếp tục tuần tự.
Chưa có file spool/ZPL của lần lỗi đó hoặc template gốc trong bằng chứng
được kiểm tra, nên chưa thể xác nhận nguyên nhân lịch sử. Đảo thứ tự cả khối
ZPL sẽ đảo cả nội dung và EPC cùng khối; chỉ thấy text nhảy là lý do phải
kiểm tra cả việc ghép dữ liệu, không chỉ kiểm tra thứ tự job.

## Những gì đã xác nhận trong mã hiện tại

- Windows RAW chụp bản sao template/dữ liệu trước khi vào hàng đợi. Mỗi nhãn
  dùng cùng chỉ số dòng cho ảnh, text và EPC; renderer tạo canvas mới cho
  mỗi nhãn và hoàn tất nhãn đó trước khi dựng nhãn tiếp theo.
- Trong đường ghi EPC từ DataFeed được kiểm tra, mỗi nhãn chứa một lệnh
  ghi EPC, một ảnh GFA của toàn nhãn và PQ1 trong cùng khối XA/XZ. Các
  nhãn động không tái sử dụng tên ảnh/format đã lưu trong máy in.
- Windows RAW chuẩn bị và lưu các chunk trước, ghép theo sequence rồi
  commit **một Windows job cho toàn bộ dải**. Không tạo một Windows job
  mới cho từng chunk như đường RAW ở nhánh mã trước 3.1.0.
- Connector giữ chỗ FIFO từ lúc begin, trước khi upload hoàn tất. Job
  tới sau không vượt job tới trước chỉ vì dựng ảnh nhanh hơn. Checkpoint,
  xử lý phản hồi bị mất và trạng thái cần đối soát ngăn gửi lại mù quáng.
- Connector kiểm tra queue phải spool đầy đủ và dùng một port; lỗi giữa
  chừng không được kết thúc một tài liệu RAW bị cắt cụt như thể thành công.
- Cơ chế dựng trước/gửi tiếp của 3.1.4 áp dụng cho TCP. Windows RAW vẫn
  chuẩn bị đủ toàn bộ batch trước khi commit vào spooler.

## Bằng chứng kiểm thử

Chạy trên renderer từ thư mục `dist/win-unpacked/resources/web`, với
connector giả riêng trên loopback. Các địa chỉ in thật bị chặn.

| Ca kiểm thử | Nội dung kiểm tra |
| --- | --- |
| Windows, 1 → 2500 | 2.500 cặp text/bitmap–EPC, 250 chunk, một job |
| Windows, 2350 → 1750 | 601 cặp giảm dần, 61 chunk, một job; ZPL export cùng thứ tự |
| TCP, 2500 → 2450 | 51 cặp; Pause giữa job và ở chunk cuối |
| TCP, 2449 → 2000 | 450 cặp; gửi tiếp khi buffer còn dữ liệu, Pause/Resume, không trùng |
| Cố tình gây sai | Thay riêng ảnh của dòng 1337 bằng ảnh dòng 1441, giữ EPC 1337; bộ kiểm tra phải phát hiện sai |

Bộ kiểm tra quan sát text thực sự được vẽ lên canvas, gồm số dòng và EPC,
ghi lại bitmap của canvas đó, rồi giải nén Z64 trong ZPL và so sánh byte
ảnh với đúng dòng/EPC trong cùng khối. Không chỉ đếm EPC hoặc so sánh
sequence. Nó không thay đổi dữ liệu/lệnh in của sản phẩm; instrumentation
chỉ được nạp trong cửa sổ Electron kiểm thử.

Go tests kiểm tra riêng FIFO, batch bất biến 2.500 dòng, một lần tạo job,
phản hồi mất/lặp, ghi từng phần, ghi 0 byte, spool thất bại, restart khi đang
spool, file staging bị thay đổi, và yêu cầu đối soát trước khi giải phóng queue.

Lệnh chạy lại: `npm run test:spool-ui`, `npm run test:spool-reverse-ui`,
`npm run test:tcp-pause-ui`. Kết quả nằm trong các thư mục
`build/spool-qa`, `build/spool-reverse-qa`, `build/tcp-pause-qa`.

## Giới hạn và điều kiện nghiệm thu

Các kết quả trên xác nhận dữ liệu được ứng dụng dựng/gửi và logic connector
trong mô phỏng; chưa xác nhận từng EPC được ghi trên tag thật, hành vi driver
USB, firmware, retry/VOID hoặc mọi mẫu dùng RFID Read. Cần kiểm tra bằng
template, cuộn tag, driver và máy ZD621R thực tế trước khi chốt sản xuất.

Khi nghiệm thu, giữ thứ tự tag, quét text/barcode và đọc EPC trên **cùng tag**,
đối chiếu toàn bộ dải với dữ liệu gốc; bao gồm 1337/1338/1441–1500, ranh giới
chunk, Pause/Resume và một tình huống gián đoạn được kiểm soát. Điều kiện đạt:
không sai cặp, không nhảy dòng, không thiếu/trùng không giải thích được;
tag VOID phải được ghi nhận riêng. Sai một cặp cũng là không đạt.

FIFO hiện được quản lý theo endpoint/tên queue, không phải khóa độc quyền
mọi cổng của một máy vật lý. Chưa thể khẳng định thứ tự nếu đồng thời có
ứng dụng khác hoặc cả đường TCP và USB cùng gửi tới máy đó. Lịch sử TCP
trong bộ nhớ cũng không phải nhật ký EPC vật lý bền vững qua restart.

Tham chiếu: [Microsoft về vòng đời một RAW print job](https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer)
mô tả StartDoc/Write/EndDoc. [Zebra RFID Programming Guide](https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/guide/software/rfid3-pg-en.pdf)
mô tả retry, VOID và chính sách lỗi RFID; việc spool đủ byte không thay thế
việc kiểm tra EPC vật lý.
